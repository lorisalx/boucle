import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { z } from "zod";

const jsonValueSchema: z.ZodType<unknown> = z.unknown();

export const runtimeEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session.started"), nativeSessionId: z.string().min(1) }),
  z.object({ type: z.literal("turn.started"), turnId: z.string().min(1) }),
  z.object({ type: z.literal("turn.completed"), turnId: z.string().min(1).optional() }),
  z.object({ type: z.literal("turn.aborted"), turnId: z.string().min(1).optional() }),
  z.object({ type: z.literal("content.delta"), text: z.string() }),
  z.object({ type: z.literal("message.completed"), text: z.string() }),
  z.object({
    type: z.literal("activity"),
    tone: z.enum(["tool", "approval", "error", "info"]),
    kind: z.string().min(1),
    summary: z.string(),
    payload: jsonValueSchema.optional(),
    status: z.string().optional(),
  }),
  z.object({
    type: z.literal("request.opened"),
    requestId: z.string().min(1),
    kind: z.string().min(1),
    summary: z.string(),
    payload: jsonValueSchema.optional(),
  }),
  z.object({
    type: z.literal("request.resolved"),
    requestId: z.string().min(1),
    outcome: z.enum(["approve", "deny"]),
  }),
  z.object({
    type: z.literal("token-usage"),
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);

export type RuntimeEvent = z.infer<typeof runtimeEventSchema>;
export type ThreadEngine = "claude" | "codex";
export type RequestOutcome = "approve" | "deny";
export interface ThreadRuntimeSettings {
  permissionMode: "acceptEdits" | "bypassPermissions";
  model?: string;
}

export interface LiveSession {
  sendTurn(prompt: string): Promise<void>;
  interrupt(): Promise<void>;
  respond(requestId: string, outcome: RequestOutcome): Promise<void>;
  stop(): Promise<void>;
  resumeCursor(): unknown;
}

export interface ThreadAdapter {
  engine: ThreadEngine;
  start(opts: {
    threadId: string;
    cwd: string;
    resumeCursor: unknown | null;
    settings: ThreadRuntimeSettings;
    onEvent: (event: RuntimeEvent) => void;
  }): Promise<LiveSession>;
}

/** Keep provider-native traffic out of SQLite while retaining a complete debugging trail. */
export async function appendNativeEvent(threadId: string, event: unknown, root = join(process.cwd(), "var", "threads")): Promise<void> {
  const path = join(root, `${threadId}.ndjson`);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify({ at: new Date().toISOString(), event })}\n`, "utf8");
}
