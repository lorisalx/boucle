import assert from "node:assert/strict";
import test from "node:test";

import { claudePermissionOptions, mapClaudeMessage } from "./claude-adapter.ts";

test("Claude permission settings require an explicit bypass opt-in", () => {
  assert.deepEqual(claudePermissionOptions("acceptEdits"), { permissionMode: "acceptEdits" });
  assert.deepEqual(claudePermissionOptions("bypassPermissions"), {
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
  });
});

test("Claude SDK fixtures map streaming text, tool boundaries, and results", () => {
  assert.deepEqual(mapClaudeMessage({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "ping" } },
    parent_tool_use_id: null,
    uuid: "message-1",
    session_id: "session-1",
  }), [{ type: "content.delta", text: "ping" }]);

  assert.deepEqual(mapClaudeMessage({
    type: "assistant",
    session_id: "session-1",
    message: { content: [
      { type: "text", text: "Before" },
      { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "README.md" } },
    ] },
  }), [
    { type: "message.completed", text: "Before" },
    { type: "activity", tone: "tool", kind: "Read", summary: "Using Read", payload: { file_path: "README.md" }, status: "running" },
  ]);

  assert.deepEqual(mapClaudeMessage({
    type: "result",
    subtype: "success",
    session_id: "session-1",
    is_error: false,
    usage: { input_tokens: 12, output_tokens: 4 },
  }, "turn-1"), [
    { type: "turn.completed", turnId: "turn-1" },
    { type: "token-usage", input: 12, output: 4 },
  ]);
});

test("Claude result after a self-initiated interrupt keeps usage but drops completion and error", () => {
  const interruptedResult = {
    type: "result",
    subtype: "error_during_execution",
    session_id: "session-1",
    is_error: true,
    errors: ["[ede_diagnostic] result_type=user stop_reason=null"],
    usage: { input_tokens: 7, output_tokens: 0 },
  };
  assert.deepEqual(mapClaudeMessage(interruptedResult, "turn-1", true), [
    { type: "token-usage", input: 7, output: 0 },
  ]);
  assert.deepEqual(mapClaudeMessage(interruptedResult, "turn-1", false), [
    { type: "turn.completed", turnId: "turn-1" },
    { type: "token-usage", input: 7, output: 0 },
    { type: "error", message: "[ede_diagnostic] result_type=user stop_reason=null" },
  ]);
});

test("Claude init captures the native session id", () => {
  assert.deepEqual(mapClaudeMessage({ type: "system", subtype: "init", session_id: "claude-session" }), [
    { type: "session.started", nativeSessionId: "claude-session" },
  ]);
});
