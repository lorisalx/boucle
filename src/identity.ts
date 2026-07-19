/**
 * Boucle identity — the app/owner/org names shown in the UI and woven into agent
 * prompts. Configurable via env; demoMode is derived (true when the resolved brain
 * dir is the bundled <repo>/fake-brain), not its own var, and unlocks in-character
 * defaults so the bundled demo dataset stays coherent out of the box.
 */
import { resolve, join } from "node:path";
import { resolveBrainDir } from "./config.ts";

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

export function getIdentity(): Identity {
  const demoMode = isDemoMode();
  return {
    appName: (process.env.BOUCLE_APP_NAME ?? "").trim() || "Boucle",
    ownerName: (process.env.BOUCLE_OWNER_NAME ?? "").trim() || (demoMode ? "Nora Bellier" : ""),
    orgName: (process.env.BOUCLE_ORG_NAME ?? "").trim() || (demoMode ? "Brumeline" : ""),
    demoMode,
  };
}
