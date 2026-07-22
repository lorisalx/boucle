import type { BoucleStore, StoredThreadEvent, ThreadRecord } from "../store.ts";
import type { LiveSession, RequestOutcome, RuntimeEvent, ThreadAdapter, ThreadEngine } from "./events.ts";
import { threadWireEventSchema, type ThreadWireEvent } from "./wire.ts";

interface LiveEntry {
  session: LiveSession;
  lastActivity: number;
}

interface FoldState {
  pendingDelta: string;
  segmentOpen: boolean;
  flushTimer: NodeJS.Timeout | null;
  turnId: string | null;
}

type Subscriber = (event: ThreadWireEvent) => void;

function payloadJson(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try { return JSON.stringify(value); } catch { return JSON.stringify(String(value)); }
}

export class ThreadManager {
  private readonly store: BoucleStore;
  private readonly idleMs: number;
  private readonly adapters: Map<ThreadEngine, ThreadAdapter>;
  private readonly live = new Map<string, LiveEntry>();
  private readonly starting = new Map<string, Promise<LiveSession>>();
  private readonly folds = new Map<string, FoldState>();
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  private readonly reaper: NodeJS.Timeout;

  constructor(
    store: BoucleStore,
    adapters: Iterable<ThreadAdapter>,
    idleMs = 30 * 60 * 1000,
    reaperIntervalMs = 60 * 1000,
  ) {
    this.store = store;
    this.idleMs = idleMs;
    this.adapters = new Map(Array.from(adapters, (adapter) => [adapter.engine, adapter]));
    this.store.resetRunningThreads();
    this.reaper = setInterval(() => void this.reapIdle(), reaperIntervalMs);
    this.reaper.unref();
  }

  snapshot(threadId: string): { thread: ThreadRecord; events: StoredThreadEvent[]; sequence: number } | null {
    const thread = this.store.getThread(threadId);
    if (!thread) return null;
    const events = this.store.listThreadEvents(threadId);
    return { thread, events, sequence: events.at(-1)?.sequence ?? 0 };
  }

  async sendTurn(threadId: string, prompt: string): Promise<void> {
    const thread = this.store.getThread(threadId);
    if (!thread) throw new Error("Thread not found");
    if (thread.status === "running") throw new Error("Thread already has a running turn");
    const session = await this.ensureSession(thread);
    const title = thread.title || prompt.replace(/\s+/g, " ").trim().slice(0, 80);
    this.store.updateThread(threadId, { status: "running", title });
    this.persist(threadId, "message", { role: "user", content: prompt });
    this.touch(threadId);
    try {
      await session.sendTurn(prompt);
    } catch (error) {
      this.store.updateThread(threadId, { status: "error" });
      this.handleRuntimeEvent(threadId, { type: "error", message: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  async interrupt(threadId: string): Promise<void> {
    const thread = this.store.getThread(threadId);
    if (!thread) throw new Error("Thread not found");
    const session = this.live.get(threadId)?.session;
    if (!session) {
      this.store.updateThread(threadId, { status: "idle" });
      return;
    }
    this.touch(threadId);
    await session.interrupt();
  }

  async respond(threadId: string, requestId: string, outcome: RequestOutcome): Promise<void> {
    const thread = this.store.getThread(threadId);
    if (!thread) throw new Error("Thread not found");
    const session = this.live.get(threadId)?.session;
    if (!session) throw new Error("Thread session is not live; the approval has expired");
    this.touch(threadId);
    await session.respond(requestId, outcome);
  }

  /** Subscribe first, replay second: synchronous SQLite replay plus per-sequence client dedupe closes the snapshot gap. */
  subscribe(threadId: string, after: number, subscriber: Subscriber): () => void {
    const set = this.subscribers.get(threadId) ?? new Set<Subscriber>();
    set.add(subscriber);
    this.subscribers.set(threadId, set);
    for (const event of this.store.listThreadEvents(threadId, after)) subscriber(this.toWire(event));
    return () => {
      set.delete(subscriber);
      if (set.size === 0) this.subscribers.delete(threadId);
    };
  }

  async delete(threadId: string): Promise<boolean> {
    await this.stopLive(threadId);
    this.subscribers.delete(threadId);
    this.clearFold(threadId);
    return this.store.deleteThread(threadId);
  }

  async dispose(): Promise<void> {
    clearInterval(this.reaper);
    await Promise.all(Array.from(this.live.keys(), (threadId) => this.stopLive(threadId)));
  }

  private fold(threadId: string): FoldState {
    let state = this.folds.get(threadId);
    if (!state) {
      state = { pendingDelta: "", segmentOpen: false, flushTimer: null, turnId: null };
      this.folds.set(threadId, state);
    }
    return state;
  }

  private async ensureSession(thread: ThreadRecord): Promise<LiveSession> {
    const current = this.live.get(thread.threadId);
    if (current) return current.session;
    const pending = this.starting.get(thread.threadId);
    if (pending) return pending;
    const adapter = this.adapters.get(thread.engine);
    if (!adapter) throw new Error(`No ${thread.engine} thread adapter configured`);
    const promise = adapter.start({
      threadId: thread.threadId,
      cwd: thread.cwd,
      resumeCursor: thread.resumeCursor,
      settings: thread.settings,
      onEvent: (event) => this.handleRuntimeEvent(thread.threadId, event),
    }).then((session) => {
      this.live.set(thread.threadId, { session, lastActivity: Date.now() });
      this.store.updateThread(thread.threadId, { resumeCursor: session.resumeCursor() });
      return session;
    }).finally(() => this.starting.delete(thread.threadId));
    this.starting.set(thread.threadId, promise);
    return promise;
  }

  private handleRuntimeEvent(threadId: string, event: RuntimeEvent): void {
    this.touch(threadId);
    const state = this.fold(threadId);
    switch (event.type) {
      case "session.started": {
        const live = this.live.get(threadId);
        if (live) this.store.updateThread(threadId, { resumeCursor: live.session.resumeCursor() });
        break;
      }
      case "turn.started":
        state.turnId = event.turnId;
        this.store.updateThread(threadId, { status: "running" });
        this.persist(threadId, "activity", { tone: "info", kind: "turn-status", summary: "Turn started", status: "running" }, state.turnId);
        break;
      case "content.delta":
        state.pendingDelta += event.text;
        state.segmentOpen = true;
        if (!state.flushTimer) {
          state.flushTimer = setTimeout(() => {
            state.flushTimer = null;
            this.flushDelta(threadId);
          }, 100);
          state.flushTimer.unref();
        }
        break;
      case "message.completed":
        if (state.segmentOpen) {
          this.flushDelta(threadId);
          this.persist(threadId, "message", { role: "assistant", content: "", streaming: false }, state.turnId);
          state.segmentOpen = false;
        } else if (event.text) {
          this.persist(threadId, "message", { role: "assistant", content: event.text, streaming: false }, state.turnId);
        }
        break;
      case "activity":
        this.closeSegment(threadId);
        this.persist(threadId, "activity", {
          tone: event.tone,
          kind: event.kind,
          summary: event.summary,
          payloadJson: payloadJson(event.payload),
          status: event.status,
        }, state.turnId);
        break;
      case "request.opened":
        this.closeSegment(threadId);
        this.persist(threadId, "activity", {
          tone: "approval",
          kind: event.kind,
          summary: event.summary,
          payloadJson: payloadJson(event.payload),
          status: "open",
          requestId: event.requestId,
        }, state.turnId);
        break;
      case "request.resolved":
        this.persist(threadId, "activity", {
          tone: "approval",
          kind: "request-resolved",
          summary: event.outcome === "approve" ? "Approved" : "Denied",
          status: event.outcome,
          requestId: event.requestId,
        }, state.turnId);
        break;
      case "token-usage":
        this.persist(threadId, "activity", {
          tone: "info",
          kind: "token-usage",
          summary: `${event.input.toLocaleString()} input · ${event.output.toLocaleString()} output tokens`,
          payloadJson: JSON.stringify({ input: event.input, output: event.output }),
          status: "completed",
        }, state.turnId);
        break;
      case "turn.completed": {
        this.closeSegment(threadId);
        const live = this.live.get(threadId);
        this.persist(threadId, "activity", { tone: "info", kind: "turn-status", summary: "Turn completed", status: "idle" }, state.turnId);
        this.store.updateThread(threadId, live
          ? { status: "idle", resumeCursor: live.session.resumeCursor() }
          : { status: "idle" });
        state.turnId = null;
        break;
      }
      case "turn.aborted": {
        this.closeSegment(threadId);
        const live = this.live.get(threadId);
        this.persist(threadId, "activity", { tone: "info", kind: "turn-status", summary: "Turn interrupted", status: "idle" }, state.turnId);
        this.store.updateThread(threadId, live
          ? { status: "idle", resumeCursor: live.session.resumeCursor() }
          : { status: "idle" });
        state.turnId = null;
        break;
      }
      case "error":
        this.closeSegment(threadId);
        this.persist(threadId, "activity", { tone: "error", kind: "error", summary: event.message, status: "error" }, state.turnId);
        this.store.updateThread(threadId, { status: "error" });
        break;
    }
  }

  private flushDelta(threadId: string): void {
    const state = this.fold(threadId);
    if (!state.pendingDelta) return;
    const content = state.pendingDelta;
    state.pendingDelta = "";
    this.persist(threadId, "message", { role: "assistant", content, streaming: true }, state.turnId);
  }

  private closeSegment(threadId: string): void {
    const state = this.fold(threadId);
    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
      state.flushTimer = null;
    }
    this.flushDelta(threadId);
    if (state.segmentOpen) {
      this.persist(threadId, "message", { role: "assistant", content: "", streaming: false }, state.turnId);
      state.segmentOpen = false;
    }
  }

  private clearFold(threadId: string): void {
    const state = this.folds.get(threadId);
    if (state?.flushTimer) clearTimeout(state.flushTimer);
    this.folds.delete(threadId);
  }

  private persist(threadId: string, kind: "message" | "activity", payload: unknown, turnId: string | null = null): void {
    const stored = this.store.appendThreadEvent({ threadId, kind, payload, turnId });
    const event = this.toWire(stored);
    for (const subscriber of this.subscribers.get(threadId) ?? []) subscriber(event);
  }

  private toWire(event: StoredThreadEvent): ThreadWireEvent {
    return threadWireEventSchema.parse({ sequence: event.sequence, kind: event.kind, payload: event.payload });
  }

  private touch(threadId: string): void {
    const entry = this.live.get(threadId);
    if (entry) entry.lastActivity = Date.now();
  }

  private async reapIdle(): Promise<void> {
    const cutoff = Date.now() - this.idleMs;
    await Promise.all(Array.from(this.live.entries())
      .filter(([, entry]) => entry.lastActivity <= cutoff)
      .map(([threadId]) => this.stopLive(threadId)));
  }

  private async stopLive(threadId: string): Promise<void> {
    const entry = this.live.get(threadId);
    if (!entry) return;
    this.closeSegment(threadId);
    this.store.updateThread(threadId, { resumeCursor: entry.session.resumeCursor(), status: "idle" });
    this.live.delete(threadId);
    await entry.session.stop();
  }
}
