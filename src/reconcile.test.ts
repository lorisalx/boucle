import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseStatusLine, statusProtocolInstruction, TicketReconciler } from "./reconcile.ts";
import { BoucleStore } from "./store.ts";

const IDENTITY = { appName: "Boucle", ownerName: "", orgName: "", demoMode: false };

async function withStore(fn: (store: BoucleStore) => void | Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "boucle-reconcile-test-"));
  try {
    await fn(new BoucleStore(join(dir, "reconcile.db"), IDENTITY));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ── parseStatusLine ─────────────────────────────────────────────────────────

test("parseStatusLine reads a bare STATUS line", () => {
  assert.equal(parseStatusLine("Did the work.\nSTATUS: done"), "done");
  assert.equal(parseStatusLine("STATUS: blocked"), "blocked");
  assert.equal(parseStatusLine("STATUS: in_progress"), "in_progress");
});

test("parseStatusLine tolerates the decorations agents actually emit", () => {
  assert.equal(parseStatusLine("- STATUS: done"), "done");
  assert.equal(parseStatusLine("**STATUS**: done"), "done");
  assert.equal(parseStatusLine("STATUS: **done**"), "done");
  assert.equal(parseStatusLine("> STATUS: done"), "done");
  assert.equal(parseStatusLine("  status: DONE  "), "done");
  assert.equal(parseStatusLine("STATUS: done."), "done");
});

test("parseStatusLine takes the LAST status line, so a quoted protocol cannot hijack it", () => {
  const output = [
    "The instructions said to end with STATUS: dropped",
    "but the real outcome is different.",
    "STATUS: done",
  ].join("\n");
  assert.equal(parseStatusLine(output), "done");
});

test("parseStatusLine returns null when there is no well-formed line", () => {
  assert.equal(parseStatusLine(""), null);
  assert.equal(parseStatusLine("All finished, looks done to me!"), null);
  assert.equal(parseStatusLine("STATUS: finished"), null, "unknown value is not a status");
  assert.equal(parseStatusLine("The STATUS: done marker goes at the end"), null, "must own its line");
});

test("statusProtocolInstruction names every accepted value", () => {
  const text = statusProtocolInstruction();
  for (const status of ["inbox", "triaged", "next", "snoozed", "blocked", "in_progress", "done", "dropped"]) {
    assert.ok(text.includes(status), `instruction should mention ${status}`);
  }
});

// ── TicketReconciler ────────────────────────────────────────────────────────

test("a finished run with STATUS: done transitions its ticket", async () => {
  await withStore((store) => {
    const ticket = store.upsert({ dedupeKey: "r:1", title: "Ship it", source: "manual" });
    const run = store.recordRunStart("vibe:enrich", "enrich", "vibe");
    store.linkRunToTicket(run.runId, ticket.ticketId);
    store.recordRunFinish(run.runId, "vibe:enrich", "ok", 0, "Work complete.\nSTATUS: done", null, null);

    const outcome = new TicketReconciler(store).reconcileOnce();

    assert.equal(outcome.scanned, 1);
    assert.equal(outcome.transitioned, 1);
    assert.equal(store.getById(ticket.ticketId)!.status, "done");
  });
});

test("a pre-protocol run (no STATUS line) records an event and never guesses a transition", async () => {
  await withStore((store) => {
    const ticket = store.upsert({ dedupeKey: "r:2", title: "Old thread", source: "manual" });
    const before = store.getById(ticket.ticketId)!.status;
    const run = store.recordRunStart("vibe:enrich", "enrich", "vibe");
    store.linkRunToTicket(run.runId, ticket.ticketId);
    store.recordRunFinish(run.runId, "vibe:enrich", "ok", 0, "I finished the task, it is all done.", null, null);

    const outcome = new TicketReconciler(store).reconcileOnce();

    assert.equal(outcome.noStatus, 1);
    assert.equal(outcome.transitioned, 0);
    assert.equal(store.getById(ticket.ticketId)!.status, before, "status must be untouched");
    const events = store.listEvents(ticket.ticketId);
    assert.ok(
      events.some((e) => e.kind === "note" && e.summary.includes("without a STATUS line")),
      "the observation should still be recorded",
    );
  });
});

test("a run is reconciled exactly once", async () => {
  await withStore((store) => {
    const ticket = store.upsert({ dedupeKey: "r:3", title: "Once only", source: "manual" });
    const run = store.recordRunStart("vibe:enrich", "enrich", "vibe");
    store.linkRunToTicket(run.runId, ticket.ticketId);
    store.recordRunFinish(run.runId, "vibe:enrich", "ok", 0, "STATUS: done", null, null);

    const reconciler = new TicketReconciler(store);
    assert.equal(reconciler.reconcileOnce().transitioned, 1);
    // A human moves it back; a second pass must not re-apply the old run.
    store.transition(ticket.ticketId, "next", null, "reopened by hand");
    assert.equal(reconciler.reconcileOnce().scanned, 0);
    assert.equal(store.getById(ticket.ticketId)!.status, "next");
  });
});

test("an unfinished run is not reconciled while it is still running", async () => {
  await withStore((store) => {
    const ticket = store.upsert({ dedupeKey: "r:4", title: "Still going", source: "manual" });
    const run = store.recordRunStart("vibe:enrich", "enrich", "vibe");
    store.linkRunToTicket(run.runId, ticket.ticketId);

    assert.equal(new TicketReconciler(store).reconcileOnce().scanned, 0);
    assert.equal(store.getById(ticket.ticketId)!.status, "inbox");
  });
});

test("reconciliation does not depend on loops being enabled", async () => {
  await withStore((store) => {
    // The exact production failure this design exists to prevent: the sweep loop is off,
    // so anything gated behind it would silently never run.
    store.setMeta("loopEnabled", "0");
    const ticket = store.upsert({ dedupeKey: "r:5", title: "Off-hours work", source: "manual" });
    const run = store.recordRunStart("vibe:enrich", "enrich", "vibe");
    store.linkRunToTicket(run.runId, ticket.ticketId);
    store.recordRunFinish(run.runId, "vibe:enrich", "ok", 0, "STATUS: done", null, null);

    assert.equal(new TicketReconciler(store).reconcileOnce().transitioned, 1);
    assert.equal(store.getById(ticket.ticketId)!.status, "done");
  });
});

test("an agent confirming the current status records a note without transitioning", async () => {
  await withStore((store) => {
    const ticket = store.upsert({ dedupeKey: "r:6", title: "Already there", source: "manual" });
    store.transition(ticket.ticketId, "blocked", null, "waiting on review");
    const run = store.recordRunStart("vibe:enrich", "enrich", "vibe");
    store.linkRunToTicket(run.runId, ticket.ticketId);
    store.recordRunFinish(run.runId, "vibe:enrich", "ok", 0, "STATUS: blocked", null, null);

    const outcome = new TicketReconciler(store).reconcileOnce();

    assert.equal(outcome.transitioned, 0);
    assert.equal(store.getById(ticket.ticketId)!.status, "blocked");
    assert.ok(store.listEvents(ticket.ticketId).some((e) => e.summary.includes("unchanged")));
  });
});

test("a run whose ticket was deleted is marked reconciled and skipped", async () => {
  await withStore((store) => {
    const run = store.recordRunStart("vibe:enrich", "enrich", "vibe");
    store.linkRunToTicket(run.runId, "ticket-that-never-existed");
    store.recordRunFinish(run.runId, "vibe:enrich", "ok", 0, "STATUS: done", null, null);

    const reconciler = new TicketReconciler(store);
    assert.equal(reconciler.reconcileOnce().scanned, 1);
    assert.equal(reconciler.reconcileOnce().scanned, 0, "should not be picked up again");
  });
});

test("runs that finished before the reconciler existed are not replayed", async () => {
  await withStore((store) => {
    // Simulates the migration backfill: an old finished run gets reconciled_at stamped so
    // the first scan after upgrading does not re-transition months of settled tickets.
    const ticket = store.upsert({ dedupeKey: "r:7", title: "Ancient history", source: "manual" });
    const run = store.recordRunStart("vibe:enrich", "enrich", "vibe");
    store.linkRunToTicket(run.runId, ticket.ticketId);
    store.recordRunFinish(run.runId, "vibe:enrich", "ok", 0, "STATUS: dropped", null, null);
    store.markRunReconciled(run.runId);

    assert.equal(new TicketReconciler(store).reconcileOnce().scanned, 0);
    assert.equal(store.getById(ticket.ticketId)!.status, "inbox");
  });
});
