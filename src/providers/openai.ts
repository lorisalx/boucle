// OpenAI-compatible provider for OpenAI, Ollama, OpenRouter, vLLM, and similar gateways.

import { OpenAICompatibleProvider } from "./openai-compat.ts";

export function createOpenAIProvider(): OpenAICompatibleProvider {
  const chatModel = (process.env.BOUCLE_CHAT_MODEL ?? "").trim();
  if (!chatModel) throw new Error("BOUCLE_CHAT_MODEL is required when BOUCLE_PROVIDER=openai.");
  return new OpenAICompatibleProvider({
    name: "openai",
    baseUrl: (process.env.OPENAI_BASE_URL ?? "").trim() || "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    defaults: {
      chat: chatModel,
      embed: "text-embedding-3-small",
      transcribe: "whisper-1",
    },
  });
}
