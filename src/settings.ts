// Shared meta -> environment -> default resolution for UI-configurable settings.

import { isKnownProviderName, isKnownRunnerName, knownProviderNames, knownRunnerNames } from "./selectors.ts";

export type SettingSource = "meta" | "env" | "default";
// Widened to string in the extension phase: providers and runners can be contributed
// by extensions, so the valid set is the live registry (selectors.ts), not a literal union.
export type ProviderName = string;
export type RunnerName = string;

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
  // Normalize only — membership is validated against the live registry at the point of
  // use (getAgentRunner degrades a since-removed extension runner to the default rather
  // than crashing the boot). An empty meta value falls back to the default.
  const raw = stringSetting(store, "runner", "BOUCLE_RUNNER", "vibe");
  return { value: raw.value.toLowerCase() || "vibe", source: raw.source };
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
  // Normalize only; getProvider degrades an unknown/removed provider to the default.
  const provider: ResolvedSetting<ProviderName> = {
    value: rawProvider.value.toLowerCase() || "mistral",
    source: rawProvider.source,
  };
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
  // Validate against the live registries so extension-contributed providers/runners are
  // accepted, while typos are still rejected with the current set of valid names.
  if (typeof update.provider === "string" && !isKnownProviderName(update.provider)) {
    throw new Error(`provider must be one of: ${knownProviderNames().join(", ")}.`);
  }
  if (typeof update.runner === "string" && !isKnownRunnerName(update.runner)) {
    throw new Error(`runner must be one of: ${knownRunnerNames().join(", ")}.`);
  }
  return update;
}

export function validateResolvedSettings(settings: ResolvedSettings): void {
  if (!settings.appName.value) throw new Error("appName is required.");
  if (settings.provider.value === "openai" && !settings.chatModel.value) {
    throw new Error("BOUCLE_CHAT_MODEL is required when BOUCLE_PROVIDER=openai.");
  }
  if (settings.provider.value === "mistral" && !settings.chatModel.value) throw new Error("chatModel is required.");
  if (settings.provider.value === "openai" && !settings.openaiBaseUrl.value) {
    throw new Error("openaiBaseUrl is required when provider=openai.");
  }
}
