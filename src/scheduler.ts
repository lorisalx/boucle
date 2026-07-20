/**
 * Boucle scheduler — owns loop timing and runs every due loop through its selected agent runner.
 */
import { BOUCLE_PORT } from "./config.ts";
import { getMcpToken } from "./mcp.ts";
import { getAgentRunner, type AgentExecResult, type AgentExecSpec, type AgentRunner } from "./runner.ts";
import type { RunnerName } from "./settings.ts";
import type { BoucleStore, Loop, LoopRun, LoopRunTrigger } from "./store.ts";

const TICK_MS = 30_000;
const MAX_SUMMARY_CHARS = 8_000;

function budgetThreshold(name: string, fallback: number): number {
  const value = Number.parseFloat(process.env[name] ?? "");
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

const BUDGET_WARN = budgetThreshold("BOUCLE_AGENT_BUDGET_WARN", 10);
const BUDGET_STOP = budgetThreshold("BOUCLE_AGENT_BUDGET_STOP", 30);
// The budget is a rolling window (default ~monthly), so a long-lived instance frees up spend over
// time instead of bricking on cumulative history.
const BUDGET_WINDOW_DAYS = Math.max(1, Math.trunc(budgetThreshold("BOUCLE_AGENT_BUDGET_WINDOW_DAYS", 30)));

function positiveNumber(name: string, fallback: number): number {
  const value = Number.parseFloat(process.env[name] ?? "");
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function getAgentBudgetThresholds(): { warnUsd: number; stopUsd: number } {
  return { warnUsd: BUDGET_WARN, stopUsd: BUDGET_STOP };
}

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
  private readonly vibeScopes = new Set<string>();
  private readonly smartRuns = new Map<
    string,
    { batchId: string; status: "running" | "ok" | "error" | "timeout"; startedAt: string; finishedAt: string | null; detail: string }
  >();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastBudgetWarning: string | null = null;

  private readonly store: BoucleStore;
  private readonly dbPath: string;
  private readonly runnerOverride: AgentRunner | null;

  constructor(store: BoucleStore, dbPath: string, runner: AgentRunner | null = null) {
    this.store = store;
    this.dbPath = dbPath;
    this.runnerOverride = runner;
  }

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
    return this.running.has(loopId) || this.vibeScopes.has(`loops_${loopId}`);
  }

  isVibeRunning(scope: string): boolean {
    const loop = scope.startsWith("loops_") ? this.store.getLoop(scope.slice("loops_".length)) : null;
    return this.vibeScopes.has(scope) || (loop !== null && this.running.has(loop.loopId));
  }

  private tick(): void {
    if (this.store.getMeta("loopEnabled") !== "1") return;
    const nowMs = Date.now();
    for (const loop of this.store.listEnabledLoops()) {
      if (this.isRunning(loop.loopId) || !isDue(loop, nowMs)) continue;
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
    if (this.isRunning(loopId)) return null;
    return this.run(loop, "manual");
  }

  /** Continue an existing Vibe transcript without blocking the request that started it. */
  continueVibeThread(scope: string, sessionId: string, prompt: string): boolean {
    if (this.isVibeRunning(scope)) return false;
    this.assertAgentBudget();
    const loop = scope.startsWith("loops_") ? this.store.getLoop(scope.slice("loops_".length)) : null;
    this.vibeScopes.add(scope);
    let execution: Promise<AgentExecResult>;
    try {
      const vibe = getAgentRunner("vibe", this.store);
      execution = this.execTracked(
        vibe,
        { prompt, resumeSessionId: sessionId, scope, model: loop?.model ?? null },
        "vibe_thread",
      );
    } catch (error) {
      this.vibeScopes.delete(scope);
      throw error;
    }
    execution
      .then((res) => {
        if (loop && res.sessionId) {
          this.store.updateLoop({
            loopId: loop.loopId,
            threadId: res.sessionId,
            threadProject: "vibe",
            threadOpenUrl: null,
          });
        }
      })
      .catch((err: unknown) => console.error(err instanceof Error ? err.message : String(err)))
      .finally(() => this.vibeScopes.delete(scope));
    return true;
  }

  isEnriching(ticketId: string): boolean {
    return this.running.has(`enrich:${ticketId}`);
  }

  /** One-shot global-runner invocation that re-investigates one ticket through Boucle MCP. */
  enrichTicket(ticketId: string, prompt: string): boolean {
    const key = `enrich:${ticketId}`;
    if (this.running.has(key)) return false;
    this.assertAgentBudget();
    this.running.add(key);
    const runner = this.runnerFor(null);
    this.store.addEvent(ticketId, "note", `${runner.name} re-run requested`);
    this.execTracked(runner, {
      prompt,
      model: this.auxiliaryModel(runner),
      resumeSessionId: null,
      scope: `${key}:${Date.now()}`,
    }, "enrich")
      .then((res) => {
        const status = res.timedOut ? "timed out" : res.code === 0 ? "finished" : "failed";
        this.store.addEvent(ticketId, "note", `${runner.name} re-run ${status}`);
      })
      .catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : String(err);
        this.store.addEvent(ticketId, "note", `${runner.name} re-run failed: ${detail.slice(0, 200)}`);
      })
      .finally(() => this.running.delete(key));
    return true;
  }

  listSmartRuns(): Array<{ batchId: string; status: string; startedAt: string; finishedAt: string | null; detail: string }> {
    return [...this.smartRuns.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 10);
  }

  /** One-shot global-runner invocation that parses pasted text into Boucle items through MCP. */
  smartCapture(batchId: string, prompt: string): void {
    const key = `smart:${batchId}`;
    this.assertAgentBudget();
    this.running.add(key);
    this.smartRuns.set(batchId, {
      batchId,
      status: "running",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      detail: "",
    });
    const runner = this.runnerFor(null);
    this.execTracked(runner, {
      prompt,
      model: this.auxiliaryModel(runner),
      resumeSessionId: null,
      scope: `${key}:${Date.now()}`,
    }, "smart_capture")
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
    this.assertAgentBudget();

    this.running.add(loop.loopId);
    const runner = this.runnerFor(loop.runner);
    const run = this.store.recordRunStart(loop.loopId, trigger, runner.name);
    this.runLoop(loop, trigger, runner)
      .then((res) => {
        const status = res.timedOut ? "timeout" : res.code === 0 ? "ok" : "error";
        if (res.sessionId) {
          this.store.updateLoop({
            loopId: loop.loopId,
            threadId: res.sessionId,
            threadProject: runner.name,
            threadOpenUrl: res.openUrl ?? null,
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
        const updatedBudget = this.getBudgetSummary();
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

  private runLoop(loop: Loop, trigger: LoopRunTrigger, runner: AgentRunner): Promise<AgentExecResult> {
    return this.execRunner(runner, {
      prompt: buildLoopTurnPrompt(loop, trigger),
      model: loop.model,
      title: loop.name,
      resumeSessionId: loop.threadProject === runner.name ? loop.threadId : null,
      scope: `loops_${loop.loopId}`,
    });
  }

  private runnerFor(override: RunnerName | null): AgentRunner {
    return this.runnerOverride ?? getAgentRunner(override, this.store);
  }

  private auxiliaryModel(runner: AgentRunner): string | null {
    if (runner.name !== "vibe") return null;
    return this.store.listLoops()[0]?.model ?? null;
  }

  private execRunner(
    runner: AgentRunner,
    spec: Pick<AgentExecSpec, "prompt" | "model" | "resumeSessionId" | "scope" | "title">,
  ): Promise<AgentExecResult> {
    return runner.exec({
      ...spec,
      dbPath: this.dbPath,
      mcpToken: getMcpToken(this.store),
      mcpUrl: `http://127.0.0.1:${BOUCLE_PORT}/mcp`,
      workdir: process.cwd(),
      maxPriceUsd: positiveNumber("BOUCLE_VIBE_MAX_PRICE", 0.25),
      timeoutMin: positiveNumber("BOUCLE_LOOP_TIMEOUT_MIN", 12),
    });
  }

  getBudgetSummary() {
    // Reserve each in-flight run's max spend against the window, so concurrent starts cannot all
    // read the same under-cap total and slip through (the reservation reconciles to actual cost
    // once the run records its finish).
    const reserveUnit = positiveNumber("BOUCLE_VIBE_MAX_PRICE", 0.25);
    return this.store.getLoopCostSummary(BUDGET_WARN, BUDGET_STOP, BUDGET_WINDOW_DAYS, reserveUnit);
  }

  /** Apply the cumulative hard stop to every agent entry point. */
  assertAgentBudget(): void {
    const budget = this.getBudgetSummary();
    if (budget.warning && budget.warning !== this.lastBudgetWarning) {
      console.warn(budget.warning);
      this.lastBudgetWarning = budget.warning;
    }
    if (budget.blocked) {
      throw new Error(budget.warning ?? "Agent budget exhausted; refusing to start a new invocation.");
    }
  }

  /** Store one-shot agent work beside loop runs so its reported cost and session count toward the global budget. */
  private execTracked(
    runner: AgentRunner,
    spec: Pick<AgentExecSpec, "prompt" | "model" | "resumeSessionId" | "scope" | "title">,
    trigger: "smart_capture" | "enrich" | "vibe_thread",
  ): Promise<AgentExecResult> {
    const auxiliaryLoopId = `${runner.name}:${trigger}`;
    const run = this.store.recordRunStart(auxiliaryLoopId, trigger, runner.name);
    return this.execRunner(runner, spec)
      .then((res) => {
        const status = res.timedOut ? "timeout" : res.code === 0 ? "ok" : "error";
        this.store.recordRunFinish(
          run.runId,
          auxiliaryLoopId,
          status,
          res.code,
          res.output.slice(-MAX_SUMMARY_CHARS),
          res.costUsd,
          res.sessionId,
        );
        const updatedBudget = this.getBudgetSummary();
        if (updatedBudget.warning && updatedBudget.warning !== this.lastBudgetWarning) {
          console.warn(updatedBudget.warning);
          this.lastBudgetWarning = updatedBudget.warning;
        }
        return res;
      })
      .catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : String(err);
        this.store.recordRunFinish(
          run.runId,
          auxiliaryLoopId,
          "error",
          null,
          detail.slice(-MAX_SUMMARY_CHARS),
          null,
          null,
        );
        throw err;
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
