import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { listSessions, readSession } from "./sessions-index.ts";

const CLAUDE_ID = "11111111-1111-4111-8111-111111111111";
const CODEX_ID = "22222222-2222-4222-8222-222222222222";

async function fixtureStores(): Promise<{
  root: string;
  claudeHome: string;
  codexHome: string;
  claudeFile: string;
  codexFile: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "boucle-sessions-index-"));
  const claudeHome = join(root, "claude");
  const codexHome = join(root, "codex");
  const claudeProject = join(claudeHome, "projects", "-work-alpha");
  const codexDay = join(codexHome, "sessions", "2026", "07", "22");
  await Promise.all([
    mkdir(claudeProject, { recursive: true }),
    mkdir(codexDay, { recursive: true }),
    mkdir(join(codexHome, "archived_sessions"), { recursive: true }),
  ]);

  const claudeFile = join(claudeProject, `${CLAUDE_ID}.jsonl`);
  await writeFile(claudeFile, [
    JSON.stringify({
      type: "user",
      timestamp: "2026-07-20T10:00:00.000Z",
      sessionId: CLAUDE_ID,
      cwd: "/work/alpha",
      message: { content: [{ type: "text", text: "Plan the alpha launch" }] },
    }),
    "not-json",
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-20T10:01:00.000Z",
      sessionId: CLAUDE_ID,
      message: { content: [{ type: "text", text: "Here is the plan." }] },
    }),
  ].join("\n"));

  const codexFile = join(codexDay, `rollout-2026-07-21T12-00-00-${CODEX_ID}.jsonl`);
  await writeFile(codexFile, [
    JSON.stringify({
      type: "session_meta",
      timestamp: "2026-07-21T12:00:00.000Z",
      payload: { session_id: CODEX_ID, cwd: "/work/beta" },
    }),
    "{malformed",
    JSON.stringify({ type: "event_msg", timestamp: "2026-07-21T12:00:01.000Z", payload: { type: "user_message", message: "Inspect beta" } }),
    JSON.stringify({ type: "response_item", timestamp: "2026-07-21T12:00:02.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Checking." }] } }),
    JSON.stringify({ type: "response_item", timestamp: "2026-07-21T12:00:03.000Z", payload: { type: "custom_tool_call", call_id: "call-1", name: "exec", input: "{\"cmd\":\"pwd\"}" } }),
    JSON.stringify({ type: "response_item", timestamp: "2026-07-21T12:00:04.000Z", payload: { type: "custom_tool_call_output", call_id: "call-1", output: "/work/beta" } }),
    JSON.stringify({ type: "response_item", timestamp: "2026-07-21T12:00:05.000Z", payload: { type: "reasoning", encrypted_content: "ignore-me" } }),
  ].join("\n"));
  await writeFile(join(codexHome, "session_index.jsonl"), [
    "bad index row",
    JSON.stringify({ id: CODEX_ID, thread_name: "Beta investigation", updated_at: "2026-07-21T12:00:05.000Z" }),
  ].join("\n"));

  await Promise.all([
    utimes(claudeFile, new Date("2026-07-20T10:00:00.000Z"), new Date("2026-07-20T10:02:00.000Z")),
    utimes(codexFile, new Date("2026-07-21T12:00:00.000Z"), new Date("2026-07-21T12:06:00.000Z")),
  ]);
  return { root, claudeHome, codexHome, claudeFile, codexFile };
}

async function withFixtureStores(run: (stores: Awaited<ReturnType<typeof fixtureStores>>) => Promise<void>): Promise<void> {
  const stores = await fixtureStores();
  const previousClaude = process.env.BOUCLE_CLAUDE_HOME;
  const previousCodex = process.env.BOUCLE_CODEX_HOME;
  process.env.BOUCLE_CLAUDE_HOME = stores.claudeHome;
  process.env.BOUCLE_CODEX_HOME = stores.codexHome;
  try {
    await run(stores);
  } finally {
    if (previousClaude === undefined) delete process.env.BOUCLE_CLAUDE_HOME;
    else process.env.BOUCLE_CLAUDE_HOME = previousClaude;
    if (previousCodex === undefined) delete process.env.BOUCLE_CODEX_HOME;
    else process.env.BOUCLE_CODEX_HOME = previousCodex;
    await rm(stores.root, { recursive: true, force: true });
  }
}

test("lists Claude and Codex sessions with titles, metadata, filtering, and limits", async () => {
  await withFixtureStores(async () => {
    const sessions = await listSessions();
    assert.deepEqual(sessions.map((session) => session.engine), ["codex", "claude"]);
    assert.equal(sessions[0]?.title, "Beta investigation");
    assert.equal(sessions[0]?.cwd, "/work/beta");
    assert.equal(sessions[0]?.project, "beta");
    assert.equal(sessions[0]?.startedAt, "2026-07-21T12:00:00.000Z");
    assert.equal(sessions[1]?.title, "Plan the alpha launch");
    assert.equal(sessions[1]?.project, "alpha");
    assert.deepEqual((await listSessions({ engine: "claude" })).map((session) => session.sessionId), [CLAUDE_ID]);
    assert.deepEqual((await listSessions({ q: "BETA", limit: 1 })).map((session) => session.sessionId), [CODEX_ID]);
  });
});

test("invalidates cached summaries when mtime changes but size does not", async () => {
  await withFixtureStores(async ({ claudeFile }) => {
    assert.equal((await listSessions({ engine: "claude" }))[0]?.title, "Plan the alpha launch");
    const original = await readFile(claudeFile, "utf8");
    const rewritten = original.replace("Plan the alpha launch", "Move the alpha launch");
    assert.equal(Buffer.byteLength(rewritten), Buffer.byteLength(original));
    await writeFile(claudeFile, rewritten);
    await utimes(claudeFile, new Date("2026-07-22T09:00:00.000Z"), new Date("2026-07-22T09:01:00.000Z"));
    const refreshed = (await listSessions({ engine: "claude" }))[0];
    assert.equal(refreshed?.title, "Move the alpha launch");
    assert.equal(refreshed?.project, "alpha");
  });
});

test("reads malformed JSONL safely and maps Codex tool calls and outputs", async () => {
  await withFixtureStores(async () => {
    const claude = await readSession("claude", CLAUDE_ID);
    assert.deepEqual(claude?.entries.map((entry) => entry.role), ["user", "assistant"]);

    const codex = await readSession("codex", CODEX_ID);
    assert.deepEqual(codex?.entries.map((entry) => entry.role), ["user", "assistant", "tool", "tool"]);
    assert.equal(codex?.entries[2]?.toolName, "exec");
    assert.match(codex?.entries[2]?.content ?? "", /pwd/);
    assert.equal(codex?.entries[3]?.toolName, "exec");
    assert.equal(codex?.entries[3]?.content, "/work/beta");
    assert.equal(codex?.entries.some((entry) => entry.content.includes("ignore-me")), false);
  });
});

test("rejects invalid ids and files that escape a store through symlinks", async () => {
  await withFixtureStores(async ({ root, claudeHome }) => {
    const escapedId = "33333333-3333-4333-8333-333333333333";
    const outside = join(root, "outside.jsonl");
    await writeFile(outside, JSON.stringify({ type: "user", sessionId: escapedId, cwd: "/escape", message: { content: "secret" } }));
    await symlink(outside, join(claudeHome, "projects", "-work-alpha", `${escapedId}.jsonl`));

    assert.equal(await readSession("claude", "../../outside"), null);
    assert.equal(await readSession("claude", escapedId), null);
    assert.equal((await listSessions({ engine: "claude" })).some((session) => session.sessionId === escapedId), false);
  });
});
