import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import {
  appendNativeEvent,
  runtimeEventSchema,
  type LiveSession,
  type RequestOutcome,
  type RuntimeEvent,
  type ThreadAdapter,
} from "./events.ts";

type JsonRpcId = number | string;
type JsonObject = Record<string, unknown>;
type NotificationHandler = (params: unknown) => void;
type RequestHandler = (params: unknown) => Promise<unknown> | unknown;
const RECOVERABLE_RESUME_ERRORS = ["not found", "missing thread", "no such thread", "unknown thread", "does not exist"];

function record(value: unknown): JsonObject {
  return value !== null && typeof value === "object" ? value as JsonObject : {};
}

export function isRecoverableCodexResumeError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return message.includes("thread") && RECOVERABLE_RESUME_ERRORS.some((snippet) => message.includes(snippet));
}

export function codexRuntimeConfig(permissionMode: "acceptEdits" | "bypassPermissions") {
  return permissionMode === "bypassPermissions"
    ? { approvalPolicy: "never" as const, sandbox: "danger-full-access" as const, sandboxPolicy: { type: "dangerFullAccess" as const } }
    : { approvalPolicy: "on-request" as const, sandbox: "workspace-write" as const, sandboxPolicy: { type: "workspaceWrite" as const } };
}

function terminateChild(child: ChildProcessWithoutNullStreams): void {
  if (child.killed || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const forceKill = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 2_000);
  forceKill.unref();
  child.once("exit", () => clearTimeout(forceKill));
}

/** Minimal newline-delimited app-server peer: requests are id-matched and server requests may park. */
export class CodexJsonRpcClient {
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly onMessage?: (message: unknown) => void;
  private nextId = 1;
  private remainder = "";
  private closed = false;
  private readonly pending = new Map<JsonRpcId, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly notifications = new Map<string, Set<NotificationHandler>>();
  private readonly requests = new Map<string, RequestHandler>();

  constructor(
    input: Readable,
    output: Writable,
    onMessage?: (message: unknown) => void,
  ) {
    this.input = input;
    this.output = output;
    this.onMessage = onMessage;
    input.on("data", (chunk: Buffer | string) => this.receive(typeof chunk === "string" ? chunk : chunk.toString("utf8")));
    input.on("end", () => this.close(new Error("Codex app-server stdout closed")));
    input.on("error", (error) => this.close(error));
    output.on("error", (error) => this.close(error));
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Codex app-server client is closed"));
    const id = this.nextId++;
    this.write({ id, method, ...(params === undefined ? {} : { params }) });
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  notify(method: string, params?: unknown): void {
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  onNotification(method: string, handler: NotificationHandler): void {
    const handlers = this.notifications.get(method) ?? new Set();
    handlers.add(handler);
    this.notifications.set(method, handlers);
  }

  onRequest(method: string, handler: RequestHandler): void {
    this.requests.set(method, handler);
  }

  close(reason = new Error("Codex app-server client closed")): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.pending.values()) waiter.reject(reason);
    this.pending.clear();
  }

  private write(message: unknown): void {
    if (this.closed) throw new Error("Codex app-server client is closed");
    this.onMessage?.({ direction: "client", message });
    this.output.write(`${JSON.stringify(message)}\n`);
  }

  private receive(chunk: string): void {
    this.remainder += chunk;
    const lines = this.remainder.split("\n");
    this.remainder = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line) as JsonObject;
        this.onMessage?.({ direction: "server", message });
        this.dispatch(message);
      } catch {
        // A malformed diagnostic line must not corrupt framing for later messages.
      }
    }
  }

  private dispatch(message: JsonObject): void {
    const method = typeof message.method === "string" ? message.method : undefined;
    const id = typeof message.id === "number" || typeof message.id === "string" ? message.id : undefined;
    if (method && id !== undefined) {
      const handler = this.requests.get(method);
      if (!handler) {
        this.write({ id, error: { code: -32601, message: `Unhandled request: ${method}` } });
        return;
      }
      Promise.resolve(handler(message.params)).then(
        (result) => { if (!this.closed) this.write({ id, result }); },
        (error) => {
          if (!this.closed) this.write({ id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
        },
      );
      return;
    }
    if (method) {
      for (const handler of this.notifications.get(method) ?? []) handler(message.params);
      return;
    }
    if (id !== undefined) {
      const waiter = this.pending.get(id);
      if (!waiter) return;
      this.pending.delete(id);
      const error = record(message.error);
      if (message.error !== undefined) waiter.reject(new Error(typeof error.message === "string" ? error.message : "Codex request failed"));
      else waiter.resolve(message.result);
    }
  }
}

function toolSummary(item: JsonObject): string {
  switch (item.type) {
    case "commandExecution": return typeof item.command === "string" ? item.command : "Run command";
    case "fileChange": return "Apply file changes";
    case "mcpToolCall": return `${String(item.server ?? "MCP")}: ${String(item.tool ?? "tool")}`;
    case "dynamicToolCall": return String(item.tool ?? "Tool call");
    case "webSearch": return `Search: ${String(item.query ?? "")}`;
    case "imageView": return `View ${String(item.path ?? "image")}`;
    case "imageGeneration": return "Generate image";
    case "collabAgentToolCall": return String(item.tool ?? "Agent activity");
    default: return String(item.type ?? "Activity");
  }
}

/** Pure notification mapper based on Codex app-server v2 generated schemas. */
export function mapCodexNotification(method: string, params: unknown): RuntimeEvent[] {
  const payload = record(params);
  const events: RuntimeEvent[] = [];
  if (method === "thread/started") {
    const id = record(payload.thread).id;
    if (typeof id === "string") events.push({ type: "session.started", nativeSessionId: id });
  } else if (method === "turn/started") {
    const id = record(payload.turn).id;
    if (typeof id === "string") events.push({ type: "turn.started", turnId: id });
  } else if (method === "turn/completed") {
    const turn = record(payload.turn);
    const id = typeof turn.id === "string" ? turn.id : undefined;
    if (turn.status === "interrupted") events.push({ type: "turn.aborted", ...(id ? { turnId: id } : {}) });
    else {
      events.push({ type: "turn.completed", ...(id ? { turnId: id } : {}) });
      if (turn.status === "failed") {
        const error = record(turn.error);
        events.push({ type: "error", message: typeof error.message === "string" ? error.message : "Codex turn failed" });
      }
    }
  } else if (method === "item/agentMessage/delta" && typeof payload.delta === "string") {
    events.push({ type: "content.delta", text: payload.delta });
  } else if (method === "item/started" || method === "item/completed") {
    const item = record(payload.item);
    if (item.type === "agentMessage" && method === "item/completed" && typeof item.text === "string") {
      events.push({ type: "message.completed", text: item.text });
    } else if (typeof item.type === "string" && !["userMessage", "agentMessage", "reasoning", "plan"].includes(item.type)) {
      events.push({
        type: "activity",
        tone: "tool",
        kind: item.type,
        summary: toolSummary(item),
        payload: item,
        status: method === "item/started" ? "running" : String(item.status ?? "completed"),
      });
    }
  } else if (method === "item/commandExecution/outputDelta" && typeof payload.delta === "string") {
    events.push({
      type: "activity",
      tone: "tool",
      kind: "command-output",
      summary: "Command output",
      payload: { itemId: payload.itemId, delta: payload.delta },
      status: "running",
    });
  } else if (method === "thread/tokenUsage/updated") {
    const last = record(record(payload.tokenUsage).last);
    events.push({
      type: "token-usage",
      input: typeof last.inputTokens === "number" ? last.inputTokens : 0,
      output: typeof last.outputTokens === "number" ? last.outputTokens : 0,
    });
  } else if (method === "error") {
    const error = record(payload.error);
    events.push({ type: "error", message: typeof error.message === "string" ? error.message : "Codex app-server error" });
  }
  return events.map((event) => runtimeEventSchema.parse(event));
}

interface PendingApproval {
  resolve: (result: { decision: "accept" | "decline" }) => void;
}

export class CodexAdapter implements ThreadAdapter {
  readonly engine = "codex" as const;
  private readonly spawnServer: (cwd: string) => ChildProcessWithoutNullStreams;

  constructor(spawnServer?: (cwd: string) => ChildProcessWithoutNullStreams) {
    this.spawnServer = spawnServer ?? ((cwd) => spawn("codex", ["app-server"], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    }));
  }

  async start(opts: {
    threadId: string;
    cwd: string;
    resumeCursor: unknown | null;
    settings: { permissionMode: "acceptEdits" | "bypassPermissions"; model?: string };
    onEvent: (event: RuntimeEvent) => void;
  }): Promise<LiveSession> {
    const child = this.spawnServer(opts.cwd);
    let nativeThreadId: string | null = null;
    let activeTurnId: string | null = null;
    let stopped = false;
    const config = codexRuntimeConfig(opts.settings.permissionMode);
    const pending = new Map<string, PendingApproval>();
    const emit = (event: RuntimeEvent) => opts.onEvent(runtimeEventSchema.parse(event));
    const client = new CodexJsonRpcClient(child.stdout, child.stdin, (message) => {
      void appendNativeEvent(opts.threadId, message).catch(() => {});
    });

    const notifications = [
      "thread/started", "turn/started", "turn/completed", "item/started", "item/completed",
      "item/agentMessage/delta", "item/commandExecution/outputDelta", "thread/tokenUsage/updated", "error",
    ];
    for (const method of notifications) client.onNotification(method, (params) => {
      if (method === "thread/started") {
        const id = record(record(params).thread).id;
        if (typeof id === "string") nativeThreadId = id;
      } else if (method === "turn/started") {
        const id = record(record(params).turn).id;
        if (typeof id === "string") activeTurnId = id;
      } else if (method === "turn/completed") activeTurnId = null;
      for (const event of mapCodexNotification(method, params)) emit(event);
    });

    const approvalHandler = (kind: "command" | "file-change") => async (params: unknown) => {
      const payload = record(params);
      const requestId = randomUUID();
      const summary = kind === "command"
        ? (typeof payload.command === "string" ? payload.command : "Allow command?")
        : (typeof payload.reason === "string" ? payload.reason : "Allow file changes?");
      emit({ type: "request.opened", requestId, kind, summary, payload });
      return new Promise<{ decision: "accept" | "decline" }>((resolve) => pending.set(requestId, { resolve }));
    };
    client.onRequest("item/commandExecution/requestApproval", approvalHandler("command"));
    client.onRequest("item/fileChange/requestApproval", approvalHandler("file-change"));

    child.stderr.on("data", (chunk: Buffer) => {
      void appendNativeEvent(opts.threadId, { direction: "stderr", text: chunk.toString("utf8") }).catch(() => {});
    });
    child.once("error", (error) => {
      client.close(error);
      if (!stopped) emit({ type: "error", message: error.message });
    });
    child.once("exit", (code, signal) => {
      client.close(new Error(`Codex app-server exited (${code ?? signal ?? "unknown"})`));
      if (!stopped) emit({ type: "error", message: `Codex app-server exited (${code ?? signal ?? "unknown"})` });
    });

    try {
      await client.request("initialize", {
        clientInfo: { name: "boucle", title: "Boucle", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      });
      client.notify("initialized");

      const startParams = {
        cwd: opts.cwd,
        approvalPolicy: config.approvalPolicy,
        sandbox: config.sandbox,
        ...(opts.settings.model ? { model: opts.settings.model } : {}),
      };
      const cursor = record(opts.resumeCursor);
      const resumeThreadId = typeof cursor.threadId === "string" ? cursor.threadId : undefined;
      let opened: unknown;
      if (resumeThreadId) {
        try {
          opened = await client.request("thread/resume", { threadId: resumeThreadId, ...startParams });
        } catch (error) {
          if (!isRecoverableCodexResumeError(error)) throw error;
          opened = await client.request("thread/start", startParams);
        }
      } else {
        opened = await client.request("thread/start", startParams);
      }
      const openedThread = record(record(opened).thread);
      if (typeof openedThread.id !== "string") throw new Error("Codex app-server did not return a thread id");
      nativeThreadId = openedThread.id;
      emit({ type: "session.started", nativeSessionId: nativeThreadId });
    } catch (error) {
      stopped = true;
      client.close(error instanceof Error ? error : new Error(String(error)));
      terminateChild(child);
      throw error;
    }

    return {
      sendTurn: async (prompt) => {
        if (!nativeThreadId) throw new Error("Codex thread is not ready");
        if (activeTurnId) throw new Error("Codex is already running a turn");
        const response = record(await client.request("turn/start", {
          threadId: nativeThreadId,
          input: [{ type: "text", text: prompt }],
          approvalPolicy: config.approvalPolicy,
          sandboxPolicy: config.sandboxPolicy,
          ...(opts.settings.model ? { model: opts.settings.model } : {}),
        }));
        const id = record(response.turn).id;
        if (typeof id === "string") activeTurnId = id;
      },
      interrupt: async () => {
        if (!nativeThreadId || !activeTurnId) return;
        await client.request("turn/interrupt", { threadId: nativeThreadId, turnId: activeTurnId });
      },
      respond: async (requestId: string, outcome: RequestOutcome) => {
        const request = pending.get(requestId);
        if (!request) throw new Error(`Unknown Codex approval request: ${requestId}`);
        pending.delete(requestId);
        request.resolve({ decision: outcome === "approve" ? "accept" : "decline" });
        emit({ type: "request.resolved", requestId, outcome });
      },
      stop: async () => {
        stopped = true;
        for (const request of pending.values()) request.resolve({ decision: "decline" });
        pending.clear();
        client.close();
        terminateChild(child);
      },
      resumeCursor: () => nativeThreadId ? { threadId: nativeThreadId } : null,
    };
  }
}
