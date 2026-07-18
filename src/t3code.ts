/**
 * t3code client — spawns agent chats in a stock t3code via its HTTP API.
 *
 * Flow (all over POST /api/orchestration/dispatch with a Bearer token):
 *   thread.create  → thread.turn.start (ticket context as the first user message)
 * t3code stays unmodified; we only call its public orchestration API.
 */
import { randomUUID } from "node:crypto";

import type { BoucleStore } from "./store.ts";
import { type T3CodeConfig, t3codeConfigFromEnv } from "./config.ts";

export interface SpawnResult {
  readonly threadId: string;
  readonly project: string;
  readonly openUrl: string;
}

/**
 * Fallback env id if the descriptor can't be read. Thread deep links are
 * `/{environmentId}/{threadId}`; the real env id is a per-install UUID exposed
 * at /.well-known/t3/environment (persisted server-side, stable across restarts).
 */
const T3CODE_FALLBACK_ENVIRONMENT_ID = "primary";

// Cache the env id per baseUrl (stable for the t3code install); only cache on success.
let cachedEnvId: { readonly baseUrl: string; readonly id: string } | null = null;

/** Resolve t3code's environment id (the UUID used in thread URLs). */
export async function fetchT3CodeEnvironmentId(cfg: T3CodeConfig): Promise<string> {
  if (cachedEnvId !== null && cachedEnvId.baseUrl === cfg.baseUrl) return cachedEnvId.id;
  try {
    const res = await fetch(`${cfg.baseUrl}/.well-known/t3/environment`, {
      headers: { authorization: `Bearer ${cfg.token}` },
    });
    if (res.ok) {
      const body = (await res.json()) as { environmentId?: string };
      if (typeof body.environmentId === "string" && body.environmentId.length > 0) {
        cachedEnvId = { baseUrl: cfg.baseUrl, id: body.environmentId };
        return body.environmentId;
      }
    }
  } catch {
    // fall through to the fallback id; do not cache failures so we retry later
  }
  return T3CODE_FALLBACK_ENVIRONMENT_ID;
}

/** Deep link that opens a specific thread (not the empty t3code root). */
function threadDeepLink(baseUrl: string, environmentId: string, threadId: string): string {
  return `${baseUrl}/${environmentId}/${threadId}`;
}

interface SnapshotProject {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly defaultModelSelection: { readonly instanceId: string; readonly model: string } | null;
  readonly deletedAt: string | null;
}

interface ModelSelection {
  readonly instanceId: string;
  readonly model: string;
  readonly options?: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>;
}

/** Read the t3code connection from boucle_meta (UI-configurable) then env. */
export function getT3CodeConfig(store: BoucleStore): T3CodeConfig | null {
  const baseUrl = (store.getMeta("t3codeUrl") ?? "").trim();
  const token = (store.getMeta("t3codeToken") ?? "").trim();
  if (baseUrl.length > 0 && token.length > 0) {
    return { baseUrl: baseUrl.replace(/\/$/, ""), token };
  }
  return t3codeConfigFromEnv();
}

function normalizeSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function projectSlug(p: SnapshotProject): string {
  const base = p.workspaceRoot.split("/").findLast((s) => s.length > 0) ?? p.title;
  return normalizeSlug(base);
}

function matchProject(projects: SnapshotProject[], target: string | null): SnapshotProject | null {
  if (target === null || target.trim() === "") return null;
  const want = normalizeSlug(target);
  if (want === "") return null;
  const active = projects.filter((p) => p.deletedAt === null);
  const scored = active.map((p) => ({ p, slug: projectSlug(p) }));
  return (
    scored.find((e) => e.slug === want)?.p ??
    scored.find((e) => e.slug.includes(want) || want.includes(e.slug))?.p ??
    null
  );
}

async function dispatch(cfg: T3CodeConfig, command: unknown): Promise<void> {
  const res = await fetch(`${cfg.baseUrl}/api/orchestration/dispatch`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cfg.token}` },
    body: JSON.stringify(command),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`t3code dispatch failed (${res.status}): ${detail.slice(0, 200)}`);
  }
}

export interface SpawnInput {
  /** t3code folder/project to open the chat in (always the default, e.g. "dataiku"). */
  readonly defaultProject: string;
  readonly title: string;
  readonly prompt: string;
  readonly modelSelection?: ModelSelection;
}

export interface ContinueInput {
  readonly threadId: string;
  readonly title: string;
  readonly prompt: string;
}

/**
 * Model every spawned chat opens with, overriding the t3code project's own
 * default: Claude Opus 4.8, reasoning effort "high", fast mode off ("normal").
 */
const DEFAULT_SPAWN_MODEL_SELECTION = {
  instanceId: "claudeAgent",
  model: "claude-opus-4-8",
  options: [
    { id: "effort", value: "high" },
    { id: "fastMode", value: false },
  ],
} as const;

export async function spawnT3CodeChat(cfg: T3CodeConfig, input: SpawnInput): Promise<SpawnResult> {
  const snapRes = await fetch(`${cfg.baseUrl}/api/orchestration/snapshot`, {
    headers: { authorization: `Bearer ${cfg.token}` },
  });
  if (!snapRes.ok) {
    throw new Error(`t3code snapshot failed (${snapRes.status}). Check the URL and token.`);
  }
  const snapshot = (await snapRes.json()) as { projects: SnapshotProject[] };
  // Always open in the default folder (e.g. "dataiku"), regardless of the ticket's project.
  const project = matchProject(snapshot.projects, input.defaultProject);
  if (project === null) {
    throw new Error(
      `No t3code project matches the default "${input.defaultProject}". Open that folder in t3code first.`,
    );
  }

  const threadId = randomUUID();
  await dispatch(cfg, {
    type: "thread.create",
    commandId: randomUUID(),
    threadId,
    projectId: project.id,
    title: input.title,
    modelSelection: input.modelSelection ?? DEFAULT_SPAWN_MODEL_SELECTION,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: new Date().toISOString(),
  });
  await dispatch(cfg, {
    type: "thread.turn.start",
    commandId: randomUUID(),
    threadId,
    message: { messageId: randomUUID(), role: "user", text: input.prompt, attachments: [] },
    titleSeed: input.title,
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: new Date().toISOString(),
  });

  const environmentId = await fetchT3CodeEnvironmentId(cfg);
  return {
    threadId,
    project: project.title,
    openUrl: threadDeepLink(cfg.baseUrl, environmentId, threadId),
  };
}

export async function continueT3CodeChat(cfg: T3CodeConfig, input: ContinueInput): Promise<SpawnResult> {
  await dispatch(cfg, {
    type: "thread.turn.start",
    commandId: randomUUID(),
    threadId: input.threadId,
    message: { messageId: randomUUID(), role: "user", text: input.prompt, attachments: [] },
    titleSeed: input.title,
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: new Date().toISOString(),
  });

  const environmentId = await fetchT3CodeEnvironmentId(cfg);
  return {
    threadId: input.threadId,
    project: "",
    openUrl: threadDeepLink(cfg.baseUrl, environmentId, input.threadId),
  };
}
