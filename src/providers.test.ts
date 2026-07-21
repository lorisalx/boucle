import assert from "node:assert/strict";
import test from "node:test";

import { getProvider, invalidateProvider, registerProvider } from "./providers/index.ts";
import type { Provider } from "./providers/types.ts";

function provider(name: string): Provider {
  return {
    name,
    chatModel: "extension-default",
    isConfigured: () => true,
    supportsEmbeddings: () => false,
    supportsTranscription: () => false,
    chat: async () => ({ role: "assistant", content: "ok" }),
    embed: async () => [],
    transcribe: async () => "",
  };
}

test("an unknown configured provider falls back with the default provider's model settings", () => {
  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => errors.push(args);
  try {
    invalidateProvider();
    const selected = getProvider({ getMeta: (key) => key === "provider" ? "removed-extension" : null });
    assert.equal(selected.name, "mistral");
    assert.equal(selected.chatModel, "mistral-medium-3.5");
    assert.match(String(errors[0]?.[0]), /falling back to mistral/);
  } finally {
    console.error = originalError;
  }
});

test("an extension provider can supply its own default model", () => {
  const name = "test-extension-provider";
  const unregister = registerProvider(name, () => provider(name));
  try {
    invalidateProvider();
    const selected = getProvider({ getMeta: (key) => key === "provider" ? name : null });
    assert.equal(selected.name, name);
    assert.equal(selected.chatModel, "extension-default");
  } finally {
    unregister();
    invalidateProvider();
  }
});
