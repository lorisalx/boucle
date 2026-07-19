import assert from "node:assert/strict";
import test from "node:test";

import { parseSettingsUpdate, resolveSettings } from "./settings.ts";

test("runner and t3code settings resolve from meta before environment and defaults", () => {
  const previous = {
    runner: process.env.BOUCLE_RUNNER,
    url: process.env.BOUCLE_T3CODE_URL,
    token: process.env.BOUCLE_T3CODE_TOKEN,
    project: process.env.BOUCLE_T3CODE_PROJECT,
  };
  process.env.BOUCLE_RUNNER = "codex";
  process.env.BOUCLE_T3CODE_URL = "https://env.example";
  process.env.BOUCLE_T3CODE_TOKEN = "env-token";
  process.env.BOUCLE_T3CODE_PROJECT = "env-project";
  try {
    const settings = resolveSettings({
      getMeta(key) {
        return key === "runner" ? "claude" : key === "t3codeUrl" ? "https://meta.example/" : null;
      },
    }, false);
    assert.deepEqual(settings.runner, { value: "claude", source: "meta" });
    assert.deepEqual(settings.t3codeUrl, { value: "https://meta.example/", source: "meta" });
    assert.deepEqual(settings.t3codeToken, { value: "env-token", source: "env" });
    assert.deepEqual(settings.t3codeProject, { value: "env-project", source: "env" });
    assert.throws(() => parseSettingsUpdate({ runner: "other" }), /vibe, codex, claude/);
  } finally {
    for (const [name, value] of Object.entries({
      BOUCLE_RUNNER: previous.runner,
      BOUCLE_T3CODE_URL: previous.url,
      BOUCLE_T3CODE_TOKEN: previous.token,
      BOUCLE_T3CODE_PROJECT: previous.project,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
