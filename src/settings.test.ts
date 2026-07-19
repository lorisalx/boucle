import assert from "node:assert/strict";
import test from "node:test";

import { parseSettingsUpdate, resolveSettings, settingsWithUpdate } from "./settings.ts";

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

test("settings updates normalize selectors and allow clearing meta overrides", () => {
  assert.deepEqual(parseSettingsUpdate({ provider: "Mistral", runner: "Codex", chatModel: null }), {
    provider: "mistral",
    runner: "codex",
    chatModel: null,
  });
  assert.deepEqual(parseSettingsUpdate({ provider: null, runner: null }), { provider: null, runner: null });

  const previous = process.env.BOUCLE_CHAT_MODEL;
  process.env.BOUCLE_CHAT_MODEL = "env-chat-model";
  try {
    const settings = settingsWithUpdate({
      getMeta(key) {
        return key === "chatModel" ? "meta-chat-model" : null;
      },
    }, { chatModel: null }, false);
    assert.deepEqual(settings.chatModel, { value: "env-chat-model", source: "env" });
  } finally {
    if (previous === undefined) delete process.env.BOUCLE_CHAT_MODEL;
    else process.env.BOUCLE_CHAT_MODEL = previous;
  }
});
