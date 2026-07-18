/**
 * Boucle scheduler — owns loop timing and runs every due loop through Vibe CLI.
 */
import { BOUCLE_PORT } from "./config.ts";
import { getMcpToken } from "./mcp.ts";
import type { BoucleStore, Loop, LoopRun, LoopRunTrigger } from "./store.ts";
import { execVibe, type VibeExecResult, type VibeExecSpec } from "./vibe.ts";

const TICK_MS = 30_000;
const MAX_SUMMARY_CHARS = 8_000;

/** Whether `nowMs` falls inside the loop's active day/hour window (in its timezone). */
export function isWithinWindow(loop: Loop, nowMs: number): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: loop.timezone,
    weekday: "short",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(nowMs);
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hour = Number.parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10) % 24;

  const days = loop.activeDays.split(",").map((s) => s.trim()).filter(Boolean);
  if (days.length > 0 && !days.includes(weekday)) return false;

  const { activeStartHour: start, activeEndHour: end } = loop;
  if (start === end) return true;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/** Due = inside the window AND at least intervalMinutes since the last run. */
export function isDue(loop: Loop, nowMs: number): boolean {
  if (!isWithinWindow(loop, nowMs)) return false;
  if (loop.lastRunAt === null) return true;
  const last = Date.parse(loop.lastRunAt);
  if (Number.isNaN(last)) return true;
  return nowMs - last >= loop.intervalMinutes * 60_000;
}

export class LoopScheduler {
  private readonly running = new Set<string>();
  private readonly smartRuns = new Map<
    string,
    { batchId: string; status: "running" | "ok" | "error" | "timeout"; startedAt: string; finishedAt: string | null; detail: string }
  >();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastBudgetWarning: string | null = null;

  constructor(
    private readonly store: BoucleStore,
    private readonly dbPath: string,
  ) {}

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    if (typeof this.timer.unref === "function") this.timer.unref();
    this.tick();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  isRunning(loopId: string): boolean {
    return this.running.has(loopId);
  }

  private tick(): void {
    if (this.store.getMeta("loopEnabled") !== "1") return;
    const nowMs = Date.now();
    for (const loop of this.store.listEnabledLoops()) {
      if (this.running.has(loop.loopId) || !isDue(loop, nowMs)) continue;
      try {
        this.run(loop, "schedule");
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
      }
    }
  }

  /** Spawn a loop now, bypassing the due/window check. Returns null if already running. */
  runNow(loopId: string): LoopRun | null {
    const loop = this.store.getLoop(loopId);
    if (!loop) throw new Error(`Loop not found: ${loopId}`);
    if (this.running.has(loopId)) return null;
    return this.run(loop, "manual");
  }

  isEnriching(ticketId: string): boolean {
    return this.running.has(`enrich:${ticketId}`);
  }

  /** One-shot Vibe run that re-investigates one ticket through Boucle MCP. */
  enrichTicket(ticketId: string, prompt: string): boolean {
    const key = `enrich:${ticketId}`;
    if (this.running.has(key)) return false;
    this.running.add(key);
    this.store.addEvent(ticketId, "note", "Vibe re-run requested");
    const base = this.store.listLoops()[0] ?? null;
    this.execVibe({ prompt, model: base?.model ?? null, scopeId: `${key}:${Date.now()}` })
      .then((res) => {
        const status = res.timedOut ? "timed out" : res.code === 0 ? "finished" : "failed";
        this.store.addEvent(ticketId, "note", `Vibe re-run ${status}`);
      })
      .catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : String(err);
        this.store.addEvent(ticketId, "note", `Vibe re-run failed: ${detail.slice(0, 200)}`);
      })
      .finally(() => this.running.delete(key));
    return true;
  }

  listSmartRuns(): Array<{ batchId: string; status: string; startedAt: string; finishedAt: string | null; detail: string }> {
    return [...this.smartRuns.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 10);
  }

  /** One-shot Vibe run that parses pasted text into Boucle items through MCP. */
  smartCapture(batchId: string, prompt: string): void {
    const key = `smart:${batchId}`;
    this.running.add(key);
    this.smartRuns.set(batchId, {
      batchId,
      status: "running",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      detail: "",
    });
    const base = this.store.listLoops()[0] ?? null;
    this.execVibe({ prompt, model: base?.model ?? null, scopeId: `${key}:${Date.now()}` })
      .then((res) => {
        const status = res.timedOut ? "timeout" : res.code === 0 ? "ok" : "error";
        const prev = this.smartRuns.get(batchId);
        if (prev) {
          this.smartRuns.set(batchId, {
            ...prev,
            status,
            finishedAt: new Date().toISOString(),
            detail: res.output.slice(-2_000),
          });
        }
      })
      .catch((err: unknown) => {
        const prev = this.smartRuns.get(batchId);
        const detail = err instanceof Error ? err.message : String(err);
        if (prev) {
          this.smartRuns.set(batchId, {
            ...prev,
            status: "error",
            finishedAt: new Date().toISOString(),
            detail: detail.slice(0, 2_000),
          });
        }
      })
      .finally(() => this.running.delete(key));
  }

  private run(loop: Loop, trigger: LoopRunTrigger): LoopRun {
    const budget = this.store.getLoopCostSummary();
    if (budget.warning && budget.warning !== this.lastBudgetWarning) {
      console.warn(budget.warning);
      this.lastBudgetWarning = budget.warning;
    }
    if (budget.blocked) {
      throw new Error(budget.warning ?? "Vibe loop budget exhausted; refusing to start a new run.");
    }

    this.running.add(loop.loopId);
    const run = this.store.recordRunStart(loop.loopId, trigger);
    this.runLoop(loop, trigger)
      .then((res) => {
        const status = res.timedOut ? "timeout" : res.code === 0 ? "ok" : "error";
        if (res.sessionId) {
          this.store.updateLoop({
            loopId: loop.loopId,
            threadId: res.sessionId,
            threadProject: "vibe",
            threadOpenUrl: null,
          });
        }
        this.store.recordRunFinish(
          run.runId,
          loop.loopId,
          status,
          res.code,
          res.output.slice(-MAX_SUMMARY_CHARS),
          res.costUsd,
          res.sessionId,
        );
        const updatedBudget = this.store.getLoopCostSummary();
        if (updatedBudget.warning && updatedBudget.warning !== this.lastBudgetWarning) {
          console.warn(updatedBudget.warning);
          this.lastBudgetWarning = updatedBudget.warning;
        }
      })
      .catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : String(err);
        this.store.recordRunFinish(
          run.runId,
          loop.loopId,
          "error",
          null,
          detail.slice(-MAX_SUMMARY_CHARS),
          null,
          null,
        );
      })
      .finally(() => this.running.delete(loop.loopId));
    return run;
  }

  private runLoop(loop: Loop, trigger: LoopRunTrigger): Promise<VibeExecResult> {
    return this.execVibe({
      prompt: buildLoopTurnPrompt(loop, trigger),
      model: loop.model,
      sessionId: loop.threadId,
      scopeId: `loops/${loop.loopId}`,
    });
  }

  private execVibe(spec: VibeExecSpec): Promise<VibeExecResult> {
    return execVibe(spec, {
      dbPath: this.dbPath,
      mcpToken: getMcpToken(this.store),
      mcpUrl: `http://127.0.0.1:${BOUCLE_PORT}/mcp`,
      workdir: process.cwd(),
    });
  }
}

function buildLoopTurnPrompt(loop: Loop, trigger: LoopRunTrigger): string {
  return [
    `Run Boucle loop "${loop.name}" now.`,
    "",
    `Trigger: ${trigger}`,
    `Scheduled window: ${loop.activeDays || "every day"} ${loop.activeStartHour}:00-${loop.activeEndHour}:00 ${loop.timezone}`,
    "",
    "Loop instructions:",
    loop.prompt,
    "",
    "Use Boucle MCP tools for ticket operations. When you finish, summarize what changed in this thread.",
  ].join("\n");
}
