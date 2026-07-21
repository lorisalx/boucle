import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BoucleStore } from "./store.ts";

/**
 * A loop that reuses one agent session forever grows the conversation until the
 * provider refuses the prompt. The dispatch still succeeds, so the loop reports `ok`
 * while the agent never runs — the failure is invisible from Boucle's side. The
 * scheduler retires a session once countRunsForSession reaches its bound, so this
 * pins the counter that decision rests on.
 */
async function withStore(run: (store: BoucleStore) => void | Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "boucle-session-rotation-"));
  const store = new BoucleStore(join(dir, "boucle.db"));
  try {
    await run(store);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("runs are counted per session so a long-lived one can be retired", async () => {
  await withStore((store) => {
    const loop = store.createLoop({
      name: "Chief of staff",
      description: "",
      prompt: "do the thing",
      enabled: true,
      intervalMinutes: 60,
      activeDays: "",
      activeStartHour: 0,
      activeEndHour: 0,
      timezone: "UTC",
      codexHome: null,
      profile: null,
      model: "claude-sonnet-5",
      runner: "t3code",
    });

    assert.equal(store.countRunsForSession(loop.loopId, "thread-1"), 0);

    for (let i = 0; i < 3; i++) {
      const run = store.recordRunStart(loop.loopId, "schedule", "t3code");
      store.recordRunFinish(run.runId, loop.loopId, "ok", 0, "dispatched", null, "thread-1");
    }
    assert.equal(store.countRunsForSession(loop.loopId, "thread-1"), 3);

    // A fresh session starts its own count, so rotating resets the budget.
    const rotated = store.recordRunStart(loop.loopId, "schedule", "t3code");
    store.recordRunFinish(rotated.runId, loop.loopId, "ok", 0, "dispatched", null, "thread-2");
    assert.equal(store.countRunsForSession(loop.loopId, "thread-2"), 1);
    assert.equal(store.countRunsForSession(loop.loopId, "thread-1"), 3);
  });
});

test("another loop's runs never count against this loop's session", async () => {
  await withStore((store) => {
    const base = {
      description: "",
      prompt: "do the thing",
      enabled: true,
      intervalMinutes: 60,
      activeDays: "",
      activeStartHour: 0,
      activeEndHour: 0,
      timezone: "UTC",
      codexHome: null,
      profile: null,
      model: "claude-sonnet-5",
      runner: "t3code" as const,
    };
    const a = store.createLoop({ ...base, name: "Loop A" });
    const b = store.createLoop({ ...base, name: "Loop B" });

    const runA = store.recordRunStart(a.loopId, "schedule", "t3code");
    store.recordRunFinish(runA.runId, a.loopId, "ok", 0, "dispatched", null, "shared-thread");
    const runB = store.recordRunStart(b.loopId, "schedule", "t3code");
    store.recordRunFinish(runB.runId, b.loopId, "ok", 0, "dispatched", null, "shared-thread");

    assert.equal(store.countRunsForSession(a.loopId, "shared-thread"), 1);
    assert.equal(store.countRunsForSession(b.loopId, "shared-thread"), 1);
  });
});
