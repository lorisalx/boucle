import assert from "node:assert/strict";
import test from "node:test";

import { getT3CodeConfig, spawnT3CodeChat } from "./t3code.ts";

test("t3code spawn dispatches a seeded thread in the configured project and returns its deep link", async () => {
  const config = getT3CodeConfig({
    getMeta(key) {
      return key === "t3codeUrl" ? "https://t3.example/"
        : key === "t3codeToken" ? "secret-token"
          : key === "t3codeProject" ? "boucle"
            : null;
    },
  });
  assert.ok(config);
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith("/api/orchestration/snapshot")) {
      return Response.json({ projects: [{ id: "project-1", title: "Boucle", workspaceRoot: "/src/boucle", deletedAt: null }] });
    }
    if (url.endsWith("/.well-known/t3/environment")) return Response.json({ environmentId: "environment-1" });
    return new Response(null, { status: 204 });
  };
  try {
    const result = await spawnT3CodeChat(config, { title: "Tiny ticket", prompt: "Inspect this ticket." });
    assert.match(result.threadId, /^[0-9a-f-]{36}$/);
    assert.equal(result.openUrl, `https://t3.example/environment-1/${result.threadId}`);
    const commands = requests
      .filter((request) => request.url.endsWith("/api/orchestration/dispatch"))
      .map((request) => JSON.parse(String(request.init?.body)) as { type: string; threadId: string; message?: { text?: string } });
    assert.deepEqual(commands.map((command) => command.type), ["thread.create", "thread.turn.start"]);
    assert.equal(commands[0]?.threadId, result.threadId);
    assert.equal(commands[1]?.message?.text, "Inspect this ticket.");
    assert.equal(requests[0]?.init?.headers && (requests[0].init.headers as Record<string, string>).authorization, "Bearer secret-token");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
