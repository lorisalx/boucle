import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  finalOutput,
  probeHelp,
  readTranscriptFallback,
  runProcess,
  safeScope,
  writeTranscriptFallback,
} from "./agent-process.ts";
import type { AgentExecResult, AgentExecSpec, AgentRunner, Transcript, TranscriptEntry } from "./runner.ts";

interface ClaudeEnvelope {
  readonly result?: unknown;
  readonly session_id?: unknown;
  readonly total_cost_usd?: unknown;
}

interface ClaudeRow {
  readonly type?: unknown;
  readonly timestamp?: unknown;
  readonly sessionId?: unknown;
  readonly message?: unknown;
}

function resolveClaudeBin(): string {
  return (process.env.BOUCLE_CLAUDE_BIN ?? "").trim() || "claude";
}

function claudeMcpConfig(mcpUrl: string, token: string): string {
  return JSON.stringify({
    mcpServers: {
      boucle: {
        type: "http",
        url: mcpUrl,
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  }, null, 2);
}

let permissionHelp: { binary: string; result: Promise<boolean> } | null = null;

function supportsDangerousPermissions(binary: string): Promise<boolean> {
  if (permissionHelp?.binary === binary) return permissionHelp.result;
  const result = probeHelp(binary, ["-p", "--help"])
    .then((help) => help.includes("--dangerously-skip-permissions"))
    .catch(() => false);
  permissionHelp = { binary, result };
  return result;
}

function parseEnvelope(stdout: string): ClaudeEnvelope | null {
  try {
    const value = JSON.parse(stdout) as unknown;
    return value && typeof value === "object" ? value as ClaudeEnvelope : null;
  } catch {
    for (const line of stdout.split("\n").toReversed()) {
      try {
        const value = JSON.parse(line) as unknown;
        if (value && typeof value === "object") return value as ClaudeEnvelope;
      } catch {
        // Keep looking past CLI warnings.
      }
    }
    return null;
  }
}

function validCost(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function stringField(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object") return null;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.trim() ? field : null;
}

function contentEntries(role: "user" | "assistant", value: unknown): TranscriptEntry[] {
  if (typeof value === "string") return value.trim() ? [{ role, content: value }] : [];
  if (!Array.isArray(value)) return [];
  const entries: TranscriptEntry[] = [];
  for (const block of value) {
    const type = stringField(block, "type");
    if (type === "text") {
      const text = stringField(block, "text");
      if (text) entries.push({ role, content: text });
    } else if (role === "assistant" && type === "tool_use") {
      const toolName = stringField(block, "name") ?? "tool";
      entries.push({ role: "tool", toolName, content: `used: ${toolName}` });
    }
  }
  return entries;
}

function parseTranscript(raw: string): { entries: TranscriptEntry[]; startTime: string | null; endTime: string | null; sessionId: string | null } {
  const entries: TranscriptEntry[] = [];
  const times: string[] = [];
  let sessionId: string | null = null;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as ClaudeRow;
      if (typeof row.timestamp === "string") times.push(row.timestamp);
      if (typeof row.sessionId === "string") sessionId = row.sessionId;
      if (row.type !== "user" && row.type !== "assistant") continue;
      const message = row.message;
      if (!message || typeof message !== "object") continue;
      entries.push(...contentEntries(row.type, (message as Record<string, unknown>).content));
    } catch {
      // Ignore partial transcript lines.
    }
  }
  return { entries, startTime: times[0] ?? null, endTime: times.at(-1) ?? null, sessionId };
}

function mungedWorkdir(workdir: string): string {
  return workdir.replace(/[^a-zA-Z0-9-]/g, "-");
}

async function findClaudeTranscript(workdir: string, sessionId: string): Promise<string | null> {
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(sessionId)) return null;
  const root = join(homedir(), ".claude", "projects");
  const expected = join(root, mungedWorkdir(workdir), `${sessionId}.jsonl`);
  if (existsSync(expected)) return expected;
  try {
    const projects = await readdir(root, { withFileTypes: true });
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const candidate = join(root, project.name, `${sessionId}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // Claude has not created its transcript root yet.
  }
  return null;
}

export class ClaudeRunner implements AgentRunner {
  readonly name = "claude" as const;

  async exec(spec: AgentExecSpec): Promise<AgentExecResult> {
    const binary = resolveClaudeBin();
    const scopeRoot = join(spec.workdir, "var", "claude", safeScope(spec.scope));
    const mcpPath = join(scopeRoot, "mcp.json");
    await mkdir(scopeRoot, { recursive: true });
    await writeFile(mcpPath, claudeMcpConfig(spec.mcpUrl, spec.mcpToken), { mode: 0o600 });

    const args = [
      "-p",
      spec.prompt,
      "--output-format",
      "json",
      "--mcp-config",
      mcpPath,
      "--strict-mcp-config",
    ];
    if (await supportsDangerousPermissions(binary)) args.push("--dangerously-skip-permissions");
    else args.push("--allowedTools", "mcp__boucle__*");
    if (spec.model?.trim()) args.push("--model", spec.model.trim());
    if (spec.resumeSessionId) args.push("--resume", spec.resumeSessionId);
    if (spec.maxPriceUsd > 0) args.push("--max-budget-usd", String(spec.maxPriceUsd));

    const processResult = await runProcess(binary, args, {
      cwd: spec.workdir,
      timeoutMin: spec.timeoutMin,
      env: {
        ...process.env,
        BOUCLE_DB: spec.dbPath,
        BOUCLE_MCP_TOKEN: spec.mcpToken,
      },
    });
    const envelope = parseEnvelope(processResult.stdout);
    const sessionId = typeof envelope?.session_id === "string" ? envelope.session_id : spec.resumeSessionId;
    const output = typeof envelope?.result === "string"
      ? envelope.result
      : finalOutput(processResult.stdout, processResult.stderr);
    await writeTranscriptFallback(scopeRoot, sessionId, output);
    return {
      code: processResult.code,
      timedOut: processResult.timedOut,
      output,
      sessionId,
      costUsd: validCost(envelope?.total_cost_usd),
    };
  }

  async readTranscript(workdir: string, scope: string, sessionId: string): Promise<Transcript | null> {
    const scopeRoot = join(workdir, "var", "claude", safeScope(scope));
    const fallback = await readTranscriptFallback(scopeRoot, sessionId);
    const path = await findClaudeTranscript(workdir, sessionId);
    if (!path) {
      return fallback ? {
        meta: { sessionId, title: null, startTime: null, endTime: null, costUsd: null },
        entries: [{ role: "assistant", content: fallback }],
      } : null;
    }
    try {
      const parsed = parseTranscript(await readFile(path, "utf8"));
      return {
        meta: {
          sessionId: parsed.sessionId ?? sessionId,
          title: null,
          startTime: parsed.startTime,
          endTime: parsed.endTime,
          costUsd: null,
        },
        entries: parsed.entries.length > 0 ? parsed.entries : fallback ? [{ role: "assistant", content: fallback }] : [],
      };
    } catch {
      return fallback ? {
        meta: { sessionId, title: null, startTime: null, endTime: null, costUsd: null },
        entries: [{ role: "assistant", content: fallback }],
      } : null;
    }
  }
}
