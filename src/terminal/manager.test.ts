import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { PtyAdapter, PtyExitEvent, PtyProcess, PtySpawnInput } from "./pty-adapter.ts";
import { TerminalManager } from "./manager.ts";
import type { TerminalServerMessage } from "./wire.ts";

const THREAD_ID = "11111111-1111-4111-8111-111111111111";

class FakePtyProcess implements PtyProcess {
  readonly pid: number;
  private initialData: string | null;
  readonly writes: string[] = [];
  readonly resizes: Array<{ cols: number; rows: number }> = [];
  readonly killSignals: string[] = [];
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyExitEvent) => void>();

  constructor(pid: number, initialData: string | null = null) {
    this.pid = pid;
    this.initialData = initialData;
  }

  write(data: string): void { this.writes.push(data); }
  resize(cols: number, rows: number): void { this.resizes.push({ cols, rows }); }
  kill(signal = "SIGTERM"): void { this.killSignals.push(signal); }
  onData(callback: (data: string) => void): () => void {
    this.dataListeners.add(callback);
    if (this.initialData !== null) {
      const data = this.initialData;
      this.initialData = null;
      callback(data);
    }
    return () => this.dataListeners.delete(callback);
  }
  onExit(callback: (event: PtyExitEvent) => void): () => void {
    this.exitListeners.add(callback);
    return () => this.exitListeners.delete(callback);
  }
  emitData(data: string): void { for (const callback of this.dataListeners) callback(data); }
  emitExit(exitCode = 0): void {
    for (const callback of this.exitListeners) callback({ exitCode, signal: null });
  }
}

class FakePtyAdapter implements PtyAdapter {
  readonly spawnInputs: PtySpawnInput[] = [];
  readonly processes: FakePtyProcess[] = [];
  spawnError: ((input: PtySpawnInput) => Error | null) | null = null;
  dataOnSubscribe: string | null = null;

  spawn(input: PtySpawnInput): PtyProcess {
    this.spawnInputs.push(input);
    const error = this.spawnError?.(input);
    if (error) throw error;
    const process = new FakePtyProcess(1000 + this.processes.length, this.dataOnSubscribe);
    this.processes.push(process);
    return process;
  }
}

async function fixture(options: Partial<ConstructorParameters<typeof TerminalManager>[0]> = {}) {
  const historyDir = await mkdtemp(join(tmpdir(), "boucle-terminal-manager-"));
  const adapter = new FakePtyAdapter();
  const manager = new TerminalManager({
    adapter,
    historyDir,
    historyLineLimit: 3,
    persistDebounceMs: 20,
    killGraceMs: 20,
    env: { SHELL: "/bin/bash", PATH: "/usr/bin", PORT: "9999", BOUCLE_AUTH_TOKEN: "secret" },
    ...options,
  });
  return { adapter, historyDir, manager };
}

test("terminal manager caps replay history by line while retaining ANSI colors", async () => {
  const { adapter, historyDir, manager } = await fixture();
  try {
    const events: TerminalServerMessage[] = [];
    const unsubscribe = await manager.attach({
      threadId: THREAD_ID,
      terminalId: "term-1",
      cwd: historyDir,
      cols: 80,
      rows: 24,
    }, (event) => events.push(event));
    adapter.processes[0]!.emitData("one\ntwo\n\u001b[32mthree\u001b[0m\nfour\n");

    assert.equal(events[0]?.type, "snapshot");
    assert.equal(manager.snapshot(THREAD_ID, "term-1")?.history, "two\n\u001b[32mthree\u001b[0m\nfour\n");
    unsubscribe();
  } finally {
    await manager.dispose();
    await rm(historyDir, { recursive: true, force: true });
  }
});

test("terminal manager retries missing shells and removes Boucle secrets from the inherited env", async () => {
  const { adapter, historyDir, manager } = await fixture({
    env: {
      SHELL: "/missing/custom-shell",
      PATH: "/usr/bin",
      KEEP_ME: "yes",
      PORT: "4519",
      BOUCLE_AUTH_TOKEN: "secret",
      BOUCLE_DB: "/secret/db",
    },
  });
  adapter.spawnError = (input) => {
    if (input.shell !== "/bin/bash") return Object.assign(new Error("missing"), { code: "ENOENT" });
    return null;
  };
  try {
    await manager.attach({ threadId: THREAD_ID, terminalId: "term-1", cwd: historyDir }, () => {});
    assert.deepEqual(adapter.spawnInputs.map((input) => input.shell), [
      "/missing/custom-shell",
      "/bin/zsh",
      "/bin/bash",
    ]);
    assert.equal(adapter.spawnInputs[2]?.env.KEEP_ME, "yes");
    assert.equal(adapter.spawnInputs[2]?.env.PORT, undefined);
    assert.equal(adapter.spawnInputs[2]?.env.BOUCLE_AUTH_TOKEN, undefined);
    assert.equal(adapter.spawnInputs[2]?.env.BOUCLE_DB, undefined);
  } finally {
    await manager.dispose();
    await rm(historyDir, { recursive: true, force: true });
  }
});

test("terminal manager debounce-persists history to its terminal-scoped log", async () => {
  const { adapter, historyDir, manager } = await fixture();
  const logPath = join(historyDir, `${THREAD_ID}_term-1.log`);
  try {
    const unsubscribe = await manager.attach({
      threadId: THREAD_ID,
      terminalId: "term-1",
      cwd: historyDir,
    }, () => {});
    adapter.processes[0]!.emitData("first ");
    adapter.processes[0]!.emitData("second\n");

    assert.equal(await readFile(logPath, "utf8"), "");
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(await readFile(logPath, "utf8"), "first second\n");
    unsubscribe();
  } finally {
    await manager.dispose();
    await rm(historyDir, { recursive: true, force: true });
  }
});

test("terminal history carries split escape sequences and strips replay-unsafe queries", async () => {
  const { adapter, historyDir, manager } = await fixture();
  try {
    await manager.attach({ threadId: THREAD_ID, terminalId: "term-1", cwd: historyDir }, () => {});
    const process = adapter.processes[0]!;
    process.emitData("prompt \u001b]11;");
    process.emitData("rgb:ffff/ffff/ffff\u0007\u001b[1;1");
    process.emitData("R\u001b[36mdone\u001b[0m\n");

    assert.equal(manager.snapshot(THREAD_ID, "term-1")?.history, "prompt \u001b[36mdone\u001b[0m\n");
  } finally {
    await manager.dispose();
    await rm(historyDir, { recursive: true, force: true });
  }
});

test("terminal close escalates from SIGTERM to SIGKILL after the grace period", async () => {
  const { adapter, historyDir, manager } = await fixture({ killGraceMs: 15 });
  try {
    await manager.attach({ threadId: THREAD_ID, terminalId: "term-1", cwd: historyDir }, () => {});
    const process = adapter.processes[0]!;
    await manager.close(THREAD_ID, "term-1");

    assert.deepEqual(process.killSignals, ["SIGTERM"]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(process.killSignals, ["SIGTERM", "SIGKILL"]);
    assert.equal(manager.snapshot(THREAD_ID, "term-1"), null);
  } finally {
    await manager.dispose();
    await rm(historyDir, { recursive: true, force: true });
  }
});

test("terminal manager restores persisted history as an exited restartable session", async () => {
  const { adapter, historyDir, manager } = await fixture();
  let restored: TerminalManager | null = null;
  try {
    await manager.attach({ threadId: THREAD_ID, terminalId: "term-1", cwd: historyDir }, () => {});
    adapter.processes[0]!.emitData("survives restart\n");
    adapter.processes[0]!.emitExit(0);
    await new Promise((resolve) => setTimeout(resolve, 80));
    await manager.dispose();

    const restoredAdapter = new FakePtyAdapter();
    restored = new TerminalManager({ adapter: restoredAdapter, historyDir, env: { SHELL: "/bin/bash" } });
    const events: TerminalServerMessage[] = [];
    await restored.attach({ threadId: THREAD_ID, terminalId: "term-1", cwd: historyDir }, (event) => events.push(event));

    assert.deepEqual(events, [{ type: "snapshot", history: "survives restart\n", status: "exited", pid: null }]);
    assert.equal(restoredAdapter.processes.length, 0);
  } finally {
    await manager.dispose();
    await restored?.dispose();
    await rm(historyDir, { recursive: true, force: true });
  }
});

test("terminal manager restarts an exited session with cleared history", async () => {
  const { adapter, historyDir, manager } = await fixture();
  try {
    await manager.attach({ threadId: THREAD_ID, terminalId: "term-1", cwd: historyDir }, () => {});
    adapter.processes[0]!.emitData("old output\n");
    adapter.processes[0]!.emitExit(0);
    const events: TerminalServerMessage[] = [];
    const unsubscribe = await manager.attach(
      { threadId: THREAD_ID, terminalId: "term-1", cwd: historyDir },
      (event) => events.push(event),
    );

    await manager.restart(THREAD_ID, "term-1");

    assert.equal(adapter.processes.length, 2);
    assert.equal(manager.snapshot(THREAD_ID, "term-1")?.status, "running");
    assert.equal(manager.snapshot(THREAD_ID, "term-1")?.history, "");
    assert.equal(events.at(-1)?.type, "restarted");
    unsubscribe();
  } finally {
    await manager.dispose();
    await rm(historyDir, { recursive: true, force: true });
  }
});

test("terminal attach sends one snapshot before flushing output produced during the handshake", async () => {
  const { adapter, historyDir, manager } = await fixture();
  try {
    const events: TerminalServerMessage[] = [];
    const unsubscribe = await manager.attach(
      { threadId: THREAD_ID, terminalId: "term-1", cwd: historyDir },
      (event) => {
        events.push(event);
        if (event.type === "snapshot") adapter.processes[0]!.emitData("during snapshot\n");
      },
    );

    assert.deepEqual(events.map((event) => event.type), ["snapshot", "output"]);
    assert.deepEqual(events[1], { type: "output", data: "during snapshot\n" });
    unsubscribe();
  } finally {
    await manager.dispose();
    await rm(historyDir, { recursive: true, force: true });
  }
});

test("terminal attach does not replay output already included in its snapshot", async () => {
  const { adapter, historyDir, manager } = await fixture();
  adapter.dataOnSubscribe = "before snapshot\n";
  try {
    const events: TerminalServerMessage[] = [];
    await manager.attach(
      { threadId: THREAD_ID, terminalId: "term-1", cwd: historyDir },
      (event) => events.push(event),
    );

    assert.deepEqual(events, [{
      type: "snapshot",
      history: "before snapshot\n",
      status: "running",
      pid: 1000,
    }]);
  } finally {
    await manager.dispose();
    await rm(historyDir, { recursive: true, force: true });
  }
});

test("terminal manager forwards writes and resizes only for valid session ids", async () => {
  const { adapter, historyDir, manager } = await fixture();
  try {
    await manager.attach({ threadId: THREAD_ID, terminalId: "term-1", cwd: historyDir }, () => {});
    manager.write(THREAD_ID, "term-1", "echo hi\n");
    manager.resize(THREAD_ID, "term-1", 132, 48);

    assert.deepEqual(adapter.processes[0]?.writes, ["echo hi\n"]);
    assert.deepEqual(adapter.processes[0]?.resizes, [{ cols: 132, rows: 48 }]);
    await assert.rejects(manager.attach({
      threadId: "../../escape",
      terminalId: "term-1",
      cwd: historyDir,
    }, () => {}), /invalid terminal thread id/i);
    await assert.rejects(manager.attach({
      threadId: THREAD_ID,
      terminalId: "../escape",
      cwd: historyDir,
    }, () => {}), /invalid terminal id/i);
  } finally {
    await manager.dispose();
    await rm(historyDir, { recursive: true, force: true });
  }
});

test("terminal manager caps retained exited sessions", async () => {
  const { adapter, historyDir, manager } = await fixture({ maxRetainedExited: 2 });
  try {
    for (const terminalId of ["term-1", "term-2", "term-3"]) {
      await manager.attach({ threadId: THREAD_ID, terminalId, cwd: historyDir }, () => {});
      adapter.processes.at(-1)!.emitExit(0);
    }
    assert.equal(manager.snapshot(THREAD_ID, "term-1"), null);
    assert.equal(manager.snapshot(THREAD_ID, "term-2")?.status, "exited");
    assert.equal(manager.snapshot(THREAD_ID, "term-3")?.status, "exited");
  } finally {
    await manager.dispose();
    await rm(historyDir, { recursive: true, force: true });
  }
});

test("terminal manager deduplicates concurrent first attaches", async () => {
  const { adapter, historyDir, manager } = await fixture();
  try {
    await Promise.all([
      manager.attach({ threadId: THREAD_ID, terminalId: "term-1", cwd: historyDir }, () => {}),
      manager.attach({ threadId: THREAD_ID, terminalId: "term-1", cwd: historyDir }, () => {}),
    ]);
    assert.equal(adapter.processes.length, 1);
  } finally {
    await manager.dispose();
    await rm(historyDir, { recursive: true, force: true });
  }
});

test("terminal manager flushes pending history and escalates active PTYs on dispose", async () => {
  const { adapter, historyDir, manager } = await fixture({ persistDebounceMs: 1000, killGraceMs: 10 });
  try {
    await manager.attach({ threadId: THREAD_ID, terminalId: "term-1", cwd: historyDir }, () => {});
    adapter.processes[0]!.emitData("pending history\n");

    await manager.dispose();

    assert.equal(await readFile(join(historyDir, `${THREAD_ID}_term-1.log`), "utf8"), "pending history\n");
    assert.deepEqual(adapter.processes[0]?.killSignals, ["SIGTERM", "SIGKILL"]);
  } finally {
    await manager.dispose();
    await rm(historyDir, { recursive: true, force: true });
  }
});

test("a failed first spawn does not leave a restorable history marker", async () => {
  const { adapter, historyDir, manager } = await fixture();
  adapter.spawnError = () => Object.assign(new Error("permission denied"), { code: "EACCES" });
  try {
    await assert.rejects(
      manager.attach({ threadId: THREAD_ID, terminalId: "term-1", cwd: historyDir }, () => {}),
      /permission denied/,
    );
    adapter.spawnError = null;
    await manager.attach({ threadId: THREAD_ID, terminalId: "term-1", cwd: historyDir }, () => {});
    assert.equal(adapter.processes.length, 1);
    assert.equal(manager.snapshot(THREAD_ID, "term-1")?.status, "running");
  } finally {
    await manager.dispose();
    await rm(historyDir, { recursive: true, force: true });
  }
});

test("restart is published before synchronous output from the new PTY", async () => {
  const { adapter, historyDir, manager } = await fixture();
  try {
    await manager.attach({ threadId: THREAD_ID, terminalId: "term-1", cwd: historyDir }, () => {});
    adapter.processes[0]!.emitExit(0);
    const events: TerminalServerMessage[] = [];
    await manager.attach(
      { threadId: THREAD_ID, terminalId: "term-1", cwd: historyDir },
      (event) => events.push(event),
    );
    adapter.dataOnSubscribe = "new prompt\n";

    await manager.restart(THREAD_ID, "term-1");

    assert.deepEqual(events.slice(-2), [
      { type: "restarted" },
      { type: "output", data: "new prompt\n" },
    ]);
  } finally {
    await manager.dispose();
    await rm(historyDir, { recursive: true, force: true });
  }
});
