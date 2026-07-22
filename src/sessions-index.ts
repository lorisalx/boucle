import { open, readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import { parseClaudeJsonl } from "./claude.ts";
import { mapCodexRolloutEntries, parseCodexJsonl, type CodexJsonRecord } from "./codex.ts";
import type { Transcript } from "./runner.ts";

export type SessionEngine = "claude" | "codex";

export interface SessionSummary {
  engine: SessionEngine;
  sessionId: string;
  title: string | null;
  cwd: string | null;
  project: string | null;
  startedAt: string | null;
  updatedAt: string;
  filePath: string;
  sizeBytes: number;
}

export interface ListSessionsOptions {
  engine?: SessionEngine;
  q?: string;
  limit?: number;
}

const UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export const SESSION_ID_RE = new RegExp(`^${UUID_SOURCE}$`, "i");
const CODEX_FILE_RE = new RegExp(`^rollout-.+-(${UUID_SOURCE})\\.jsonl$`, "i");
const CLAUDE_HEAD_BYTES = 128 * 1024;
const CODEX_HEAD_BYTES = 16 * 1024;
const HEAD_LINES = 30;
const TITLE_LENGTH = 120;

interface HeadSummary {
  readonly sessionId: string;
  readonly title: string | null;
  readonly cwd: string | null;
  readonly startedAt: string | null;
}

interface SummaryCacheEntry {
  readonly mtimeMs: number;
  readonly sizeBytes: number;
  readonly head: HeadSummary;
}

interface TitleCacheEntry {
  readonly mtimeMs: number;
  readonly sizeBytes: number;
  readonly titles: Map<string, string>;
}

const summaryCache = new Map<string, SummaryCacheEntry>();
const titleCache = new Map<string, TitleCacheEntry>();

function claudeHome(): string {
  return resolve((process.env.BOUCLE_CLAUDE_HOME ?? "").trim() || join(homedir(), ".claude"));
}

function codexHome(): string {
  return resolve((process.env.BOUCLE_CODEX_HOME ?? "").trim() || join(homedir(), ".codex"));
}

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function stringField(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object") return null;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.trim() ? field : null;
}

function cleanTitle(value: string): string | null {
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) return null;
  return compact.length <= TITLE_LENGTH ? compact : `${compact.slice(0, TITLE_LENGTH - 1).trimEnd()}…`;
}

function projectName(cwd: string | null): string | null {
  if (!cwd) return null;
  return basename(cwd) || null;
}

function claudeContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((block) => {
    if (!block || typeof block !== "object" || stringField(block, "type") !== "text") return "";
    return stringField(block, "text") ?? "";
  }).filter(Boolean).join("\n");
}

function parseHeadLines(raw: string): unknown[] {
  const rows: unknown[] = [];
  for (const line of raw.split("\n").slice(0, HEAD_LINES)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as unknown;
      if (row && typeof row === "object") rows.push(row);
    } catch {
      // Session files can end with a partial line while an agent is writing.
    }
  }
  return rows;
}

async function readHead(path: string, bytes: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    await handle.close();
  }
}

function claudeHead(raw: string, sessionId: string): HeadSummary {
  let parsedSessionId: string | null = null;
  let cwd: string | null = null;
  let title: string | null = null;
  let startedAt: string | null = null;
  for (const value of parseHeadLines(raw)) {
    const row = value as Record<string, unknown>;
    parsedSessionId ??= stringField(row, "sessionId");
    cwd ??= stringField(row, "cwd");
    startedAt ??= stringField(row, "timestamp");
    if (title === null && row.type === "user" && row.message && typeof row.message === "object") {
      title = cleanTitle(claudeContent((row.message as Record<string, unknown>).content));
    }
  }
  return {
    sessionId: parsedSessionId && SESSION_ID_RE.test(parsedSessionId) ? parsedSessionId : sessionId,
    title,
    cwd,
    startedAt,
  };
}

function codexHead(raw: string, sessionId: string): HeadSummary {
  let parsedSessionId: string | null = null;
  let cwd: string | null = null;
  let startedAt: string | null = null;
  for (const value of parseHeadLines(raw)) {
    const row = value as Record<string, unknown>;
    if (row.type !== "session_meta") continue;
    parsedSessionId = stringField(row.payload, "session_id") ?? stringField(row.payload, "id");
    cwd = stringField(row.payload, "cwd");
    startedAt = stringField(row, "timestamp") ?? stringField(row.payload, "timestamp");
    break;
  }
  // Current Codex session_meta rows often embed large instructions after these early
  // fields. The 16 KiB listing prefix can therefore be valid-but-incomplete JSON.
  if (cwd === null && /"type"\s*:\s*"session_meta"/.test(raw)) {
    parsedSessionId = jsonStringFromPrefix(raw, "session_id") ?? jsonStringFromPrefix(raw, "id");
    cwd = jsonStringFromPrefix(raw, "cwd");
    startedAt ??= jsonStringFromPrefix(raw, "timestamp");
  }
  return {
    sessionId: parsedSessionId && SESSION_ID_RE.test(parsedSessionId) ? parsedSessionId : sessionId,
    title: null,
    cwd,
    startedAt,
  };
}

function jsonStringFromPrefix(raw: string, key: string): string | null {
  const match = new RegExp(`"${key}"\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`).exec(raw);
  if (!match?.[1]) return null;
  try {
    const value = JSON.parse(match[1]) as unknown;
    return typeof value === "string" && value.trim() ? value : null;
  } catch {
    return null;
  }
}

async function cachedHead(engine: SessionEngine, filePath: string, sessionId: string): Promise<SessionSummary | null> {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return null;
    let cached = summaryCache.get(filePath);
    if (!cached || cached.mtimeMs !== info.mtimeMs || cached.sizeBytes !== info.size) {
      const raw = await readHead(filePath, engine === "claude" ? CLAUDE_HEAD_BYTES : CODEX_HEAD_BYTES);
      cached = {
        mtimeMs: info.mtimeMs,
        sizeBytes: info.size,
        head: engine === "claude" ? claudeHead(raw, sessionId) : codexHead(raw, sessionId),
      };
      summaryCache.set(filePath, cached);
    }
    return {
      engine,
      sessionId: cached.head.sessionId,
      title: cached.head.title,
      cwd: cached.head.cwd,
      project: projectName(cached.head.cwd),
      startedAt: cached.head.startedAt,
      updatedAt: new Date(info.mtimeMs).toISOString(),
      filePath,
      sizeBytes: info.size,
    };
  } catch {
    return null;
  }
}

async function realDirectory(path: string): Promise<string | null> {
  try {
    const real = await realpath(path);
    return (await stat(real)).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

async function listClaudeSessions(): Promise<SessionSummary[]> {
  const root = await realDirectory(join(claudeHome(), "projects"));
  if (!root) return [];
  const sessions: SessionSummary[] = [];
  let projects;
  try {
    projects = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectPath = resolve(root, project.name);
    let realProject: string;
    try {
      realProject = await realpath(projectPath);
    } catch {
      continue;
    }
    if (!isInside(root, realProject)) continue;
    let files;
    try {
      files = await readdir(realProject, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const file of files) {
      if ((!file.isFile() && !file.isSymbolicLink()) || !file.name.endsWith(".jsonl")) continue;
      const sessionId = file.name.slice(0, -".jsonl".length);
      if (!SESSION_ID_RE.test(sessionId)) continue;
      try {
        const filePath = await realpath(resolve(realProject, file.name));
        if (!isInside(root, filePath)) continue;
        const summary = await cachedHead("claude", filePath, sessionId);
        if (summary) sessions.push(summary);
      } catch {
        // Ignore files removed or replaced while listing.
      }
    }
  }
  return sessions;
}

async function rolloutPaths(root: string): Promise<Array<{ filePath: string; sessionId: string }>> {
  const files: Array<{ filePath: string; sessionId: string }> = [];
  const visit = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(entries.map(async (entry) => {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        return;
      }
      if (!entry.isFile()) return;
      const match = CODEX_FILE_RE.exec(entry.name);
      if (!match?.[1]) return;
      try {
        const filePath = await realpath(path);
        if (isInside(root, filePath)) files.push({ filePath, sessionId: match[1] });
      } catch {
        // Ignore files removed or replaced while listing.
      }
    }));
  };
  await visit(root);
  return files;
}

async function codexTitles(realHome: string): Promise<Map<string, string>> {
  const requested = resolve(realHome, "session_index.jsonl");
  try {
    const filePath = await realpath(requested);
    if (!isInside(realHome, filePath)) return new Map();
    const info = await stat(filePath);
    if (!info.isFile()) return new Map();
    const cached = titleCache.get(filePath);
    if (cached?.mtimeMs === info.mtimeMs && cached.sizeBytes === info.size) return cached.titles;
    const titles = new Map<string, string>();
    for (const line of (await readFile(filePath, "utf8")).split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as unknown;
        const id = stringField(row, "id");
        const title = cleanTitle(stringField(row, "thread_name") ?? "");
        if (id && SESSION_ID_RE.test(id) && title) titles.set(id, title);
      } catch {
        // Skip malformed index rows without discarding later titles.
      }
    }
    titleCache.set(filePath, { mtimeMs: info.mtimeMs, sizeBytes: info.size, titles });
    return titles;
  } catch {
    return new Map();
  }
}

async function listCodexSessions(): Promise<SessionSummary[]> {
  const realHome = await realDirectory(codexHome());
  if (!realHome) return [];
  const titles = await codexTitles(realHome);
  const roots = (await Promise.all([
    realDirectory(resolve(realHome, "sessions")),
    realDirectory(resolve(realHome, "archived_sessions")),
  ])).filter((root): root is string => root !== null && isInside(realHome, root));
  const paths = (await Promise.all(roots.map((root) => rolloutPaths(root)))).flat();
  const sessions = await Promise.all(paths.map(async ({ filePath, sessionId }) => {
    const summary = await cachedHead("codex", filePath, sessionId);
    return summary ? { ...summary, title: titles.get(summary.sessionId) ?? null } : null;
  }));
  return sessions.filter((session): session is SessionSummary => session !== null);
}

export async function listSessions(opts: ListSessionsOptions = {}): Promise<SessionSummary[]> {
  const sessions = opts.engine === "claude"
    ? await listClaudeSessions()
    : opts.engine === "codex"
      ? await listCodexSessions()
      : (await Promise.all([listClaudeSessions(), listCodexSessions()])).flat();
  sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const query = opts.q?.trim().toLocaleLowerCase() ?? "";
  const filtered = query ? sessions.filter((session) => {
    return [session.title, session.project, session.cwd]
      .some((value) => value?.toLocaleLowerCase().includes(query));
  }) : sessions;
  const limit = opts.limit === undefined || !Number.isFinite(opts.limit)
    ? 100
    : Math.max(0, Math.floor(opts.limit));
  return filtered.slice(0, limit);
}

function transcriptTimes(records: readonly CodexJsonRecord[]): { startTime: string | null; endTime: string | null } {
  const times = records.flatMap((record) => {
    const timestamp = typeof record.timestamp === "string"
      ? record.timestamp
      : record.type === "session_meta"
        ? stringField(record.payload, "timestamp")
        : null;
    return timestamp ? [timestamp] : [];
  });
  return { startTime: times[0] ?? null, endTime: times.at(-1) ?? null };
}

async function readContained(summary: SessionSummary): Promise<string | null> {
  const roots = summary.engine === "claude"
    ? [join(claudeHome(), "projects")]
    : [join(codexHome(), "sessions"), join(codexHome(), "archived_sessions")];
  try {
    const [filePath, realRoots] = await Promise.all([
      realpath(summary.filePath),
      Promise.all(roots.map((root) => realDirectory(root))),
    ]);
    if (!realRoots.some((root) => root !== null && isInside(root, filePath))) return null;
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

export async function readSession(engine: SessionEngine | string, sessionId: string): Promise<Transcript | null> {
  if ((engine !== "claude" && engine !== "codex") || !SESSION_ID_RE.test(sessionId)) return null;
  const summary = (await listSessions({ engine, limit: Number.MAX_SAFE_INTEGER }))
    .find((candidate) => candidate.sessionId.toLocaleLowerCase() === sessionId.toLocaleLowerCase());
  if (!summary) return null;
  const raw = await readContained(summary);
  if (raw === null) return null;

  if (engine === "claude") {
    const parsed = parseClaudeJsonl(raw);
    return {
      meta: {
        sessionId: parsed.sessionId && SESSION_ID_RE.test(parsed.sessionId) ? parsed.sessionId : sessionId,
        title: summary.title,
        startTime: parsed.startTime,
        endTime: parsed.endTime,
        costUsd: null,
      },
      entries: parsed.entries,
    };
  }

  const records = parseCodexJsonl(raw);
  const times = transcriptTimes(records);
  return {
    meta: {
      sessionId,
      title: summary.title,
      startTime: times.startTime,
      endTime: times.endTime,
      costUsd: null,
    },
    entries: mapCodexRolloutEntries(records),
  };
}
