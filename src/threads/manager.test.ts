import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BoucleStore } from "../store.ts";
import type { LiveSession, RuntimeEvent, ThreadAdapter } from "./events.ts";
import { ThreadManager } from "./manager.ts";

class FakeAdapter implements ThreadAdapter {
  readonly engine = "claude" as const;
  onEvent: ((event: RuntimeEvent) => void) | null = null;
  stopped = false;

  async start(opts: { onEvent: (event: RuntimeEvent) => void }): Promise<LiveSession> {
    this.onEvent = opts.onEvent;
    opts.onEvent({ type: "session.started", nativeSessionId: "native-session" });
    return {
      sendTurn: async () => {
        opts.onEvent({ type: "turn.started", turnId: "turn-1" });
        opts.onEvent({ type: "content.delta", text: "pi" });
        opts.onEvent({ type: "content.delta", text: "ng" });
        opts.onEvent({ type: "message.completed", text: "ping" });
        opts.onEvent({ type: "turn.completed", turnId: "turn-1" });
      },
      interrupt: async () => opts.onEvent({ type: "turn.aborted", turnId: "turn-1" }),
      respond: async () => {},
      stop: async () => { this.stopped = true; },
      resumeCursor: () => ({ resume: "native-session" }),
    };
  }
}

test("thread manager folds deltas, assigns monotonic sequences, and fans out without gaps", async () => {
  const dir = await mkdtemp(join(tmpdir(), "boucle-thread-manager-"));
  const store = new BoucleStore(join(dir, "boucle.db"), { appName: "Boucle", ownerName: "", orgName: "", demoMode: false });
  const adapter = new FakeAdapter();
  const manager = new ThreadManager(store, [adapter], 60_000, 60_000);
  try {
    const thread = store.createThread({ engine: "claude", cwd: dir });
    assert.deepEqual(thread.settings, { permissionMode: "acceptEdits" });
    const streamed: number[] = [];
    const unsubscribe = manager.subscribe(thread.threadId, 0, (event) => streamed.push(event.sequence));
    await manager.sendTurn(thread.threadId, "reply ping");

    const snapshot = manager.snapshot(thread.threadId)!;
    assert.deepEqual(snapshot.events.map((event) => event.sequence), snapshot.events.map((_, index) => index + 1));
    assert.deepEqual(streamed, snapshot.events.map((event) => event.sequence));
    const assistant = snapshot.events.filter((event) => event.kind === "message" && (event.payload as { role?: string }).role === "assistant");
    assert.deepEqual(assistant.map((event) => event.payload), [
      { role: "assistant", content: "ping", streaming: true },
      { role: "assistant", content: "", streaming: false },
    ]);
    assert.equal(snapshot.thread.status, "idle");
    assert.deepEqual(snapshot.thread.resumeCursor, { resume: "native-session" });

    const replayed: number[] = [];
    manager.subscribe(thread.threadId, 2, (event) => replayed.push(event.sequence))();
    assert.deepEqual(replayed, snapshot.events.filter((event) => event.sequence > 2).map((event) => event.sequence));
    unsubscribe();
  } finally {
    await manager.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
