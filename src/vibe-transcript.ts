import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export interface VibeTranscriptEntry {
  readonly role: "user" | "assistant" | "tool";
  readonly content: string;
  readonly toolName?: string;
}

export interface VibeTranscript {
  readonly meta: {
    readonly sessionId: string;
    readonly title: string | null;
    readonly startTime: string | null;
    readonly endTime: string | null;
    readonly costUsd: number | null;
  };
  readonly entries: VibeTranscriptEntry[];
}

interface SessionMeta {
  session_id?: unknown;
  title?: unknown;
  start_time?: unknown;
  end_time?: unknown;
  stats?: { session_cost?: unknown };
}

interface RawEntry {
  role?: unknown;
  content?: unknown;
  name?: unknown;
  tool_name?: unknown;
}

export const VIBE_SCOPE_RE = /^[a-zA-Z0-9_-]{1,160}$/;
export const VIBE_SESSION_RE = /^[a-zA-Z0-9-]{8,64}$/;

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") return "";
      const record = item as { text?: unknown; content?: unknown };
      return typeof record.text === "string"
        ? record.text
        : typeof record.content === "string"
          ? record.content
          : "";
    })
    .filter(Boolean)
    .join("\n");
}

function normalizeEntries(raw: string): VibeTranscriptEntry[] {
  const entries: VibeTranscriptEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as RawEntry;
      if (entry.role !== "user" && entry.role !== "assistant" && entry.role !== "tool") continue;
      const content = contentText(entry.content);
      if (!content.trim()) continue;
      if (entry.role === "tool") {
        const toolName = stringValue(entry.name) ?? stringValue(entry.tool_name) ?? undefined;
        entries.push({ role: "tool", content, toolName });
      } else {
        entries.push({ role: entry.role, content });
      }
    } catch {
      // Ignore partial lines while Vibe is still appending the transcript.
    }
  }
  return entries;
}

export async function readVibeTranscript(workdir: string, scope: string, sessionId: string): Promise<VibeTranscript | null> {
  if (!VIBE_SCOPE_RE.test(scope) || !VIBE_SESSION_RE.test(sessionId)) return null;

  const vibeRoot = resolve(workdir, "var", "vibe");
  const scopePath = resolve(vibeRoot, scope);
  if (!isInside(vibeRoot, scopePath)) return null;

  let realRoot: string;
  let realScope: string;
  try {
    [realRoot, realScope] = await Promise.all([realpath(vibeRoot), realpath(scopePath)]);
  } catch {
    return null;
  }
  if (!isInside(realRoot, realScope)) return null;

  const sessionRoot = resolve(realScope, "logs", "session");
  let dirs: string[];
  try {
    dirs = await readdir(sessionRoot);
  } catch {
    return null;
  }

  const candidates: Array<{ path: string; meta: SessionMeta; mtimeMs: number }> = [];
  for (const dir of dirs) {
    if (!dir.startsWith("session_")) continue;
    const candidatePath = resolve(sessionRoot, dir);
    try {
      const realCandidate = await realpath(candidatePath);
      if (!isInside(realScope, realCandidate)) continue;
      const metaPath = await realpath(resolve(realCandidate, "meta.json"));
      if (!isInside(realScope, metaPath)) continue;
      const [rawMeta, info] = await Promise.all([readFile(metaPath, "utf8"), stat(metaPath)]);
      candidates.push({ path: realCandidate, meta: JSON.parse(rawMeta) as SessionMeta, mtimeMs: info.mtimeMs });
    } catch {
      // Ignore incomplete session directories.
    }
  }

  const exact = candidates.find((candidate) => candidate.meta.session_id === sessionId);
  const selected = exact ?? candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  if (!selected) return null;

  let messages: string;
  try {
    const messagesPath = await realpath(resolve(selected.path, "messages.jsonl"));
    if (!isInside(realScope, messagesPath)) return null;
    messages = await readFile(messagesPath, "utf8");
  } catch {
    return null;
  }

  const rawCost = selected.meta.stats?.session_cost;
  return {
    meta: {
      sessionId: stringValue(selected.meta.session_id) ?? sessionId,
      title: stringValue(selected.meta.title),
      startTime: stringValue(selected.meta.start_time),
      endTime: stringValue(selected.meta.end_time),
      costUsd: typeof rawCost === "number" && Number.isFinite(rawCost) && rawCost >= 0 ? rawCost : null,
    },
    entries: normalizeEntries(messages),
  };
}
