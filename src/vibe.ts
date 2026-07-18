import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_TIMEOUT_MIN = Number.parseInt(process.env.BOUCLE_LOOP_TIMEOUT_MIN ?? "12", 10);
const MAX_CAPTURE_CHARS = 16_000;

export interface VibeExecSpec {
  readonly prompt: string;
  readonly model: string | null;
  readonly sessionId?: string | null;
  /** Stable for scheduled loops so their Vibe session storage can be resumed. */
  readonly scopeId: string;
}

export interface VibeExecOptions {
  readonly dbPath: string;
  readonly mcpToken: string;
  readonly mcpUrl: string;
  readonly workdir: string;
}

export interface VibeExecResult {
  readonly code: number | null;
  readonly timedOut: boolean;
  readonly output: string;
  readonly costUsd: number | null;
  readonly sessionId: string | null;
}

interface VibeSessionMeta {
  session_id?: unknown;
  stats?: { session_cost?: unknown };
}

function resolveVibeBin(): string {
  const override = (process.env.BOUCLE_VIBE_BIN ?? "").trim();
  if (override) return override;
  const local = join(homedir(), ".local", "bin", "vibe");
  return existsSync(local) ? local : "vibe";
}

function maxPrice(): string {
  const value = Number.parseFloat(process.env.BOUCLE_VIBE_MAX_PRICE ?? "0.25");
  return Number.isFinite(value) && value > 0 ? String(value) : "0.25";
}

function safeScope(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 160);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function modelConfig(model: string): {
  name: string;
  inputPrice: number;
  outputPrice: number;
  thinking: "off" | "high";
} {
  if (model === "mistral-medium-3.5") {
    return { name: "mistral-vibe-cli-latest", inputPrice: 1.5, outputPrice: 7.5, thinking: "high" };
  }
  if (model.includes("devstral-small")) {
    return { name: model, inputPrice: 0.1, outputPrice: 0.3, thinking: "off" };
  }
  if (model.includes("devstral")) {
    return { name: model, inputPrice: 0.4, outputPrice: 2, thinking: "off" };
  }
  // Unknown custom model: conservative pricing keeps --max-price useful.
  return { name: model, inputPrice: 1.5, outputPrice: 7.5, thinking: "off" };
}

function vibeConfig(model: string, mcpUrl: string): string {
  const selected = modelConfig(model);
  return [
    `active_model = ${tomlString(model)}`,
    "enable_connectors = false",
    "enable_telemetry = false",
    "mcp_servers = [{ name = \"boucle\", transport = \"streamable-http\", " +
      `url = ${tomlString(mcpUrl)}, auth = { type = \"static\", api_key_env = \"BOUCLE_MCP_TOKEN\", ` +
      "api_key_header = \"Authorization\", api_key_format = \"Bearer {token}\" } }]",
    "",
    "[[models]]",
    `name = ${tomlString(selected.name)}`,
    "provider = \"mistral\"",
    `alias = ${tomlString(model)}`,
    "temperature = 0.2",
    `input_price = ${selected.inputPrice}`,
    `output_price = ${selected.outputPrice}`,
    `thinking = ${tomlString(selected.thinking)}`,
    "",
  ].join("\n");
}

async function readSessionMeta(
  vibeHome: string,
  expectedSessionId: string | null,
  startedMs: number,
): Promise<{ sessionId: string | null; costUsd: number | null }> {
  const sessionRoot = join(vibeHome, "logs", "session");
  let dirs: string[];
  try {
    dirs = await readdir(sessionRoot);
  } catch {
    return { sessionId: expectedSessionId, costUsd: null };
  }

  const candidates: Array<{ mtimeMs: number; meta: VibeSessionMeta }> = [];
  for (const dir of dirs) {
    if (!dir.startsWith("session_")) continue;
    const path = join(sessionRoot, dir, "meta.json");
    try {
      const [raw, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
      const meta = JSON.parse(raw) as VibeSessionMeta;
      // Each scope has only one active invocation. A resumed session can receive a
      // new id after Vibe compaction, so select the metadata touched by this run
      // instead of requiring the old id to remain unchanged.
      if (info.mtimeMs < startedMs - 2_000) continue;
      candidates.push({ mtimeMs: info.mtimeMs, meta });
    } catch {
      // Ignore incomplete or unrelated session directories.
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const meta = candidates[0]?.meta;
  const sessionId = typeof meta?.session_id === "string" ? meta.session_id : expectedSessionId;
  const rawCost = meta?.stats?.session_cost;
  const costUsd = typeof rawCost === "number" && Number.isFinite(rawCost) && rawCost >= 0 ? rawCost : null;
  return { sessionId, costUsd };
}

function finalAssistantOutput(stdout: string, stderr: string): string {
  try {
    const messages = JSON.parse(stdout) as Array<{ role?: unknown; content?: unknown }>;
    const assistant = messages.findLast((message) => message.role === "assistant");
    if (typeof assistant?.content === "string" && assistant.content.trim()) return assistant.content;
  } catch {
    // Preserve the raw process output when Vibe did not emit valid JSON.
  }
  return [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
}

export async function execVibe(spec: VibeExecSpec, options: VibeExecOptions): Promise<VibeExecResult> {
  const model = spec.model?.trim() || "devstral-2512";
  const vibeHome = join(options.workdir, "var", "vibe", safeScope(spec.scopeId));
  await mkdir(vibeHome, { recursive: true });
  await writeFile(join(vibeHome, "config.toml"), vibeConfig(model, options.mcpUrl), { mode: 0o600 });

  const args = [
    "--prompt",
    spec.prompt,
    "--auto-approve",
    "--output",
    "json",
    "--max-turns",
    "30",
    "--max-price",
    maxPrice(),
    "--workdir",
    options.workdir,
    "--trust",
  ];
  if (spec.sessionId) args.push("--resume", spec.sessionId);

  const startedMs = Date.now();
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      VIBE_HOME: vibeHome,
      VIBE_ACTIVE_MODEL: model,
      BOUCLE_DB: options.dbPath,
      BOUCLE_MCP_TOKEN: options.mcpToken,
    };
    const child = spawn(resolveVibeBin(), args, {
      env,
      cwd: options.workdir,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const capture = (target: "stdout" | "stderr") => (chunk: Buffer) => {
      if (target === "stdout") stdout = (stdout + chunk.toString()).slice(-MAX_CAPTURE_CHARS);
      else stderr = (stderr + chunk.toString()).slice(-MAX_CAPTURE_CHARS);
    };
    child.stdout?.on("data", capture("stdout"));
    child.stderr?.on("data", capture("stderr"));

    let timedOut = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, DEFAULT_TIMEOUT_MIN * 60_000);
    if (typeof killTimer.unref === "function") killTimer.unref();

    let finishing = false;
    const finish = async (code: number | null, spawnError: string | null) => {
      if (finishing) return;
      finishing = true;
      clearTimeout(killTimer);
      const metadata = await readSessionMeta(vibeHome, spec.sessionId ?? null, startedMs);
      const output = spawnError
        ? `${finalAssistantOutput(stdout, stderr)}\n[spawn error] ${spawnError}`.trim()
        : finalAssistantOutput(stdout, stderr);
      resolve({ code, timedOut, output, ...metadata });
    };
    child.on("error", (err) => void finish(null, err.message));
    child.on("close", (code) => void finish(code, null));
  });
}
