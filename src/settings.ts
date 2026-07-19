// Shared meta -> environment -> default resolution for UI-configurable settings.

export type SettingSource = "meta" | "env" | "default";
export type ProviderName = "mistral" | "openai";

export interface SettingsStore {
  getMeta(key: string): string | null;
}

export interface ResolvedSetting<T> {
  readonly value: T;
  readonly source: SettingSource;
}

export interface ResolvedSettings {
  readonly appName: ResolvedSetting<string>;
  readonly ownerName: ResolvedSetting<string>;
  readonly orgName: ResolvedSetting<string>;
  readonly provider: ResolvedSetting<ProviderName>;
  readonly chatModel: ResolvedSetting<string>;
  readonly embedModel: ResolvedSetting<string>;
  readonly transcribeModel: ResolvedSetting<string>;
  readonly openaiBaseUrl: ResolvedSetting<string>;
}

export interface ResolvedIdentitySettings {
  readonly appName: ResolvedSetting<string>;
  readonly ownerName: ResolvedSetting<string>;
  readonly orgName: ResolvedSetting<string>;
}

export const CONFIGURABLE_SETTING_KEYS = [
  "appName",
  "ownerName",
  "orgName",
  "provider",
  "chatModel",
  "embedModel",
  "transcribeModel",
  "openaiBaseUrl",
] as const;

export type ConfigurableSettingKey = (typeof CONFIGURABLE_SETTING_KEYS)[number];
export type SettingsUpdate = Partial<Record<ConfigurableSettingKey, string>>;

function stringSetting(store: SettingsStore | null, key: string, envName: string, fallback: string): ResolvedSetting<string> {
  const meta = store?.getMeta(key);
  if (meta !== null && meta !== undefined) return { value: meta.trim(), source: "meta" };
  const env = process.env[envName];
  if (env !== undefined && env.trim().length > 0) return { value: env.trim(), source: "env" };
  return { value: fallback, source: "default" };
}

export function resolveIdentitySettings(store: SettingsStore | null, demoMode: boolean): ResolvedIdentitySettings {
  return {
    appName: stringSetting(store, "appName", "BOUCLE_APP_NAME", "Boucle"),
    ownerName: stringSetting(store, "ownerName", "BOUCLE_OWNER_NAME", demoMode ? "Nora Bellier" : ""),
    orgName: stringSetting(store, "orgName", "BOUCLE_ORG_NAME", demoMode ? "Brumeline" : ""),
  };
}

export function resolveSettings(store: SettingsStore | null, demoMode: boolean): ResolvedSettings {
  const identity = resolveIdentitySettings(store, demoMode);
  const rawProvider = stringSetting(store, "provider", "BOUCLE_PROVIDER", "mistral");
  const providerValue = rawProvider.value.toLowerCase();
  if (providerValue !== "mistral" && providerValue !== "openai") {
    throw new Error(`Unsupported BOUCLE_PROVIDER: ${providerValue || "(empty)"}.`);
  }
  const provider: ResolvedSetting<ProviderName> = { value: providerValue, source: rawProvider.source };
  const mistral = provider.value === "mistral";
  return {
    ...identity,
    provider,
    chatModel: stringSetting(store, "chatModel", "BOUCLE_CHAT_MODEL", mistral ? "mistral-medium-3.5" : ""),
    embedModel: stringSetting(store, "embedModel", "BOUCLE_EMBED_MODEL", mistral ? "mistral-embed" : "text-embedding-3-small"),
    transcribeModel: stringSetting(store, "transcribeModel", "BOUCLE_TRANSCRIBE_MODEL", mistral ? "voxtral-mini-latest" : "whisper-1"),
    openaiBaseUrl: stringSetting(store, "openaiBaseUrl", "OPENAI_BASE_URL", "https://api.openai.com/v1"),
  };
}

export function settingsWithUpdate(store: SettingsStore, update: SettingsUpdate, demoMode: boolean): ResolvedSettings {
  const overlay: SettingsStore = {
    getMeta(key) {
      if (Object.hasOwn(update, key)) return update[key as ConfigurableSettingKey] ?? null;
      return store.getMeta(key);
    },
  };
  return resolveSettings(overlay, demoMode);
}

export function parseSettingsUpdate(value: unknown): SettingsUpdate {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("settings body must be an object");
  }
  const allowed = new Set<string>(CONFIGURABLE_SETTING_KEYS);
  const update: SettingsUpdate = {};
  for (const [key, field] of Object.entries(value)) {
    if (!allowed.has(key)) throw new Error(`Unsupported setting: ${key}.`);
    if (typeof field !== "string") throw new Error(`${key} must be a string.`);
    update[key as ConfigurableSettingKey] = field.trim();
  }
  if (update.provider !== undefined && update.provider !== "mistral" && update.provider !== "openai") {
    throw new Error("provider must be one of: mistral, openai.");
  }
  return update;
}

export function validateResolvedSettings(settings: ResolvedSettings): void {
  if (!settings.appName.value) throw new Error("appName is required.");
  if (settings.provider.value === "openai" && !settings.chatModel.value) {
    throw new Error("BOUCLE_CHAT_MODEL is required when BOUCLE_PROVIDER=openai.");
  }
  if (!settings.chatModel.value) throw new Error("chatModel is required.");
  if (settings.provider.value === "openai" && !settings.openaiBaseUrl.value) {
    throw new Error("openaiBaseUrl is required when provider=openai.");
  }
}
