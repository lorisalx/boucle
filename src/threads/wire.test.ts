import assert from "node:assert/strict";
import test from "node:test";

import { threadActivityPayloadSchema, threadMessagePayloadSchema, threadWireEventSchema } from "./wire.ts";

test("thread wire schemas accept canonical message and approval events", () => {
  assert.deepEqual(threadMessagePayloadSchema.parse({ role: "assistant", content: "hi", streaming: true }), {
    role: "assistant", content: "hi", streaming: true,
  });
  assert.equal(threadActivityPayloadSchema.parse({
    tone: "approval", kind: "command", summary: "Run tests?", requestId: "request-1", status: "open",
  }).requestId, "request-1");
  assert.equal(threadWireEventSchema.parse({
    sequence: 3,
    kind: "message",
    payload: { role: "user", content: "hello" },
  }).sequence, 3);
});

test("thread wire schemas reject invalid sequences and payloads", () => {
  assert.equal(threadWireEventSchema.safeParse({ sequence: 0, kind: "message", payload: { role: "user", content: "x" } }).success, false);
  assert.equal(threadWireEventSchema.safeParse({ sequence: 1, kind: "activity", payload: { tone: "unknown" } }).success, false);
});

