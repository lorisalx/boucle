import assert from "node:assert/strict";
import test from "node:test";

import { terminalClientMessageSchema, terminalServerMessageSchema } from "./wire.ts";

test("terminal wire schemas accept canonical messages", () => {
  assert.deepEqual(terminalClientMessageSchema.parse({ type: "write", data: "ls\n" }), {
    type: "write",
    data: "ls\n",
  });
  assert.deepEqual(terminalClientMessageSchema.parse({ type: "resize", cols: 120, rows: 40 }), {
    type: "resize",
    cols: 120,
    rows: 40,
  });
  assert.deepEqual(terminalServerMessageSchema.parse({
    type: "snapshot",
    history: "\u001b[32mready\u001b[0m\n",
    status: "running",
    pid: 42,
  }), {
    type: "snapshot",
    history: "\u001b[32mready\u001b[0m\n",
    status: "running",
    pid: 42,
  });
});

test("terminal wire schemas reject oversized writes and invalid dimensions", () => {
  assert.equal(terminalClientMessageSchema.safeParse({ type: "write", data: "é".repeat(32_769) }).success, false);
  assert.equal(terminalClientMessageSchema.safeParse({ type: "resize", cols: 0, rows: 24 }).success, false);
  assert.equal(terminalClientMessageSchema.safeParse({ type: "resize", cols: 80, rows: 501 }).success, false);
  assert.equal(terminalClientMessageSchema.safeParse({ type: "restart", extra: true }).success, false);
  assert.equal(terminalServerMessageSchema.safeParse({ type: "snapshot", history: "", status: "open", pid: null }).success, false);
});
