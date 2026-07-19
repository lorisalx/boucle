// Mistral provider through its OpenAI-compatible v1 endpoints.

import { OpenAICompatibleProvider } from "./openai-compat.ts";

export const LEGACY_EMBED_MODEL = "mistral-embed";

export function createMistralProvider(models?: { chat: string; embed: string; transcribe: string }): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    name: "mistral",
    baseUrl: "https://api.mistral.ai/v1",
    apiKeyEnv: "MISTRAL_API_KEY",
    defaults: {
      chat: "mistral-medium-3.5",
      embed: LEGACY_EMBED_MODEL,
      transcribe: "voxtral-mini-latest",
    },
    models,
  });
}
