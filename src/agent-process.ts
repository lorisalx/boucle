import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MAX_CAPTURE_CHARS = 64_000;

export interface ProcessResult {
  readonly code: number | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

export function safeScope(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 160);
}

export function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function finalOutput(stdout: string, stderr: string): string {
  return [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
}

export function runProcess(
  binary: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly timeoutMin: number },
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(binary, [...args], {
      cwd: options.cwd,
      env: options.env,
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
    const timeoutMs = Math.max(0.01, options.timeoutMin) * 60_000;
    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, timeoutMs);
    if (typeof killTimer.unref === "function") killTimer.unref();

    let finished = false;
    const finish = (code: number | null, spawnError?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(killTimer);
      if (spawnError) stderr = `${stderr}\n[spawn error] ${spawnError}`.trim();
      resolve({ code, timedOut, stdout, stderr });
    };
    child.on("error", (error) => finish(null, error.message));
    child.on("close", (code) => finish(code));
  });
}

export async function probeHelp(binary: string, args: readonly string[]): Promise<string> {
  const result = await runProcess(binary, args, {
    cwd: process.cwd(),
    env: process.env,
    timeoutMin: 0.25,
  });
  return `${result.stdout}\n${result.stderr}`;
}

function fallbackName(sessionId: string): string {
  return `fallback-${sessionId.replace(/[^a-zA-Z0-9-]/g, "_").slice(0, 160)}.txt`;
}

export function writeTranscriptFallback(root: string, sessionId: string | null, output: string): Promise<void> {
  if (!sessionId || !output.trim()) return Promise.resolve();
  return writeFile(join(root, fallbackName(sessionId)), output, { mode: 0o600 });
}

export async function readTranscriptFallback(root: string, sessionId: string): Promise<string | null> {
  try {
    const output = await readFile(join(root, fallbackName(sessionId)), "utf8");
    return output.trim() || null;
  } catch {
    return null;
  }
}
