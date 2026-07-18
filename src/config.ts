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

/**
 * Startup instructions appended to every chat Boucle spawns in t3code. Scoped to
 * spawned chats only (not a global rule): gather gbrain context first, then pause
 * before any outbound Slack message or any push to Dataiku DSS.
 */
export const SPAWNED_CHAT_GUARDRAILS = `Before anything else, on this first turn:
- Context: gather gbrain context before acting. Run \`gbrain search\` for this ticket's topic, project, and requester (then \`gbrain get <slug>\` on the relevant hits) so you work from current project knowledge instead of assumptions. The brain files are current; your memory of them is not.

Then, two hard rules for the rest of this conversation:
- Slack: do NOT send any Slack message (channel post, thread reply, DM, scheduled message, draft→send) without Loris's explicit approval first. Reading, searching, and drafting are fine — show the target channel/person and the exact text, then wait for his go-ahead.
- Dataiku: do NOT push anything to any Dataiku DSS instance (Design or Prod) without Loris's explicit approval first. This includes redeploying/restarting webapps, pushing plugins, committing project changes, creating/editing agents or agent tools, running data-writing scenarios, and SQL DML/DDL/COMMIT. Reading, inspecting, and dry-runs are fine — say exactly what will change on which instance, then wait for his go-ahead. Exception: writing to Loris's scratch sandbox (COMMUNITY.LORIS_SANDBOX on EDP_SNOWFLAKE) is fine without approval.`;

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
