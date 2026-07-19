// OpenAI-compatible provider for OpenAI, Ollama, OpenRouter, vLLM, and similar gateways.

import { OpenAICompatibleProvider } from "./openai-compat.ts";

export function createOpenAIProvider(options: {
  chatModel: string;
  embedModel: string;
  transcribeModel: string;
  baseUrl: string;
}): OpenAICompatibleProvider {
  const chatModel = options.chatModel.trim();
  if (!chatModel) throw new Error("BOUCLE_CHAT_MODEL is required when BOUCLE_PROVIDER=openai.");
  return new OpenAICompatibleProvider({
    name: "openai",
    baseUrl: options.baseUrl,
    apiKeyEnv: "OPENAI_API_KEY",
    defaults: {
      chat: chatModel,
      embed: "text-embedding-3-small",
      transcribe: "whisper-1",
    },
    models: { chat: chatModel, embed: options.embedModel, transcribe: options.transcribeModel },
  });
}
