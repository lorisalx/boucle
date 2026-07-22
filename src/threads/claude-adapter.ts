import { randomUUID } from "node:crypto";

import { query, type CanUseTool, type PermissionResult, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import {
  appendNativeEvent,
  runtimeEventSchema,
  type LiveSession,
  type RequestOutcome,
  type RuntimeEvent,
  type ThreadAdapter,
} from "./events.ts";

class AsyncPromptQueue implements AsyncIterable<SDKUserMessage> {
  private readonly values: SDKUserMessage[] = [];
  private readonly waiters: Array<(value: IteratorResult<SDKUserMessage>) => void> = [];
  private ended = false;

  push(value: SDKUserMessage): void {
    if (this.ended) throw new Error("Claude prompt queue is closed");
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  end(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value) return Promise.resolve({ value, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

/** Pure SDK fixture mapper used by tests and by the live consumer. */
export function mapClaudeMessage(message: unknown, activeTurnId?: string, interrupted = false): RuntimeEvent[] {
  const raw = record(message);
  const events: RuntimeEvent[] = [];
  const sessionId = typeof raw.session_id === "string" ? raw.session_id : "";
  if (raw.type === "system" && raw.subtype === "init" && sessionId) {
    events.push({ type: "session.started", nativeSessionId: sessionId });
  }
  if (raw.type === "stream_event") {
    const streamEvent = record(raw.event);
    if (streamEvent.type === "content_block_delta") {
      const delta = record(streamEvent.delta);
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        events.push({ type: "content.delta", text: delta.text });
      }
    }
  }
  if (raw.type === "assistant") {
    const sdkMessage = record(raw.message);
    const blocks = Array.isArray(sdkMessage.content) ? sdkMessage.content : [];
    for (const value of blocks) {
      const block = record(value);
      if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
        events.push({ type: "message.completed", text: block.text });
      } else if (block.type === "tool_use") {
        const name = typeof block.name === "string" ? block.name : "tool";
        events.push({
          type: "activity",
          tone: "tool",
          kind: name,
          summary: `Using ${name}`,
          payload: block.input,
          status: "running",
        });
      }
    }
  }
  if (raw.type === "result") {
    // After a self-initiated interrupt the SDK still emits a trailing result marked
    // is_error; turn.aborted was already emitted, so only the usage numbers are real.
    if (!interrupted) events.push({ type: "turn.completed", ...(activeTurnId ? { turnId: activeTurnId } : {}) });
    const usage = record(raw.usage);
    const input = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
    const output = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
    events.push({ type: "token-usage", input, output });
    if (raw.is_error === true && !interrupted) {
      const errors = Array.isArray(raw.errors) ? raw.errors.filter((value): value is string => typeof value === "string") : [];
      events.push({ type: "error", message: errors.join("\n") || "Claude turn failed" });
    }
  }
  return events.map((event) => runtimeEventSchema.parse(event));
}

interface PendingPermission {
  resolve: (result: PermissionResult) => void;
  input: Record<string, unknown>;
}

export function claudePermissionOptions(permissionMode: "acceptEdits" | "bypassPermissions") {
  return {
    permissionMode,
    ...(permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true as const } : {}),
  };
}

export class ClaudeAdapter implements ThreadAdapter {
  readonly engine = "claude" as const;

  async start(opts: {
    threadId: string;
    cwd: string;
    resumeCursor: unknown | null;
    settings: { permissionMode: "acceptEdits" | "bypassPermissions"; model?: string };
    onEvent: (event: RuntimeEvent) => void;
  }): Promise<LiveSession> {
    const prompts = new AsyncPromptQueue();
    const pending = new Map<string, PendingPermission>();
    let nativeSessionId: string | null = null;
    let activeTurnId: string | undefined;
    let interruptedTurn = false;
    let stopped = false;

    const emit = (event: RuntimeEvent) => opts.onEvent(runtimeEventSchema.parse(event));
    const canUseTool: CanUseTool = async (toolName, input, permissionOpts) => {
      const requestId = permissionOpts.requestId || permissionOpts.toolUseID;
      emit({
        type: "request.opened",
        requestId,
        kind: toolName,
        summary: permissionOpts.title ?? permissionOpts.description ?? `Allow ${toolName}?`,
        payload: { input, blockedPath: permissionOpts.blockedPath, reason: permissionOpts.decisionReason },
      });
      return new Promise<PermissionResult>((resolve) => {
        const onAbort = () => {
          pending.delete(requestId);
          resolve({ behavior: "deny", message: "Interrupted", interrupt: true });
        };
        permissionOpts.signal.addEventListener("abort", onAbort, { once: true });
        pending.set(requestId, {
          input,
          resolve: (result) => {
            permissionOpts.signal.removeEventListener("abort", onAbort);
            resolve(result);
          },
        });
      });
    };

    const cursor = record(opts.resumeCursor);
    const resume = typeof cursor.resume === "string" ? cursor.resume : undefined;
    const liveQuery = query({
      prompt: prompts,
      options: {
        cwd: opts.cwd,
        includePartialMessages: true,
        ...claudePermissionOptions(opts.settings.permissionMode),
        ...(opts.settings.model ? { model: opts.settings.model } : {}),
        canUseTool,
        ...(resume ? { resume } : {}),
      },
    });

    void (async () => {
      try {
        for await (const message of liveQuery) {
          void appendNativeEvent(opts.threadId, message).catch(() => {});
          const raw = record(message);
          if (typeof raw.session_id === "string" && raw.session_id) nativeSessionId = raw.session_id;
          for (const event of mapClaudeMessage(message, activeTurnId, interruptedTurn)) emit(event);
          if (raw.type === "result") {
            activeTurnId = undefined;
            interruptedTurn = false;
          }
        }
      } catch (error) {
        if (!stopped) emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
      }
    })();

    return {
      sendTurn: async (prompt) => {
        if (activeTurnId) throw new Error("Claude is already running a turn");
        activeTurnId = randomUUID();
        interruptedTurn = false;
        emit({ type: "turn.started", turnId: activeTurnId });
        prompts.push({
          type: "user",
          message: { role: "user", content: prompt },
          parent_tool_use_id: null,
        });
      },
      interrupt: async () => {
        const turnId = activeTurnId;
        if (turnId) interruptedTurn = true;
        await liveQuery.interrupt();
        activeTurnId = undefined;
        emit({ type: "turn.aborted", ...(turnId ? { turnId } : {}) });
      },
      respond: async (requestId: string, outcome: RequestOutcome) => {
        const request = pending.get(requestId);
        if (!request) throw new Error(`Unknown Claude approval request: ${requestId}`);
        pending.delete(requestId);
        request.resolve(outcome === "approve"
          ? { behavior: "allow", updatedInput: request.input }
          : { behavior: "deny", message: "Denied by user" });
        emit({ type: "request.resolved", requestId, outcome });
      },
      stop: async () => {
        stopped = true;
        prompts.end();
        for (const request of pending.values()) request.resolve({ behavior: "deny", message: "Session stopped", interrupt: true });
        pending.clear();
        liveQuery.close();
      },
      resumeCursor: () => nativeSessionId ? { resume: nativeSessionId } : (resume ? { resume } : null),
    };
  }
}
