// Environment-selected provider and active capability model metadata.

import { createMistralProvider, LEGACY_EMBED_MODEL } from "./mistral.ts";
import { createOpenAIProvider } from "./openai.ts";
import type { Provider } from "./types.ts";
import { registerProviderName, unregisterProviderName } from "../selectors.ts";
import { resolveSettings, validateResolvedSettings, type SettingsStore } from "../settings.ts";

/** A provider factory resolves its own models/keys from the store (via resolveSettings). */
export type ProviderFactory = (store: SettingsStore | null) => Provider;

const DEFAULT_PROVIDER = "mistral";

const factories = new Map<string, ProviderFactory>([
  [
    "mistral",
    (store) => {
      const settings = resolveSettings(store, false);
      return createMistralProvider({
        chat: settings.chatModel.value,
        embed: settings.embedModel.value,
        transcribe: settings.transcribeModel.value,
      });
    },
  ],
  [
    "openai",
    (store) => {
      const settings = resolveSettings(store, false);
      return createOpenAIProvider({
        chatModel: settings.chatModel.value,
        embedModel: settings.embedModel.value,
        transcribeModel: settings.transcribeModel.value,
        baseUrl: settings.openaiBaseUrl.value,
      });
    },
  ],
]);

const warnedMissing = new Set<string>();

/** Extensions add providers to the live registry (also registers the name for settings validation). */
export function registerProvider(name: string, factory: ProviderFactory): () => void {
  if (factories.has(name)) throw new Error(`provider already registered: ${name}`);
  factories.set(name, factory);
  registerProviderName(name);
  selected = null;
  return () => {
    if (factories.get(name) !== factory) return;
    factories.delete(name);
    unregisterProviderName(name);
    selected = null;
  };
}

let selected: Provider | null = null;
let settingsStore: SettingsStore | null = null;

function withProvider(store: SettingsStore | null, provider: string): SettingsStore {
  return {
    getMeta(key) {
      return key === "provider" ? provider : store?.getMeta(key) ?? null;
    },
  };
}

export function getProvider(store?: SettingsStore): Provider {
  if (store && store !== settingsStore) {
    settingsStore = store;
    selected = null;
  }
  if (selected) return selected;
  const configured = resolveSettings(settingsStore, false);
  let factory = factories.get(configured.provider.value);
  let effectiveStore = settingsStore;
  if (!factory) {
    if (!warnedMissing.has(configured.provider.value)) {
      warnedMissing.add(configured.provider.value);
      console.error(`[boucle] unknown provider "${configured.provider.value}"; falling back to ${DEFAULT_PROVIDER}.`);
    }
    factory = factories.get(DEFAULT_PROVIDER)!;
    effectiveStore = withProvider(settingsStore, DEFAULT_PROVIDER);
  }
  validateResolvedSettings(resolveSettings(effectiveStore, false));
  selected = factory(effectiveStore);
  return selected;
}

export function invalidateProvider(): void {
  selected = null;
}

export function getEmbeddingModel(): string | null {
  const provider = getProvider();
  // Only the OpenAI-compatible providers expose a concrete embed model name.
  const embedModel = (provider as { embedModel?: string | null }).embedModel;
  return embedModel ?? null;
}

export function getLegacyEmbeddingModel(): string {
  return LEGACY_EMBED_MODEL;
}
