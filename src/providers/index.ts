// Environment-selected provider and active capability model metadata.

import { createMistralProvider, LEGACY_EMBED_MODEL } from "./mistral.ts";
import { createOpenAIProvider } from "./openai.ts";
import type { OpenAICompatibleProvider } from "./openai-compat.ts";
import type { Provider } from "./types.ts";
import { resolveSettings, validateResolvedSettings, type SettingsStore } from "../settings.ts";

let selected: OpenAICompatibleProvider | null = null;
let settingsStore: SettingsStore | null = null;

export function getProvider(store?: SettingsStore): Provider {
  if (store && store !== settingsStore) {
    settingsStore = store;
    selected = null;
  }
  if (selected) return selected;
  const settings = resolveSettings(settingsStore, false);
  validateResolvedSettings(settings);
  if (settings.provider.value === "mistral") {
    selected = createMistralProvider({
      chat: settings.chatModel.value,
      embed: settings.embedModel.value,
      transcribe: settings.transcribeModel.value,
    });
  } else {
    selected = createOpenAIProvider({
      chatModel: settings.chatModel.value,
      embedModel: settings.embedModel.value,
      transcribeModel: settings.transcribeModel.value,
      baseUrl: settings.openaiBaseUrl.value,
    });
  }
  return selected;
}

export function invalidateProvider(): void {
  selected = null;
}

export function getEmbeddingModel(): string | null {
  getProvider();
  return selected?.embedModel ?? null;
}

export function getLegacyEmbeddingModel(): string {
  return LEGACY_EMBED_MODEL;
}
