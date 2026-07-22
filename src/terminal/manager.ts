import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { PtyAdapter, PtyProcess } from "./pty-adapter.ts";
import type { TerminalServerMessage, TerminalStatus } from "./wire.ts";

export const TERMINAL_ID_RE = /^term-[1-9][0-9]{0,3}$/;
export const TERMINAL_THREAD_ID_RE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|project_[a-z0-9][a-z0-9._-]{0,80})$/i;

interface TerminalSession {
  threadId: string;
  terminalId: string;
  cwd: string;
  cols: number;
  rows: number;
  history: string;
  pendingHistoryControlSequence: string;
  status: TerminalStatus;
  process: PtyProcess | null;
  unsubscribeData: (() => void) | null;
  unsubscribeExit: (() => void) | null;
  persistTimer: NodeJS.Timeout | null;
  exitedAt: number | null;
  eventSequence: number;
  deferredEvents: TerminalServerMessage[] | null;
}

type Subscriber = (event: TerminalServerMessage) => void;
type SequencedSubscriber = (event: TerminalServerMessage, sequence: number) => void;

export interface TerminalManagerOptions {
  adapter: PtyAdapter;
  historyDir: string;
  historyLineLimit?: number;
  persistDebounceMs?: number;
  killGraceMs?: number;
  maxRetainedExited?: number;
  env?: NodeJS.ProcessEnv;
}

export interface TerminalAttachInput {
  threadId: string;
  terminalId: string;
  cwd: string;
  cols?: number;
  rows?: number;
}

function capHistory(history: string, maxLines: number): string {
  if (history.length === 0) return history;
  const trailingNewline = history.endsWith("\n");
  const lines = history.split("\n");
  if (trailingNewline) lines.pop();
  if (lines.length <= maxLines) return history;
  const capped = lines.slice(-maxLines).join("\n");
  return trailingNewline ? `${capped}\n` : capped;
}

function isCsiFinalByte(codePoint: number): boolean {
  return codePoint >= 0x40 && codePoint <= 0x7e;
}

function shouldStripCsiSequence(body: string, finalByte: string): boolean {
  if (finalByte === "n") return true;
  if (finalByte === "R" && /^[0-9;?]*$/.test(body)) return true;
  return finalByte === "c" && /^[>0-9;?]*$/.test(body);
}

function shouldStripOscSequence(content: string): boolean {
  return /^(?:10|11|12);(?:\?|rgb:)/.test(content) || /^52;/.test(content);
}

function stripStringTerminator(value: string): string {
  if (value.endsWith("\u001b\\")) return value.slice(0, -2);
  const last = value.at(-1);
  return last === "\u0007" || last === "\u009c" ? value.slice(0, -1) : value;
}

function findStringTerminatorIndex(input: string, start: number): number | null {
  for (let index = start; index < input.length; index += 1) {
    const codePoint = input.charCodeAt(index);
    if (codePoint === 0x07 || codePoint === 0x9c) return index + 1;
    if (codePoint === 0x1b && input.charCodeAt(index + 1) === 0x5c) return index + 2;
  }
  return null;
}

function isEscapeIntermediateByte(codePoint: number): boolean {
  return codePoint >= 0x20 && codePoint <= 0x2f;
}

function isEscapeFinalByte(codePoint: number): boolean {
  return codePoint >= 0x30 && codePoint <= 0x7e;
}

function findEscapeSequenceEndIndex(input: string, start: number): number | null {
  let cursor = start;
  while (cursor < input.length && isEscapeIntermediateByte(input.charCodeAt(cursor))) cursor += 1;
  if (cursor >= input.length) return null;
  return isEscapeFinalByte(input.charCodeAt(cursor)) ? cursor + 1 : start + 1;
}

function sanitizeHistoryChunk(
  pendingControlSequence: string,
  data: string,
): { visibleText: string; pendingControlSequence: string } {
  const input = `${pendingControlSequence}${data}`;
  let visibleText = "";
  let index = 0;

  while (index < input.length) {
    const codePoint = input.charCodeAt(index);
    if (codePoint === 0x1b) {
      const nextCodePoint = input.charCodeAt(index + 1);
      if (Number.isNaN(nextCodePoint)) return { visibleText, pendingControlSequence: input.slice(index) };
      if (nextCodePoint === 0x5b) {
        let cursor = index + 2;
        while (cursor < input.length && !isCsiFinalByte(input.charCodeAt(cursor))) cursor += 1;
        if (cursor >= input.length) return { visibleText, pendingControlSequence: input.slice(index) };
        const body = input.slice(index + 2, cursor);
        if (!shouldStripCsiSequence(body, input[cursor] ?? "")) visibleText += input.slice(index, cursor + 1);
        index = cursor + 1;
        continue;
      }
      if (nextCodePoint === 0x5d || nextCodePoint === 0x50 || nextCodePoint === 0x5e || nextCodePoint === 0x5f) {
        const terminatorIndex = findStringTerminatorIndex(input, index + 2);
        if (terminatorIndex === null) return { visibleText, pendingControlSequence: input.slice(index) };
        const sequence = input.slice(index, terminatorIndex);
        const content = stripStringTerminator(input.slice(index + 2, terminatorIndex));
        if (nextCodePoint !== 0x5d || !shouldStripOscSequence(content)) visibleText += sequence;
        index = terminatorIndex;
        continue;
      }
      const end = findEscapeSequenceEndIndex(input, index + 1);
      if (end === null) return { visibleText, pendingControlSequence: input.slice(index) };
      visibleText += input.slice(index, end);
      index = end;
      continue;
    }
    if (codePoint === 0x9b) {
      let cursor = index + 1;
      while (cursor < input.length && !isCsiFinalByte(input.charCodeAt(cursor))) cursor += 1;
      if (cursor >= input.length) return { visibleText, pendingControlSequence: input.slice(index) };
      const body = input.slice(index + 1, cursor);
      if (!shouldStripCsiSequence(body, input[cursor] ?? "")) visibleText += input.slice(index, cursor + 1);
      index = cursor + 1;
      continue;
    }
    if (codePoint === 0x9d || codePoint === 0x90 || codePoint === 0x9e || codePoint === 0x9f) {
      const terminatorIndex = findStringTerminatorIndex(input, index + 1);
      if (terminatorIndex === null) return { visibleText, pendingControlSequence: input.slice(index) };
      const sequence = input.slice(index, terminatorIndex);
      const content = stripStringTerminator(input.slice(index + 1, terminatorIndex));
      if (codePoint !== 0x9d || !shouldStripOscSequence(content)) visibleText += sequence;
      index = terminatorIndex;
      continue;
    }
    visibleText += input[index] ?? "";
    index += 1;
  }
  return { visibleText, pendingControlSequence: "" };
}

function keyOf(threadId: string, terminalId: string): string {
  return `${threadId}\0${terminalId}`;
}

function terminalEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    const normalized = key.toUpperCase();
    if (normalized === "PORT" || normalized.startsWith("BOUCLE_")) continue;
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function isMissingExecutable(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

export class TerminalManager {
  private readonly adapter: PtyAdapter;
  private readonly historyLineLimit: number;
  private readonly historyDir: string;
  private readonly persistDebounceMs: number;
  private readonly killGraceMs: number;
  private readonly maxRetainedExited: number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly opening = new Map<string, Promise<TerminalSession>>();
  private readonly persistence = new Map<string, Promise<void>>();
  private readonly subscribers = new Map<string, Set<SequencedSubscriber>>();

  constructor(options: TerminalManagerOptions) {
    this.adapter = options.adapter;
    this.historyLineLimit = options.historyLineLimit ?? 5000;
    this.historyDir = options.historyDir;
    this.persistDebounceMs = options.persistDebounceMs ?? 50;
    this.killGraceMs = options.killGraceMs ?? 1000;
    this.maxRetainedExited = options.maxRetainedExited ?? 32;
    this.env = options.env ?? process.env;
  }

  snapshot(threadId: string, terminalId: string): { history: string; status: TerminalStatus; pid: number | null } | null {
    const session = this.sessions.get(keyOf(threadId, terminalId));
    return session ? {
      history: session.history,
      status: session.status,
      pid: session.process?.pid ?? null,
    } : null;
  }

  async attach(input: TerminalAttachInput, subscriber: Subscriber): Promise<() => void> {
    this.assertIds(input.threadId, input.terminalId);
    const key = keyOf(input.threadId, input.terminalId);
    const set = this.subscribers.get(key) ?? new Set<SequencedSubscriber>();
    this.subscribers.set(key, set);
    const buffered: Array<{ event: TerminalServerMessage; sequence: number }> = [];
    let live = false;
    const bridge: SequencedSubscriber = (event, sequence) => {
      if (!live) buffered.push({ event, sequence });
      else subscriber(event);
    };
    set.add(bridge);

    try {
      const session = await this.ensureSession(input);
      const snapshotSequence = session.eventSequence;
      subscriber({ type: "snapshot", ...this.snapshot(input.threadId, input.terminalId)! });
      for (const bufferedEvent of buffered) {
        if (bufferedEvent.sequence > snapshotSequence) subscriber(bufferedEvent.event);
      }
      live = true;
    } catch (error) {
      set.delete(bridge);
      if (set.size === 0) this.subscribers.delete(key);
      throw error;
    }

    return () => {
      set.delete(bridge);
      if (set.size === 0) this.subscribers.delete(key);
    };
  }

  async dispose(): Promise<void> {
    await Promise.allSettled(this.opening.values());
    const sessions = [...this.sessions.values()];
    this.subscribers.clear();
    await Promise.all(sessions.map(async (session) => {
      await this.terminate(session);
      await this.persistNow(session);
      session.unsubscribeData?.();
      session.unsubscribeExit?.();
    }));
    this.sessions.clear();
  }

  async close(threadId: string, terminalId: string): Promise<void> {
    this.assertIds(threadId, terminalId);
    const key = keyOf(threadId, terminalId);
    const session = this.sessions.get(key);
    if (!session) return;
    this.sessions.delete(key);
    this.subscribers.delete(key);
    session.unsubscribeData?.();
    session.unsubscribeData = null;
    if (session.persistTimer) {
      clearTimeout(session.persistTimer);
      session.persistTimer = null;
    }
    await this.serializePersistence(key, () => rm(this.historyPath(threadId, terminalId), { force: true }));
    const process = session.process;
    if (!process) {
      session.unsubscribeExit?.();
      return;
    }
    process.kill("SIGTERM");
    const timer = setTimeout(() => {
      if (session.process === process) process.kill("SIGKILL");
      session.unsubscribeExit?.();
      session.unsubscribeExit = null;
      session.process = null;
    }, this.killGraceMs);
    timer.unref();
  }

  async restart(threadId: string, terminalId: string): Promise<void> {
    this.assertIds(threadId, terminalId);
    const key = keyOf(threadId, terminalId);
    const session = this.sessions.get(key);
    if (!session) throw new Error("Terminal session not found");
    if (session.process) throw new Error("Terminal session is still running");
    session.unsubscribeData?.();
    session.unsubscribeExit?.();
    const restarted = this.open({
      threadId,
      terminalId,
      cwd: session.cwd,
      cols: session.cols,
      rows: session.rows,
    }, true);
    if (session.persistTimer) clearTimeout(session.persistTimer);
    session.persistTimer = null;
    const deferredEvents = restarted.deferredEvents ?? [];
    restarted.deferredEvents = null;
    this.publish(restarted, { type: "restarted" });
    for (const event of deferredEvents) this.publish(restarted, event);
    await this.persistNow(restarted);
  }

  write(threadId: string, terminalId: string, data: string): void {
    this.runningProcess(threadId, terminalId).write(data);
  }

  resize(threadId: string, terminalId: string, cols: number, rows: number): void {
    if (!Number.isInteger(cols) || cols < 1 || cols > 1000 || !Number.isInteger(rows) || rows < 1 || rows > 500) {
      throw new Error("Invalid terminal dimensions");
    }
    const session = this.runningSession(threadId, terminalId);
    session.process!.resize(cols, rows);
    session.cols = cols;
    session.rows = rows;
  }

  private open(input: TerminalAttachInput, deferEvents = false): TerminalSession {
    const env = terminalEnv(this.env);
    const shells = [...new Set([this.env.SHELL, "/bin/zsh", "/bin/bash", "/bin/sh"].filter((shell): shell is string => !!shell))];
    let process: PtyProcess | null = null;
    let lastError: unknown;
    for (const shell of shells) {
      try {
        process = this.adapter.spawn({
          shell,
          cwd: input.cwd,
          cols: input.cols ?? 80,
          rows: input.rows ?? 24,
          env,
        });
        break;
      } catch (error) {
        lastError = error;
        if (!isMissingExecutable(error)) throw error;
      }
    }
    if (!process) throw lastError ?? new Error("No terminal shell is available");
    const session: TerminalSession = {
      threadId: input.threadId,
      terminalId: input.terminalId,
      cwd: input.cwd,
      cols: input.cols ?? 80,
      rows: input.rows ?? 24,
      history: "",
      pendingHistoryControlSequence: "",
      status: "running",
      process,
      unsubscribeData: null,
      unsubscribeExit: null,
      persistTimer: null,
      exitedAt: null,
      eventSequence: 0,
      deferredEvents: deferEvents ? [] : null,
    };
    this.sessions.set(keyOf(input.threadId, input.terminalId), session);
    session.unsubscribeData = process.onData((data) => {
      const sanitized = sanitizeHistoryChunk(session.pendingHistoryControlSequence, data);
      session.pendingHistoryControlSequence = sanitized.pendingControlSequence;
      if (sanitized.visibleText) {
        session.history = capHistory(`${session.history}${sanitized.visibleText}`, this.historyLineLimit);
        this.queuePersist(session);
      }
      this.publish(session, { type: "output", data });
    });
    session.unsubscribeExit = process.onExit((event) => {
      session.unsubscribeData?.();
      session.unsubscribeData = null;
      session.status = "exited";
      session.process = null;
      session.exitedAt = Date.now();
      this.publish(session, { type: "exited", code: event.exitCode });
      this.pruneExitedSessions();
    });
    return session;
  }

  private async restoreOrOpen(input: TerminalAttachInput): Promise<TerminalSession> {
    try {
      const history = capHistory(
        await readFile(this.historyPath(input.threadId, input.terminalId), "utf8"),
        this.historyLineLimit,
      );
      const session: TerminalSession = {
        threadId: input.threadId,
        terminalId: input.terminalId,
        cwd: input.cwd,
        cols: input.cols ?? 80,
        rows: input.rows ?? 24,
        history,
        pendingHistoryControlSequence: "",
        status: "exited",
        process: null,
        unsubscribeData: null,
        unsubscribeExit: null,
        persistTimer: null,
        exitedAt: Date.now(),
        eventSequence: 0,
        deferredEvents: null,
      };
      this.sessions.set(keyOf(input.threadId, input.terminalId), session);
      this.pruneExitedSessions();
      return session;
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
      const session = this.open(input);
      await this.persistNow(session);
      return session;
    }
  }

  private ensureSession(input: TerminalAttachInput): Promise<TerminalSession> {
    const key = keyOf(input.threadId, input.terminalId);
    const session = this.sessions.get(key);
    if (session) return Promise.resolve(session);
    const pending = this.opening.get(key);
    if (pending) return pending;
    const opening = this.restoreOrOpen(input).finally(() => {
      if (this.opening.get(key) === opening) this.opening.delete(key);
    });
    this.opening.set(key, opening);
    return opening;
  }

  private publish(session: TerminalSession, event: TerminalServerMessage): void {
    if (session.deferredEvents) {
      session.deferredEvents.push(event);
      return;
    }
    session.eventSequence += 1;
    for (const subscriber of this.subscribers.get(keyOf(session.threadId, session.terminalId)) ?? []) {
      subscriber(event, session.eventSequence);
    }
  }

  private assertIds(threadId: string, terminalId: string): void {
    if (!TERMINAL_THREAD_ID_RE.test(threadId)) throw new Error("Invalid terminal thread id");
    if (!TERMINAL_ID_RE.test(terminalId)) throw new Error("Invalid terminal id");
  }

  private runningProcess(threadId: string, terminalId: string): PtyProcess {
    return this.runningSession(threadId, terminalId).process!;
  }

  private runningSession(threadId: string, terminalId: string): TerminalSession {
    this.assertIds(threadId, terminalId);
    const session = this.sessions.get(keyOf(threadId, terminalId));
    if (!session?.process) throw new Error("Terminal session is not running");
    return session;
  }

  private queuePersist(session: TerminalSession): void {
    if (session.persistTimer) clearTimeout(session.persistTimer);
    session.persistTimer = setTimeout(() => {
      session.persistTimer = null;
      void this.persistNow(session)
        .catch((error) => process.stderr.write(`[boucle] failed to persist terminal history: ${String(error)}\n`));
    }, this.persistDebounceMs);
    session.persistTimer.unref();
  }

  private async persistNow(session: TerminalSession): Promise<void> {
    if (session.persistTimer) {
      clearTimeout(session.persistTimer);
      session.persistTimer = null;
    }
    const history = session.history;
    const key = keyOf(session.threadId, session.terminalId);
    await this.serializePersistence(key, async () => {
      await mkdir(this.historyDir, { recursive: true });
      await writeFile(this.historyPath(session.threadId, session.terminalId), history, "utf8");
    });
  }

  private historyPath(threadId: string, terminalId: string): string {
    return join(this.historyDir, `${threadId}_${terminalId}.log`);
  }

  private serializePersistence(key: string, operation: () => Promise<unknown>): Promise<void> {
    const previous = this.persistence.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation).then(() => {});
    this.persistence.set(key, next);
    void next.then(
      () => { if (this.persistence.get(key) === next) this.persistence.delete(key); },
      () => { if (this.persistence.get(key) === next) this.persistence.delete(key); },
    );
    return next;
  }

  private terminate(session: TerminalSession): Promise<void> {
    const process = session.process;
    if (!process) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      let unsubscribe = () => {};
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        session.process = null;
        resolve();
      };
      const timer = setTimeout(() => {
        if (session.process === process) {
          try { process.kill("SIGKILL"); } catch { /* process already exited */ }
        }
        finish();
      }, this.killGraceMs);
      unsubscribe = process.onExit(finish);
      try { process.kill("SIGTERM"); } catch { finish(); }
    });
  }

  private pruneExitedSessions(): void {
    const exited = [...this.sessions.entries()]
      .filter(([, session]) => session.status === "exited")
      .sort(([, left], [, right]) => (left.exitedAt ?? 0) - (right.exitedAt ?? 0));
    for (const [key, session] of exited.slice(0, Math.max(0, exited.length - this.maxRetainedExited))) {
      session.unsubscribeData?.();
      session.unsubscribeExit?.();
      if (session.persistTimer) clearTimeout(session.persistTimer);
      this.sessions.delete(key);
    }
  }
}
