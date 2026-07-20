import assert from "node:assert/strict";
import test from "node:test";

import { T3CodeRunner } from "./t3code-runner.ts";

const META: Record<string, string> = {
  t3codeUrl: "https://t3.example/",
  t3codeToken: "secret-token",
  t3codeProject: "boucle",
};

const store = { getMeta: (key: string) => META[key] ?? null };

const SPEC = {
  scope: "loops_loop-1",
  title: "Daily work report",
  mcpUrl: "http://127.0.0.1:4319/mcp",
  mcpToken: "mcp-token",
  dbPath: "/tmp/boucle.db",
  workdir: "/tmp",
  maxPriceUsd: 0.25,
  timeoutMin: 12,
};

/** Stub t3code's HTTP surface and record every dispatched command. */
async function withStubbedT3Code<T>(run: (commands: Array<Record<string, unknown>>) => Promise<T>): Promise<T> {
  const commands: Array<Record<string, unknown>> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/orchestration/snapshot")) {
      return Response.json({ projects: [{ id: "project-1", title: "Boucle", workspaceRoot: "/src/boucle", deletedAt: null }] });
    }
    if (url.endsWith("/.well-known/t3/environment")) return Response.json({ environmentId: "environment-1" });
    if (url.endsWith("/api/orchestration/dispatch")) {
      commands.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    }
    return new Response(null, { status: 204 });
  };
  try {
    return await run(commands);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("t3code runner resumes an existing thread instead of opening a new chat", async () => {
  await withStubbedT3Code(async (commands) => {
    const result = await new T3CodeRunner(store).exec({
      ...SPEC,
      prompt: "Run the loop.",
      model: "claude-sonnet-5",
      resumeSessionId: "thread-1",
    });

    // Resuming posts a turn only — no thread.create.
    assert.deepEqual(commands.map((command) => command.type), ["thread.turn.start"]);
    assert.equal(commands[0]?.threadId, "thread-1");
    assert.equal(result.sessionId, "thread-1");
    assert.equal(result.openUrl, "https://t3.example/environment-1/thread-1");
    assert.equal(result.code, 0);
    // The conversation lives in t3code, so there is no local cost to report.
    assert.equal(result.costUsd, null);
  });
});

test("t3code runner spawns a titled thread and maps the loop model to an agent", async () => {
  await withStubbedT3Code(async (commands) => {
    const result = await new T3CodeRunner(store).exec({
      ...SPEC,
      prompt: "Run the loop.",
      model: "claude-sonnet-5",
      resumeSessionId: null,
    });

    assert.deepEqual(commands.map((command) => command.type), ["thread.create", "thread.turn.start"]);
    assert.equal(commands[0]?.title, "Loop: Daily work report");
    assert.deepEqual(commands[0]?.modelSelection, {
      instanceId: "claudeAgent",
      model: "claude-sonnet-5",
      options: [
        { id: "effort", value: "medium" },
        { id: "fastMode", value: false },
      ],
    });
    assert.equal(commands[0]?.threadId, result.sessionId);
  });
});

test("t3code runner routes a gpt model to codex and leaves unknown models to the t3code default", async () => {
  await withStubbedT3Code(async (commands) => {
    const runner = new T3CodeRunner(store);
    await runner.exec({ ...SPEC, prompt: "go", model: "gpt-5.4", resumeSessionId: null });
    await runner.exec({ ...SPEC, prompt: "go", model: "devstral-2512", resumeSessionId: null });

    const creates = commands.filter((command) => command.type === "thread.create");
    assert.equal((creates[0]?.modelSelection as { instanceId: string }).instanceId, "codex");
    // Unrecognized models fall through so t3code applies its own shipped default.
    assert.equal((creates[1]?.modelSelection as { model: string }).model, "claude-opus-4-8");
  });
});

test("t3code runner fails loudly when t3code is not configured", async () => {
  const runner = new T3CodeRunner({ getMeta: () => null });
  await assert.rejects(
    runner.exec({ ...SPEC, prompt: "go", model: null, resumeSessionId: null }),
    /t3code runner selected but t3code is not configured/,
  );
});
