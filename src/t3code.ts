/** t3code orchestration client for spawning interactive chats in the user's own t3code. */
import { randomUUID } from "node:crypto";

import { resolveT3CodeSettings, type SettingsStore } from "./settings.ts";

export interface T3CodeConfig {
  readonly baseUrl: string;
  readonly token: string;
  readonly defaultProject: string;
}

export interface T3CodeSpawnResult {
  readonly threadId: string;
  readonly project: string;
  readonly openUrl: string;
}

interface SnapshotProject {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly deletedAt: string | null;
}

interface ModelSelection {
  readonly instanceId: string;
  readonly model: string;
  readonly options?: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>;
}

export interface SpawnT3CodeInput {
  readonly title: string;
  readonly prompt: string;
  readonly modelSelection?: ModelSelection;
}

const T3CODE_FALLBACK_ENVIRONMENT_ID = "primary";

/** Shipped t3code default for new chats. Keep this explicit so upgrades are intentional. */
const DEFAULT_SPAWN_MODEL_SELECTION = {
  instanceId: "claudeAgent",
  model: "claude-opus-4-8",
  options: [
    { id: "effort", value: "high" },
    { id: "fastMode", value: false },
  ],
} as const;

let cachedEnvId: { readonly baseUrl: string; readonly id: string } | null = null;

async function fetchT3Code(cfg: T3CodeConfig, path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${cfg.baseUrl}${path}`, init);
  } catch {
    throw new Error(`t3code unreachable at ${cfg.baseUrl}: check the URL and token`);
  }
}

/** Resolve t3code through boucle_meta first, then environment. URL + token enable the integration. */
export function getT3CodeConfig(store: SettingsStore | null): T3CodeConfig | null {
  const settings = resolveT3CodeSettings(store);
  const baseUrl = settings.t3codeUrl.value.replace(/\/+$/, "");
  const token = settings.t3codeToken.value;
  const defaultProject = settings.t3codeProject.value;
  if (!baseUrl || !token) return null;
  return { baseUrl, token, defaultProject };
}

export async function fetchT3CodeEnvironmentId(cfg: T3CodeConfig): Promise<string> {
  if (cachedEnvId?.baseUrl === cfg.baseUrl) return cachedEnvId.id;
  try {
    const response = await fetchT3Code(cfg, "/.well-known/t3/environment", {
      headers: { authorization: `Bearer ${cfg.token}` },
    });
    if (response.ok) {
      const body = (await response.json()) as { environmentId?: unknown };
      if (typeof body.environmentId === "string" && body.environmentId) {
        cachedEnvId = { baseUrl: cfg.baseUrl, id: body.environmentId };
        return body.environmentId;
      }
    }
  } catch {
    // Retry discovery on the next spawn; the fallback remains usable meanwhile.
  }
  return T3CODE_FALLBACK_ENVIRONMENT_ID;
}

function normalizeSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function projectSlug(project: SnapshotProject): string {
  const folder = project.workspaceRoot.split("/").findLast((part) => part.length > 0);
  return normalizeSlug(folder ?? project.title);
}

function matchProject(projects: readonly SnapshotProject[], target: string): SnapshotProject | null {
  const wanted = normalizeSlug(target);
  if (!wanted) return null;
  const candidates = projects
    .filter((project) => project.deletedAt === null)
    .map((project) => ({ project, slug: projectSlug(project) }));
  return candidates.find((candidate) => candidate.slug === wanted)?.project
    ?? candidates.find((candidate) => candidate.slug.includes(wanted) || wanted.includes(candidate.slug))?.project
    ?? null;
}

async function dispatch(cfg: T3CodeConfig, command: unknown): Promise<void> {
  const response = await fetchT3Code(cfg, "/api/orchestration/dispatch", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cfg.token}` },
    body: JSON.stringify(command),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`t3code dispatch failed (${response.status}): ${detail.slice(0, 200)}`);
  }
}

export async function spawnT3CodeChat(cfg: T3CodeConfig, input: SpawnT3CodeInput): Promise<T3CodeSpawnResult> {
  if (!cfg.defaultProject) {
    throw new Error("BOUCLE_T3CODE_PROJECT is required before spawning a t3code chat.");
  }
  const snapshotResponse = await fetchT3Code(cfg, "/api/orchestration/snapshot", {
    headers: { authorization: `Bearer ${cfg.token}` },
  });
  if (!snapshotResponse.ok) {
    throw new Error(`t3code snapshot failed (${snapshotResponse.status}). Check the URL and token.`);
  }
  const snapshot = (await snapshotResponse.json()) as { projects?: SnapshotProject[] };
  const project = matchProject(snapshot.projects ?? [], cfg.defaultProject);
  if (!project) {
    throw new Error(`No t3code project matches "${cfg.defaultProject}". Open that folder in t3code first.`);
  }

  const threadId = randomUUID();
  const createdAt = new Date().toISOString();
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
    createdAt,
  });
  await dispatch(cfg, {
    type: "thread.turn.start",
    commandId: randomUUID(),
    threadId,
    message: { messageId: randomUUID(), role: "user", text: input.prompt, attachments: [] },
    titleSeed: input.title,
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt,
  });

  const environmentId = await fetchT3CodeEnvironmentId(cfg);
  return {
    threadId,
    project: project.title,
    openUrl: `${cfg.baseUrl}/${environmentId}/${threadId}`,
  };
}
