import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

import * as nodePty from "node-pty";

export interface PtyExitEvent {
  exitCode: number;
  signal: number | null;
}

export interface PtyProcess {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(callback: (data: string) => void): () => void;
  onExit(callback: (event: PtyExitEvent) => void): () => void;
}

export interface PtySpawnInput {
  shell: string;
  args?: string[];
  cwd: string;
  cols: number;
  rows: number;
  env: NodeJS.ProcessEnv;
}

export interface PtyAdapter {
  spawn(input: PtySpawnInput): PtyProcess;
}

function assertExecutable(shell: string, env: NodeJS.ProcessEnv): void {
  const candidates = shell.includes("/")
    ? [shell]
    : (env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory, shell));
  let accessError: unknown;
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code !== "ENOENT") accessError = error;
    }
  }
  if (accessError) throw accessError;
  throw Object.assign(new Error(`Terminal shell not found: ${shell}`), { code: "ENOENT" });
}

class NodePtyProcess implements PtyProcess {
  private readonly process: nodePty.IPty;

  constructor(process: nodePty.IPty) {
    this.process = process;
  }

  get pid(): number { return this.process.pid; }
  write(data: string): void { this.process.write(data); }
  resize(cols: number, rows: number): void { this.process.resize(cols, rows); }
  kill(signal?: string): void { this.process.kill(signal); }
  onData(callback: (data: string) => void): () => void {
    const disposable = this.process.onData(callback);
    return () => disposable.dispose();
  }
  onExit(callback: (event: PtyExitEvent) => void): () => void {
    const disposable = this.process.onExit((event) => callback({
      exitCode: event.exitCode,
      signal: event.signal ?? null,
    }));
    return () => disposable.dispose();
  }
}

export class NodePtyAdapter implements PtyAdapter {
  spawn(input: PtySpawnInput): PtyProcess {
    // node-pty 1.1 can return a PTY and report execvp(ENOENT) as process output,
    // which is too late for the manager's shell ladder. Preflight so ENOENT stays
    // a spawn error while every other failure remains non-retryable.
    assertExecutable(input.shell, input.env);
    return new NodePtyProcess(nodePty.spawn(input.shell, input.args ?? [], {
      cwd: input.cwd,
      cols: input.cols,
      rows: input.rows,
      env: input.env,
      name: "xterm-256color",
    }));
  }
}
