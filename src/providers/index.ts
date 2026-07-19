// Environment-selected provider and active capability model metadata.

import { createMistralProvider, LEGACY_EMBED_MODEL } from "./mistral.ts";
import { createOpenAIProvider } from "./openai.ts";
import type { OpenAICompatibleProvider } from "./openai-compat.ts";
import type { Provider } from "./types.ts";

let selected: OpenAICompatibleProvider | null = null;

export function getProvider(): Provider {
  if (selected) return selected;
  const name = (process.env.BOUCLE_PROVIDER ?? "mistral").trim().toLowerCase();
  if (name === "mistral") selected = createMistralProvider();
  else if (name === "openai") selected = createOpenAIProvider();
  else throw new Error(`Unsupported BOUCLE_PROVIDER: ${name || "(empty)"}.`);
  return selected;
}

export function getEmbeddingModel(): string | null {
  getProvider();
  return selected?.embedModel ?? null;
}

export function getLegacyEmbeddingModel(): string {
  return LEGACY_EMBED_MODEL;
}
