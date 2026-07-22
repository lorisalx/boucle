import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import { CodexJsonRpcClient, codexRuntimeConfig, isRecoverableCodexResumeError, mapCodexNotification } from "./codex-adapter.ts";

test("Codex resume fallback is limited to missing-thread failures", () => {
  assert.equal(isRecoverableCodexResumeError(new Error("Thread does not exist")), true);
  assert.equal(isRecoverableCodexResumeError(new Error("Permission denied")), false);
  assert.equal(isRecoverableCodexResumeError(new Error("Model not found")), false);
});

test("Codex runtime settings map to app-server approval and sandbox values", () => {
  assert.deepEqual(codexRuntimeConfig("acceptEdits"), {
    approvalPolicy: "on-request", sandbox: "workspace-write", sandboxPolicy: { type: "workspaceWrite" },
  });
  assert.deepEqual(codexRuntimeConfig("bypassPermissions"), {
    approvalPolicy: "never", sandbox: "danger-full-access", sandboxPolicy: { type: "dangerFullAccess" },
  });
});

test("Codex v2 notification fixtures map exact app-server methods", () => {
  assert.deepEqual(mapCodexNotification("thread/started", { thread: { id: "thread-native" } }), [
    { type: "session.started", nativeSessionId: "thread-native" },
  ]);
  assert.deepEqual(mapCodexNotification("turn/started", { threadId: "thread-native", turn: { id: "turn-1" } }), [
    { type: "turn.started", turnId: "turn-1" },
  ]);
  assert.deepEqual(mapCodexNotification("item/agentMessage/delta", {
    threadId: "thread-native", turnId: "turn-1", itemId: "item-1", delta: "ping",
  }), [{ type: "content.delta", text: "ping" }]);
  assert.deepEqual(mapCodexNotification("item/started", {
    threadId: "thread-native",
    turnId: "turn-1",
    item: { id: "item-2", type: "commandExecution", command: "pnpm test", status: "inProgress", cwd: "/tmp", commandActions: [] },
  }), [{
    type: "activity", tone: "tool", kind: "commandExecution", summary: "pnpm test",
    payload: { id: "item-2", type: "commandExecution", command: "pnpm test", status: "inProgress", cwd: "/tmp", commandActions: [] },
    status: "running",
  }]);
  assert.deepEqual(mapCodexNotification("thread/tokenUsage/updated", {
    threadId: "thread-native",
    turnId: "turn-1",
    tokenUsage: { last: { inputTokens: 8, outputTokens: 3 } },
  }), [{ type: "token-usage", input: 8, output: 3 }]);
});

test("newline JSON-RPC client frames split responses and parks server requests", async () => {
  const serverToClient = new PassThrough();
  const clientToServer = new PassThrough();
  const client = new CodexJsonRpcClient(serverToClient, clientToServer);
  const written: Array<Record<string, unknown>> = [];
  let remainder = "";
  clientToServer.on("data", (chunk: Buffer) => {
    remainder += chunk.toString("utf8");
    const lines = remainder.split("\n");
    remainder = lines.pop() ?? "";
    for (const line of lines) if (line) written.push(JSON.parse(line) as Record<string, unknown>);
  });

  const response = client.request("thread/start", { cwd: "/workspace" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(written[0], { id: 1, method: "thread/start", params: { cwd: "/workspace" } });
  serverToClient.write('{"id":1,"res');
  serverToClient.write('ult":{"thread":{"id":"native-1"}}}\n');
  assert.deepEqual(await response, { thread: { id: "native-1" } });

  let settleApproval!: (value: unknown) => void;
  client.onRequest("item/commandExecution/requestApproval", () => new Promise((resolve) => { settleApproval = resolve; }));
  serverToClient.write('{"id":900,"method":"item/commandExecution/requestApproval","params":{"command":"ls"}}\n');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(written.some((message) => message.id === 900), false);
  settleApproval({ decision: "accept" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(written.at(-1), { id: 900, result: { decision: "accept" } });
  client.close();
});
