import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  finalOutput,
  probeHelp,
  readTranscriptFallback,
  runProcess,
  safeScope,
  tomlString,
  writeTranscriptFallback,
} from "./agent-process.ts";
import { unattendedFullAccess } from "./config.ts";
import type { AgentExecResult, AgentExecSpec, AgentRunner, Transcript, TranscriptEntry } from "./runner.ts";

export interface CodexJsonRecord {
  readonly type?: unknown;
  readonly timestamp?: unknown;
  readonly thread_id?: unknown;
  readonly session_id?: unknown;
  readonly item?: unknown;
  readonly payload?: unknown;
}

function resolveCodexBin(): string {
  const override = (process.env.BOUCLE_CODEX_BIN ?? "").trim();
  if (override) return override;
  const local = join(homedir(), ".local", "bin", "codex");
  return existsSync(local) ? local : "codex";
}

function codexConfig(mcpUrl: string): string {
  return [
    "[mcp_servers.boucle]",
    `url = ${tomlString(mcpUrl)}`,
    'bearer_token_env_var = "BOUCLE_MCP_TOKEN"',
    "",
  ].join("\n");
}

async function copyCodexAuth(codexHome: string): Promise<boolean> {
  const source = join(homedir(), ".codex", "auth.json");
  const target = join(codexHome, "auth.json");
  if (existsSync(target)) return true;
  if (!existsSync(source)) return false;
  try {
    await copyFile(source, target);
    return true;
  } catch {
    // OPENAI_API_KEY and other Codex authentication paths can still work.
    return false;
  }
}

let resumeHelp: { binary: string; result: Promise<boolean> } | null = null;

function supportsResume(binary: string): Promise<boolean> {
  if (resumeHelp?.binary === binary) return resumeHelp.result;
  const result = probeHelp(binary, ["exec", "resume", "--help"])
    .then((help) => /\bcodex exec resume\b|Resume a previous session/.test(help))
    .catch(() => false);
  resumeHelp = { binary, result };
  return result;
}

export function parseCodexJsonl(raw: string): CodexJsonRecord[] {
  const records: CodexJsonRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (value && typeof value === "object") records.push(value as CodexJsonRecord);
    } catch {
      // Codex may mix a warning into JSONL output; keep parsing later lines.
    }
  }
  return records;
}

function stringField(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object") return null;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.trim() ? field : null;
}

function sessionIdFromRecords(records: readonly CodexJsonRecord[]): string | null {
  for (const record of records) {
    if (typeof record.thread_id === "string") return record.thread_id;
    if (typeof record.session_id === "string") return record.session_id;
    const payloadId = stringField(record.payload, "id") ?? stringField(record.payload, "session_id");
    if (record.type === "session_meta" && payloadId) return payloadId;
  }
  return null;
}

function finalMessageFromRecords(records: readonly CodexJsonRecord[]): string | null {
  for (const record of records.toReversed()) {
    const item = record.item;
    if (stringField(item, "type") === "agent_message") {
      const text = stringField(item, "text");
      if (text) return text;
    }
    if (record.type === "event_msg" && stringField(record.payload, "type") === "agent_message") {
      const message = stringField(record.payload, "message");
      if (message) return message;
    }
  }
  return null;
}

async function rolloutFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) files.push(path);
    }));
  };
  await visit(root);
  return files;
}

async function rolloutMeta(path: string): Promise<{ sessionId: string | null; mtimeMs: number }> {
  try {
    const [raw, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    return { sessionId: sessionIdFromRecords(parseCodexJsonl(raw)), mtimeMs: info.mtimeMs };
  } catch {
    return { sessionId: null, mtimeMs: 0 };
  }
}

async function findRollout(codexHome: string, sessionId: string | null, startedMs = 0): Promise<string | null> {
  const files = await rolloutFiles(join(codexHome, "sessions"));
  const candidates = await Promise.all(files.map(async (path) => ({ path, ...await rolloutMeta(path) })));
  if (sessionId) {
    const exact = candidates.find((candidate) => candidate.sessionId === sessionId);
    if (exact) return exact.path;
  }
  return candidates
    .filter((candidate) => candidate.mtimeMs >= startedMs - 2_000)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.path ?? null;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => {
    if (!part || typeof part !== "object") return "";
    return stringField(part, "text") ?? stringField(part, "input_text") ?? stringField(part, "output_text") ?? "";
  }).filter(Boolean).join("\n");
}

function serializedField(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object") return null;
  const field = (value as Record<string, unknown>)[key];
  if (typeof field === "string" && field.trim()) return field;
  if (field === undefined || field === null) return null;
  try {
    return JSON.stringify(field, null, 2);
  } catch {
    return String(field);
  }
}

export function mapCodexRolloutEntries(records: readonly CodexJsonRecord[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const toolNames = new Map<string, string>();
  const pushMessage = (role: "user" | "assistant", content: string): void => {
    const previous = entries.at(-1);
    if (previous?.role === role && previous.content === content) return;
    entries.push({ role, content });
  };
  for (const record of records) {
    const payload = record.payload;
    const payloadType = stringField(payload, "type");
    if (record.type === "event_msg" && payloadType === "user_message") {
      const content = stringField(payload, "message");
      if (content) pushMessage("user", content);
      continue;
    }
    if (record.type === "event_msg" && payloadType === "agent_message") {
      const content = stringField(payload, "message");
      if (content) pushMessage("assistant", content);
      continue;
    }
    if (record.type !== "response_item") continue;
    if (payloadType === "message") {
      const role = stringField(payload, "role");
      const content = contentText((payload as Record<string, unknown>).content);
      if (content && (role === "user" || role === "assistant")) pushMessage(role, content);
      continue;
    }
    if (payloadType === "function_call" || payloadType === "custom_tool_call" || payloadType === "local_shell_call") {
      const toolName = stringField(payload, "name") ?? (payloadType === "local_shell_call" ? "shell" : "tool");
      const callId = stringField(payload, "call_id") ?? stringField(payload, "id");
      if (callId) toolNames.set(callId, toolName);
      const content = serializedField(payload, "input")
        ?? serializedField(payload, "arguments")
        ?? serializedField(payload, "action")
        ?? `used: ${toolName}`;
      entries.push({ role: "tool", toolName, content });
      continue;
    }
    if (payloadType === "function_call_output" || payloadType === "custom_tool_call_output" || payloadType === "local_shell_call_output") {
      const callId = stringField(payload, "call_id") ?? stringField(payload, "id");
      const toolName = callId ? toolNames.get(callId) ?? "tool" : "tool";
      const content = serializedField(payload, "output") ?? "completed";
      entries.push({ role: "tool", toolName, content });
    }
  }
  return entries;
}

export class CodexRunner implements AgentRunner {
  readonly name = "codex" as const;

  async exec(spec: AgentExecSpec): Promise<AgentExecResult> {
    const binary = resolveCodexBin();
    const codexHome = join(spec.workdir, "var", "codex", safeScope(spec.scope));
    await mkdir(codexHome, { recursive: true });
    const [, useAccountAuth] = await Promise.all([
      writeFile(join(codexHome, "config.toml"), codexConfig(spec.mcpUrl), { mode: 0o600 }),
      copyCodexAuth(codexHome),
    ]);

    let prompt = spec.prompt;
    const resume = spec.resumeSessionId ? await supportsResume(binary) : false;
    // Prompts are store-sourced, so full host access stays opt-in; default to a writable-workspace
    // sandbox that still lets the run touch the workdir and reach Boucle via scoped MCP tools.
    const sandbox = unattendedFullAccess() ? "danger-full-access" : "workspace-write";
    const args = resume
      ? ["exec", "resume", "--skip-git-repo-check", "--json"]
      : ["exec", "--skip-git-repo-check", "--sandbox", sandbox, "-C", spec.workdir, "--json"];
    if (spec.model?.trim()) args.push("--model", spec.model.trim());
    if (resume && spec.resumeSessionId) args.push(spec.resumeSessionId);
    if (spec.resumeSessionId && !resume) {
      prompt = `Continuing session ${spec.resumeSessionId} without CLI resume support.\n\n${prompt}`;
    }
    args.push(prompt);

    const startedMs = Date.now();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CODEX_HOME: codexHome,
      BOUCLE_DB: spec.dbPath,
      BOUCLE_MCP_TOKEN: spec.mcpToken,
    };
    if (useAccountAuth) delete env.OPENAI_API_KEY;
    const processResult = await runProcess(binary, args, {
      cwd: spec.workdir,
      timeoutMin: spec.timeoutMin,
      env,
    });
    const records = parseCodexJsonl(processResult.stdout);
    let sessionId = sessionIdFromRecords(records) ?? spec.resumeSessionId;
    const rollout = await findRollout(codexHome, sessionId, startedMs);
    if (!sessionId && rollout) sessionId = (await rolloutMeta(rollout)).sessionId;
    const output = finalMessageFromRecords(records) ?? finalOutput(processResult.stdout, processResult.stderr);
    await writeTranscriptFallback(codexHome, sessionId, output);
    return {
      code: processResult.code,
      timedOut: processResult.timedOut,
      output,
      sessionId,
      costUsd: null,
    };
  }

  async readTranscript(workdir: string, scope: string, sessionId: string): Promise<Transcript | null> {
    const codexHome = join(workdir, "var", "codex", safeScope(scope));
    const fallback = await readTranscriptFallback(codexHome, sessionId);
    const rollout = await findRollout(codexHome, sessionId);
    if (!rollout) {
      return fallback ? {
        meta: { sessionId, title: null, startTime: null, endTime: null, costUsd: null },
        entries: [{ role: "assistant", content: fallback }],
      } : null;
    }
    try {
      const records = parseCodexJsonl(await readFile(rollout, "utf8"));
      const times = records.map((record) => typeof record.timestamp === "string" ? record.timestamp : null).filter((v): v is string => v !== null);
      const entries = mapCodexRolloutEntries(records);
      if (fallback && !entries.some((entry) => entry.role === "assistant")) {
        entries.push({ role: "assistant", content: fallback });
      }
      return {
        meta: {
          sessionId: sessionIdFromRecords(records) ?? sessionId,
          title: null,
          startTime: times[0] ?? null,
          endTime: times.at(-1) ?? null,
          costUsd: null,
        },
        entries,
      };
    } catch {
      return fallback ? {
        meta: { sessionId, title: null, startTime: null, endTime: null, costUsd: null },
        entries: [{ role: "assistant", content: fallback }],
      } : null;
    }
  }
}
