import { z } from "zod";

const writeDataSchema = z.string().refine(
  (data) => Buffer.byteLength(data, "utf8") <= 64 * 1024,
  "terminal writes must not exceed 64 KiB",
);

export const terminalClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("write"), data: writeDataSchema }).strict(),
  z.object({
    type: z.literal("resize"),
    cols: z.number().int().min(1).max(1000),
    rows: z.number().int().min(1).max(500),
  }).strict(),
  z.object({ type: z.literal("restart") }).strict(),
  z.object({ type: z.literal("close") }).strict(),
]);

export const terminalServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("snapshot"),
    history: z.string(),
    status: z.enum(["running", "exited"]),
    pid: z.number().int().positive().nullable(),
  }).strict(),
  z.object({ type: z.literal("output"), data: z.string() }).strict(),
  z.object({ type: z.literal("exited"), code: z.number().int() }).strict(),
  z.object({ type: z.literal("restarted") }).strict(),
]);

export type TerminalClientMessage = z.infer<typeof terminalClientMessageSchema>;
export type TerminalServerMessage = z.infer<typeof terminalServerMessageSchema>;
export type TerminalStatus = "running" | "exited";
