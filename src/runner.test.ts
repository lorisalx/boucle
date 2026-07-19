import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ClaudeRunner } from "./claude.ts";
import { CodexRunner } from "./codex.ts";
import type { AgentExecSpec } from "./runner.ts";

function spec(workdir: string): AgentExecSpec {
  return {
    prompt: "Reply with ok.",
    scope: "loops_test",
    model: null,
    mcpUrl: "http://127.0.0.1:4519/mcp",
    mcpToken: "test-token",
    dbPath: join(workdir, "test.db"),
    workdir,
    resumeSessionId: null,
    maxPriceUsd: 0.01,
    timeoutMin: 1,
  };
}

async function executable(dir: string, name: string, source: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, `#!/usr/bin/env node\n${source}`, { mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}

test("CodexRunner parses JSONL output and provides a fallback transcript", async () => {
  const dir = await mkdtemp(join(tmpdir(), "boucle-codex-runner-"));
  const binary = await executable(dir, "fake-codex", `
console.log(JSON.stringify({type:"thread.started",thread_id:"11111111-1111-4111-8111-111111111111"}));
console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"codex ok"}}));
`);
  const previous = process.env.BOUCLE_CODEX_BIN;
  process.env.BOUCLE_CODEX_BIN = binary;
  try {
    const runner = new CodexRunner();
    const result = await runner.exec(spec(dir));
    assert.equal(result.sessionId, "11111111-1111-4111-8111-111111111111");
    assert.equal(result.output, "codex ok");
    assert.equal(result.costUsd, null);
    const transcript = await runner.readTranscript(dir, "loops_test", result.sessionId);
    assert.equal(transcript?.entries[0]?.content, "codex ok");
    assert.match(await readFile(join(dir, "var", "codex", "loops_test", "config.toml"), "utf8"), /bearer_token_env_var/);
  } finally {
    if (previous === undefined) delete process.env.BOUCLE_CODEX_BIN;
    else process.env.BOUCLE_CODEX_BIN = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("ClaudeRunner parses the JSON result envelope and provides a fallback transcript", async () => {
  const dir = await mkdtemp(join(tmpdir(), "boucle-claude-runner-"));
  const binary = await executable(dir, "fake-claude", `
const args = process.argv.slice(2);
if (args.includes("--help")) console.log("--dangerously-skip-permissions");
else console.log(JSON.stringify({result:"claude ok",session_id:"22222222-2222-4222-8222-222222222222",total_cost_usd:0.0012}));
`);
  const previous = process.env.BOUCLE_CLAUDE_BIN;
  process.env.BOUCLE_CLAUDE_BIN = binary;
  try {
    const runner = new ClaudeRunner();
    const result = await runner.exec(spec(dir));
    assert.equal(result.sessionId, "22222222-2222-4222-8222-222222222222");
    assert.equal(result.output, "claude ok");
    assert.equal(result.costUsd, 0.0012);
    const transcript = await runner.readTranscript(dir, "loops_test", result.sessionId);
    assert.equal(transcript?.entries[0]?.content, "claude ok");
    const mcp = JSON.parse(await readFile(join(dir, "var", "claude", "loops_test", "mcp.json"), "utf8")) as {
      mcpServers: { boucle: { headers: { Authorization: string } } };
    };
    assert.equal(mcp.mcpServers.boucle.headers.Authorization, "Bearer test-token");
  } finally {
    if (previous === undefined) delete process.env.BOUCLE_CLAUDE_BIN;
    else process.env.BOUCLE_CLAUDE_BIN = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
