// Shared meta -> environment -> default resolution for UI-configurable settings.

export type SettingSource = "meta" | "env" | "default";
export type ProviderName = "mistral" | "openai";
export type RunnerName = "vibe" | "codex" | "claude" | "t3code";

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
  readonly runner: ResolvedSetting<RunnerName>;
  readonly t3codeUrl: ResolvedSetting<string>;
  readonly t3codeToken: ResolvedSetting<string>;
  readonly t3codeProject: ResolvedSetting<string>;
}

export interface ResolvedIdentitySettings {
  readonly appName: ResolvedSetting<string>;
  readonly ownerName: ResolvedSetting<string>;
  readonly orgName: ResolvedSetting<string>;
}

export interface ResolvedT3CodeSettings {
  readonly t3codeUrl: ResolvedSetting<string>;
  readonly t3codeToken: ResolvedSetting<string>;
  readonly t3codeProject: ResolvedSetting<string>;
}

export const CONFIGURABLE_SETTING_KEYS = [
  "ownerName",
  "orgName",
  "provider",
  "chatModel",
  "embedModel",
  "transcribeModel",
  "openaiBaseUrl",
  "runner",
  "t3codeUrl",
  "t3codeToken",
  "t3codeProject",
] as const;

export type ConfigurableSettingKey = (typeof CONFIGURABLE_SETTING_KEYS)[number];
export type SettingsUpdate = Partial<Record<ConfigurableSettingKey, string | null>>;

function envOnlySetting(envName: string, fallback: string): ResolvedSetting<string> {
  const env = process.env[envName];
  if (env !== undefined && env.trim().length > 0) return { value: env.trim(), source: "env" };
  return { value: fallback, source: "default" };
}

function stringSetting(store: SettingsStore | null, key: string, envName: string, fallback: string): ResolvedSetting<string> {
  const meta = store?.getMeta(key);
  if (meta !== null && meta !== undefined) return { value: meta.trim(), source: "meta" };
  const env = process.env[envName];
  if (env !== undefined && env.trim().length > 0) return { value: env.trim(), source: "env" };
  return { value: fallback, source: "default" };
}

export function resolveRunnerSetting(store: SettingsStore | null): ResolvedSetting<RunnerName> {
  const raw = stringSetting(store, "runner", "BOUCLE_RUNNER", "vibe");
  const value = raw.value.toLowerCase();
  if (value !== "vibe" && value !== "codex" && value !== "claude" && value !== "t3code") {
    throw new Error(`Unsupported BOUCLE_RUNNER: ${value || "(empty)"}.`);
  }
  return { value, source: raw.source };
}

export function resolveIdentitySettings(store: SettingsStore | null, demoMode: boolean): ResolvedIdentitySettings {
  return {
    // App name is env-only (BOUCLE_APP_NAME): renaming the product is an install
    // decision, not a runtime setting, so meta overrides are ignored.
    appName: envOnlySetting("BOUCLE_APP_NAME", "Boucle"),
    ownerName: stringSetting(store, "ownerName", "BOUCLE_OWNER_NAME", demoMode ? "Nora Bellier" : ""),
    orgName: stringSetting(store, "orgName", "BOUCLE_ORG_NAME", demoMode ? "Brumeline" : ""),
  };
}

export function resolveT3CodeSettings(store: SettingsStore | null): ResolvedT3CodeSettings {
  return {
    t3codeUrl: stringSetting(store, "t3codeUrl", "BOUCLE_T3CODE_URL", ""),
    t3codeToken: stringSetting(store, "t3codeToken", "BOUCLE_T3CODE_TOKEN", ""),
    t3codeProject: stringSetting(store, "t3codeProject", "BOUCLE_T3CODE_PROJECT", ""),
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
  const runner = resolveRunnerSetting(store);
  const mistral = provider.value === "mistral";
  return {
    ...identity,
    ...resolveT3CodeSettings(store),
    provider,
    chatModel: stringSetting(store, "chatModel", "BOUCLE_CHAT_MODEL", mistral ? "mistral-medium-3.5" : ""),
    embedModel: stringSetting(store, "embedModel", "BOUCLE_EMBED_MODEL", mistral ? "mistral-embed" : "text-embedding-3-small"),
    transcribeModel: stringSetting(store, "transcribeModel", "BOUCLE_TRANSCRIBE_MODEL", mistral ? "voxtral-mini-latest" : "whisper-1"),
    openaiBaseUrl: stringSetting(store, "openaiBaseUrl", "OPENAI_BASE_URL", "https://api.openai.com/v1"),
    runner,
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
    if (field === null) {
      update[key as ConfigurableSettingKey] = null;
      continue;
    }
    if (typeof field !== "string") throw new Error(`${key} must be a string.`);
    update[key as ConfigurableSettingKey] = field.trim();
  }
  if (typeof update.provider === "string") update.provider = update.provider.toLowerCase();
  if (typeof update.runner === "string") update.runner = update.runner.toLowerCase();
  if (update.provider !== undefined && update.provider !== null && update.provider !== "mistral" && update.provider !== "openai") {
    throw new Error("provider must be one of: mistral, openai.");
  }
  if (update.runner !== undefined && update.runner !== null && update.runner !== "vibe" && update.runner !== "codex" && update.runner !== "claude") {
    throw new Error("runner must be one of: vibe, codex, claude.");
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
