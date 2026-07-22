import { z } from "zod";

export const threadMessagePayloadSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  streaming: z.boolean().optional(),
});

export const threadActivityPayloadSchema = z.object({
  tone: z.enum(["tool", "approval", "error", "info"]),
  kind: z.string(),
  summary: z.string(),
  payloadJson: z.string().optional(),
  status: z.string().optional(),
  requestId: z.string().optional(),
});

export const threadWireEventSchema = z.discriminatedUnion("kind", [
  z.object({ sequence: z.number().int().positive(), kind: z.literal("message"), payload: threadMessagePayloadSchema }),
  z.object({ sequence: z.number().int().positive(), kind: z.literal("activity"), payload: threadActivityPayloadSchema }),
]);

export type ThreadMessagePayload = z.infer<typeof threadMessagePayloadSchema>;
export type ThreadActivityPayload = z.infer<typeof threadActivityPayloadSchema>;
export type ThreadWireEvent = z.infer<typeof threadWireEventSchema>;

