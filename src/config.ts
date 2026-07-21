import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Identity } from "./identity.ts";
import { getProvider } from "./providers/index.ts";

// Boucle server config: env-driven paths and constants (port, DB, brain dir, guardrails).
// Loaded from .env at the repo root when present, else from the process environment.
const REPO_ROOT = resolve(import.meta.dirname, "..");

try {
  process.loadEnvFile(join(REPO_ROOT, ".env"));
} catch {
  // no .env — configuration comes from the process environment
}

function defaultDbDir(): string {
  const xdg = (process.env.XDG_DATA_HOME ?? "").trim();
  return xdg.length > 0 ? join(xdg, "boucle") : join(homedir(), ".local", "share", "boucle");
}

const LEGACY_DB_PATH = join(homedir(), ".mistral-boucle", "boucle.db");

/** DB path: explicit arg | $BOUCLE_DB | $XDG_DATA_HOME/boucle/boucle.db (dir created). */
export function resolveDbPath(explicit?: string | undefined): string {
  const candidate = (explicit ?? process.env.BOUCLE_DB ?? "").trim();
  const path = candidate.length > 0 ? candidate : join(defaultDbDir(), "boucle.db");
  if (candidate.length === 0 && !existsSync(path) && existsSync(LEGACY_DB_PATH)) {
    process.stdout.write(`[boucle] found a legacy DB at ${LEGACY_DB_PATH}; set BOUCLE_DB to keep using it.\n`);
  }
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

export const BOUCLE_PORT = Number.parseInt(process.env.BOUCLE_PORT ?? "4419", 10);

/**
 * Extension search dirs, in load order: bundled examples (ship enabled), then the
 * user dir ($BOUCLE_EXTENSIONS_DIR, default $XDG_DATA_HOME/boucle/extensions).
 */
export function resolveExtensionDirs(): string[] {
  const bundled = join(REPO_ROOT, "extensions");
  const external = (process.env.BOUCLE_EXTENSIONS_DIR ?? "").trim();
  return [bundled, external.length > 0 ? external : join(defaultDbDir(), "extensions")];
}

/** The brain root — `$BOUCLE_BRAIN_DIR ?? <repo>/fake-brain` (the bundled demo dataset). */
export function resolveBrainDir(): string {
  const base = (process.env.BOUCLE_BRAIN_DIR ?? "").trim();
  return base.length > 0 ? base : join(REPO_ROOT, "fake-brain");
}

/**
 * The gbrain `meetings/` folder — where the native Boucle recorder drops raw
 * transcripts and the Meetings loop rewrites them into curated notes.
 */
export function resolveMeetingsDir(): string {
  return join(resolveBrainDir(), "meetings");
}

/** Startup instructions appended to every provider conversation Boucle spawns. */
export function spawnedChatGuardrails(identity: Identity): string {
  const brainRef = identity.demoMode ? "fake-brain/" : "the brain";
  const knowledgeRef = identity.orgName ? `current ${identity.orgName} knowledge` : "current knowledge";
  const approver = identity.ownerName ? `${identity.ownerName}'s explicit approval` : "explicit approval from the owner";
  const prodScope = identity.orgName ? ` in ${identity.orgName}'s production environment` : "";
  return `Before anything else, on this first turn:
- Context: read the relevant files in ${brainRef} for this ticket's topic, project, requester, and recent meetings so you work from ${knowledgeRef} instead of assumptions.

Then, two hard rules for the rest of this conversation:
- Outbound communication: do NOT send a channel post, thread reply, email, direct message, invitation, or scheduled message without ${approver}. Reading and drafting are fine; show the destination and exact text, then wait.
- Production changes: do NOT deploy, restart, publish, migrate, alter production data, or run a data-writing job${prodScope} without ${approver}. Inspection and dry-runs are fine; state exactly what will change and where, then wait.`;
}

/** Provider configuration state; credentials are never returned to the web UI or persisted. */
export function isProviderConfigured(): boolean {
  return getProvider().isConfigured();
}
