/**
 * Boucle identity — the app/owner/org names shown in the UI and woven into agent
 * prompts. Configurable via env; demoMode is derived (true when the resolved brain
 * dir is the bundled <repo>/fake-brain), not its own var, and unlocks in-character
 * defaults so the bundled demo dataset stays coherent out of the box.
 */
import { resolve, join } from "node:path";
import { resolveBrainDir } from "./config.ts";
import { resolveIdentitySettings, type SettingsStore } from "./settings.ts";

export interface Identity {
  readonly appName: string; // BOUCLE_APP_NAME, default "Boucle"
  readonly ownerName: string; // BOUCLE_OWNER_NAME
  readonly orgName: string; // BOUCLE_ORG_NAME
  readonly demoMode: boolean;
}

const REPO_ROOT = resolve(import.meta.dirname, "..");
const FAKE_BRAIN_DIR = join(REPO_ROOT, "fake-brain");

function isDemoMode(): boolean {
  return resolve(resolveBrainDir()) === FAKE_BRAIN_DIR;
}

let settingsStore: SettingsStore | null = null;
let cachedIdentity: Identity | null = null;

export function getIdentity(store?: SettingsStore): Identity {
  if (store && store !== settingsStore) {
    settingsStore = store;
    cachedIdentity = null;
  }
  if (cachedIdentity) return cachedIdentity;
  const demoMode = isDemoMode();
  const settings = resolveIdentitySettings(settingsStore, demoMode);
  cachedIdentity = {
    appName: settings.appName.value,
    ownerName: settings.ownerName.value,
    orgName: settings.orgName.value,
    demoMode,
  };
  return cachedIdentity;
}

export function invalidateIdentity(): void {
  cachedIdentity = null;
}
