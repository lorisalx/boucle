/**
 * Ticket reconciliation — closes the loop between "an agent finished working on a ticket"
 * and "the ticket reflects that".
 *
 * ## The STATUS-line protocol
 *
 * An agent working a ticket ends its final message with a single machine-readable line:
 *
 *     STATUS: done
 *
 * The accepted values are the ticket lifecycle statuses (see STATUS_VALUES). The reconciler
 * reads that line off the finished run's summary and transitions the ticket accordingly.
 *
 * ## Why this runs on its own timer
 *
 * Reconciliation is deliberately NOT driven by the chief/sweep loop. If it were, disabling
 * that loop — or its schedule window closing, or its budget running out — would silently
 * stop reconciliation, and finished agent threads would never update their tickets. The
 * failure is invisible: the work happened, the queue just never learns about it.
 *
 * So the reconciler owns a timer that starts at boot and runs regardless of whether any
 * loop is enabled. The sweep loop additionally calls reconcileOnce() opportunistically, so
 * an active instance converges faster than the timer alone — but the timer is the guarantee.
 *
 * ## Pre-protocol threads
 *
 * A run whose summary carries no STATUS line predates the protocol, or the agent simply did
 * not emit one. Those are recorded as a note event and left alone. Guessing a transition
 * from prose ("looks done to me") silently corrupts the queue, so we never do it: a missing
 * STATUS line is an observation, never an instruction.
 */
import type { BoucleStore, TicketStatus } from "./store.ts";

/** How often the independent reconcile timer fires. */
export const RECONCILE_INTERVAL_MS = 120_000;

const STATUS_VALUES: ReadonlySet<string> = new Set<TicketStatus>([
  "inbox",
  "triaged",
  "next",
  "snoozed",
  "blocked",
  "in_progress",
  "done",
  "dropped",
]);

/**
 * Read the STATUS line out of an agent's output.
 *
 * Scans from the end so a trailing status wins over any earlier mention (an agent that
 * quotes the protocol mid-transcript must not be able to trigger a transition from there).
 * Returns null when no well-formed line is present — the caller must not guess.
 */
export function parseStatusLine(output: string): TicketStatus | null {
  if (!output) return null;
  const lines = output.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    // Tolerate leading list markers/whitespace and a bold-wrapped label, which agents add freely.
    const match = /^[\s>*-]*\**\s*STATUS\**\s*:\s*\**\s*([a-z_]+)\s*\**\s*\.?\s*$/i.exec(lines[i]!);
    if (!match) continue;
    const value = match[1]!.toLowerCase();
    return STATUS_VALUES.has(value) ? (value as TicketStatus) : null;
  }
  return null;
}

/** The instruction block appended to ticket-scoped agent prompts. */
export function statusProtocolInstruction(): string {
  return [
    "When you have finished, end your final message with a single line stating the ticket's new status:",
    "",
    "    STATUS: <inbox|triaged|next|snoozed|blocked|in_progress|done|dropped>",
    "",
    "Use `done` when the work is complete, `blocked` when you cannot proceed without someone else,",
    "and `in_progress` when you made progress but the ticket is not finished. Emit exactly one such",
    "line, as the last line of your final message. Without it the ticket's status is left unchanged.",
  ].join("\n");
}

export interface ReconcileOutcome {
  readonly scanned: number;
  readonly transitioned: number;
  readonly noStatus: number;
}

/**
 * Scans finished, ticket-linked runs and applies their STATUS line to the ticket.
 * Owns an independent timer so reconciliation never depends on a loop being enabled.
 */
export class TicketReconciler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  private readonly store: BoucleStore;

  constructor(store: BoucleStore) {
    this.store = store;
  }

  /** Start the independent timer. Safe to call twice; the second call is a no-op. */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      try {
        this.reconcileOnce();
      } catch (error) {
        console.error(`[reconcile] ${error instanceof Error ? error.message : String(error)}`);
      }
    }, RECONCILE_INTERVAL_MS);
    if (typeof this.timer.unref === "function") this.timer.unref();
    // Catch up on anything that finished while the process was down.
    this.reconcileOnce();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Process every pending run once. Safe to call from the sweep loop on top of the timer:
   * a re-entrancy guard means an opportunistic call during a timer pass is simply skipped,
   * and marking is idempotent so a run is never applied twice.
   */
  reconcileOnce(): ReconcileOutcome {
    if (this.running) return { scanned: 0, transitioned: 0, noStatus: 0 };
    this.running = true;
    try {
      const pending = this.store.listUnreconciledRuns();
      let transitioned = 0;
      let noStatus = 0;

      for (const run of pending) {
        const ticket = this.store.getById(run.ticketId);
        if (!ticket) {
          // The ticket was deleted while the agent worked; nothing to reconcile.
          this.store.markRunReconciled(run.runId);
          continue;
        }

        const status = parseStatusLine(run.summary);
        if (status === null) {
          // Pre-protocol or silent agent. Record the observation, change nothing.
          noStatus += 1;
          this.store.addEvent(
            ticket.ticketId,
            "note",
            "Agent thread finished without a STATUS line; ticket status left unchanged.",
          );
          this.store.markRunReconciled(run.runId);
          continue;
        }

        if (status === ticket.status) {
          // Agent confirmed the current state; no transition, but record that it reported in.
          this.store.addEvent(ticket.ticketId, "note", `Agent reported STATUS: ${status} (unchanged).`);
          this.store.markRunReconciled(run.runId);
          continue;
        }

        this.store.transition(ticket.ticketId, status, null, `reconciled from agent thread (${run.status})`);
        transitioned += 1;
        this.store.markRunReconciled(run.runId);
      }

      return { scanned: pending.length, transitioned, noStatus };
    } finally {
      this.running = false;
    }
  }
}
