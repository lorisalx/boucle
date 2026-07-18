import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

// mistral-boucle runs side-by-side with real Boucle: its own port, DB, and a
// synthetic brain. Nothing here may ever point at the real brain or real DB.
const REPO_ROOT = resolve(import.meta.dirname, "..");

try {
  process.loadEnvFile(join(REPO_ROOT, ".env"));
} catch {
  // no .env — MISTRAL_API_KEY must come from the environment
}

const REAL_BRAIN_DIR = join(homedir(), "Documents", "dataiku", "brain");
const REAL_BOUCLE_DIR = join(homedir(), ".boucle");

function forbid(path: string, forbiddenRoot: string, what: string): void {
  const p = resolve(path);
  if (p === forbiddenRoot || p.startsWith(forbiddenRoot + "/")) {
    throw new Error(
      `mistral-boucle refuses to boot: ${what} resolves to ${p}, inside the real ${forbiddenRoot}. ` +
        `This instance must stay fully synthetic.`,
    );
  }
}

/** DB path: explicit arg | $BOUCLE_DB | ~/.mistral-boucle/boucle.db (dir created). */
export function resolveDbPath(explicit?: string | undefined): string {
  const candidate = (explicit ?? process.env.BOUCLE_DB ?? "").trim();
  const path = candidate.length > 0 ? candidate : join(homedir(), ".mistral-boucle", "boucle.db");
  forbid(path, REAL_BOUCLE_DIR, "the DB path");
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

export const BOUCLE_PORT = Number.parseInt(process.env.BOUCLE_PORT ?? "4419", 10);

/**
 * The synthetic brain root — `$BOUCLE_BRAIN_DIR ?? <repo>/fake-brain`. Guarded so it
 * can never resolve inside the real gbrain.
 */
export function resolveBrainDir(): string {
  const base = (process.env.BOUCLE_BRAIN_DIR ?? "").trim();
  const dir = base.length > 0 ? base : join(REPO_ROOT, "fake-brain");
  forbid(dir, REAL_BRAIN_DIR, "the brain dir");
  return dir;
}

/**
 * The gbrain `meetings/` folder — where the native Boucle recorder drops raw
 * transcripts and the Meetings loop rewrites them into curated notes.
 */
export function resolveMeetingsDir(): string {
  return join(resolveBrainDir(), "meetings");
}

/** Startup instructions appended to every chat Boucle spawns in t3code. */
export const SPAWNED_CHAT_GUARDRAILS = `Before anything else, on this first turn:
- Context: read the relevant files in fake-brain/ for this ticket's topic, project, requester, and recent meetings so you work from current Brumeline knowledge instead of assumptions.

Then, two hard rules for the rest of this conversation:
- Outbound communication: do NOT send a channel post, thread reply, email, direct message, invitation, or scheduled message without Nora Bellier's explicit approval. Reading and drafting are fine; show the destination and exact text, then wait.
- Production changes: do NOT deploy, restart, publish, migrate, alter production data, or run a data-writing job in Brumeline's production environment without Nora Bellier's explicit approval. Inspection and dry-runs are fine; state exactly what will change and where, then wait.`;

export interface T3CodeConfig {
  readonly baseUrl: string;
  readonly token: string;
}

/** t3code connection for spawning chats. Configured via env or stored in boucle_meta. */
export function t3codeConfigFromEnv(): T3CodeConfig | null {
  const baseUrl = (process.env.BOUCLE_T3CODE_URL ?? "").trim();
  const token = (process.env.BOUCLE_T3CODE_TOKEN ?? "").trim();
  if (baseUrl.length === 0 || token.length === 0) return null;
  return { baseUrl: baseUrl.replace(/\/$/, ""), token };
}
