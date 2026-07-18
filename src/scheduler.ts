/**
 * boucle scheduler — BOUCLE owns the loops and runs them.
 *
 * A single in-process tick (every TICK_MS) walks the enabled loops and, for each
 * one that is *due* (interval elapsed AND inside its active window) and not
 * already running, spawns `codex exec <prompt>` with the loop's profile/CODEX_HOME.
 * Each run is recorded in loop_runs; an in-memory set prevents overlapping runs of
 * the same loop within this process. A global master switch (boucle_meta.loopEnabled,
 * surfaced as /api/loop-state) pauses every loop at once.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { BoucleStore, Loop, LoopRun, LoopRunTrigger } from "./store.ts";
import { getMcpToken } from "./mcp.ts";
import { continueT3CodeChat, getT3CodeConfig, spawnT3CodeChat } from "./t3code.ts";

const TICK_MS = 30_000;

/**
 * A loop's `model` may target t3code (e.g. "claude-sonnet-5"), which the codex CLI
 * rejects. When borrowing a loop's env for a one-shot codex run, only keep models
 * codex itself can serve; otherwise fall back to the profile default.
 */
function codexModelOf(model: string | null | undefined): string | null {
  return model && model.startsWith("gpt-") ? model : null;
}

/** The minimal codex invocation a run needs — a Loop satisfies this shape. */
export interface ExecSpec {
  readonly prompt: string;
  readonly profile: string | null;
  readonly model: string | null;
  readonly codexHome: string | null;
}
const DEFAULT_TIMEOUT_MIN = Number.parseInt(process.env.BOUCLE_LOOP_TIMEOUT_MIN ?? "12", 10);
/** Keep only the tail of a run's output as its summary. */
const MAX_SUMMARY_CHARS = 8_000;

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

/** Resolve the codex CLI like chief-loop-run.sh did: explicit override, ~/.local/bin, then PATH. */
function resolveCodexBin(): string {
  const override = (process.env.BOUCLE_CODEX_BIN ?? "").trim();
  if (override) return override;
  const local = join(homedir(), ".local", "bin", "codex");
  return existsSync(local) ? local : "codex";
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
  if (start === end) return true; // all day
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
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly store: BoucleStore;
  /** Passed to spawned codex as $BOUCLE_DB so any `boucle` CLI calls hit this store. */
  private readonly dbPath: string;

  constructor(store: BoucleStore, dbPath: string) {
    this.store = store;
    this.dbPath = dbPath;
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
    return this.running.has(loopId);
  }

  private tick(): void {
    if (this.store.getMeta("loopEnabled") !== "1") return;
    const nowMs = Date.now();
    for (const loop of this.store.listEnabledLoops()) {
      if (this.running.has(loop.loopId)) continue;
      if (isDue(loop, nowMs)) this.run(loop, "schedule");
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

  /**
   * One-shot headless codex run that re-investigates a single ticket with a human
   * note and updates it in place (via the boucle MCP tools). Independent of the
   * scheduler master switch. Returns false if an enrichment is already in flight.
   */
  enrichTicket(ticketId: string, prompt: string): boolean {
    const key = `enrich:${ticketId}`;
    if (this.running.has(key)) return false;
    this.running.add(key);
    this.store.addEvent(ticketId, "note", "Codex re-run requested");
    // Borrow a configured loop's codex env — CODEX_HOME holds the connector auth + boucle MCP wiring.
    const base = this.store.listLoops().find((l) => l.codexHome) ?? null;
    this.execCodex({
      prompt,
      profile: base?.profile ?? null,
      model: codexModelOf(base?.model),
      codexHome: base?.codexHome ?? null,
    })
      .then((res) => {
        const status = res.timedOut ? "timed out" : res.code === 0 ? "finished" : "failed";
        this.store.addEvent(ticketId, "note", `Codex re-run ${status}`);
      })
      .catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : String(err);
        this.store.addEvent(ticketId, "note", `Codex re-run failed: ${detail.slice(0, 200)}`);
      })
      .finally(() => this.running.delete(key));
    return true;
  }

  /** In-memory ledger of paste-parsing runs (smart capture). */
  private readonly smartRuns = new Map<
    string,
    { batchId: string; status: "running" | "ok" | "error" | "timeout"; startedAt: string; finishedAt: string | null; detail: string }
  >();

  listSmartRuns(): Array<{ batchId: string; status: string; startedAt: string; finishedAt: string | null; detail: string }> {
    return [...this.smartRuns.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 10);
  }

  /**
   * One-shot headless codex run that parses pasted raw text into Boucle items
   * (via the boucle MCP tools): split, type, route to projects, merge with
   * existing open tickets instead of duplicating. Independent of the master switch.
   */
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
    const base = this.store.listLoops().find((l) => l.codexHome) ?? null;
    this.execCodex({
      prompt,
      profile: base?.profile ?? null,
      model: codexModelOf(base?.model),
      codexHome: base?.codexHome ?? null,
    })
      .then((res) => {
        const status = res.timedOut ? "timeout" : res.code === 0 ? "ok" : "error";
        const prev = this.smartRuns.get(batchId);
        if (prev) this.smartRuns.set(batchId, { ...prev, status, finishedAt: new Date().toISOString(), detail: res.output.slice(-2000) });
      })
      .catch((err: unknown) => {
        const prev = this.smartRuns.get(batchId);
        const detail = err instanceof Error ? err.message : String(err);
        if (prev) this.smartRuns.set(batchId, { ...prev, status: "error", finishedAt: new Date().toISOString(), detail: detail.slice(0, 2000) });
      })
      .finally(() => this.running.delete(key));
  }

  private run(loop: Loop, trigger: LoopRunTrigger): LoopRun {
    this.running.add(loop.loopId);
    const run = this.store.recordRunStart(loop.loopId, trigger);
    this.runLoop(loop, trigger)
      .then((res) => {
        const status = res.timedOut ? "timeout" : res.code === 0 ? "ok" : "error";
        this.store.recordRunFinish(run.runId, loop.loopId, status, res.code, res.output.slice(-MAX_SUMMARY_CHARS));
      })
      .catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : String(err);
        this.store.recordRunFinish(run.runId, loop.loopId, "error", null, detail.slice(-MAX_SUMMARY_CHARS));
      })
      .finally(() => this.running.delete(loop.loopId));
    return run;
  }

  private async runLoop(
    loop: Loop,
    trigger: LoopRunTrigger,
  ): Promise<{ code: number | null; timedOut: boolean; output: string }> {
    const cfg = getT3CodeConfig(this.store);
    if (cfg === null) return this.execCodex(loop);

    const prompt = buildLoopTurnPrompt(loop, trigger);
    const result = loop.threadId
      ? await continueT3CodeChat(cfg, {
          threadId: loop.threadId,
          title: loop.name,
          prompt,
        })
      : await spawnT3CodeChat(cfg, {
          defaultProject: this.store.getMeta("defaultProject") ?? "dataiku",
          title: `Loop: ${loop.name}`,
          prompt,
          modelSelection: t3ModelSelectionForLoop(loop),
        });

    const project = result.project || loop.threadProject || "t3code";
    this.store.setLoopThread(loop.loopId, { ...result, project });
    return {
      code: 0,
      timedOut: false,
      output: `Dispatched ${trigger} loop run to t3code conversation.\nThread: ${result.openUrl}`,
    };
  }

  private execCodex(spec: ExecSpec): Promise<{ code: number | null; timedOut: boolean; output: string }> {
    return new Promise((resolve) => {
      // Match the original chief-loop-run.sh invocation; --skip-git-repo-check because the
      // spawn cwd (the user's home) is not a git repo.
      const args = ["exec", "--skip-git-repo-check", "--sandbox", "danger-full-access"];
      if (spec.profile) args.push("--profile", spec.profile);
      if (spec.model) args.push("-m", spec.model);
      args.push(spec.prompt);

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        BOUCLE_DB: this.dbPath,
        // So codex's `[mcp_servers.boucle]` (bearer-token-env-var = BOUCLE_MCP_TOKEN) can authenticate.
        BOUCLE_MCP_TOKEN: getMcpToken(this.store),
      };
      if (spec.codexHome) env.CODEX_HOME = expandHome(spec.codexHome);
      // Force ChatGPT-account auth (which the connector apps require); an API key would
      // flip codex into API-key mode and break Slack/Gmail/Calendar/Drive/ClickUp.
      delete env.OPENAI_API_KEY;

      // stdin "ignore" → codex gets EOF instead of blocking on "Reading additional input from stdin".
      const child = spawn(resolveCodexBin(), args, { env, cwd: homedir(), stdio: ["ignore", "pipe", "pipe"] });

      let output = "";
      const capture = (chunk: Buffer) => {
        output += chunk.toString();
        if (output.length > MAX_SUMMARY_CHARS * 2) output = output.slice(-MAX_SUMMARY_CHARS * 2);
      };
      child.stdout?.on("data", capture);
      child.stderr?.on("data", capture);

      let timedOut = false;
      const killTimer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
      }, DEFAULT_TIMEOUT_MIN * 60_000);
      if (typeof killTimer.unref === "function") killTimer.unref();

      child.on("error", (err) => {
        clearTimeout(killTimer);
        resolve({ code: null, timedOut, output: `${output}\n[spawn error] ${err.message}` });
      });
      child.on("close", (code) => {
        clearTimeout(killTimer);
        resolve({ code, timedOut, output });
      });
    });
  }
}

function t3ModelSelectionForLoop(loop: Loop) {
  if (loop.model === "gpt-5.4") {
    return {
      instanceId: "codex",
      model: "gpt-5.4",
      options: [
        { id: "reasoningEffort", value: "medium" },
        { id: "fastMode", value: false },
      ],
    };
  }
  // Claude agent models run at reasoning effort "medium", fast mode off. A loop
  // opts in by setting its model to the Claude id (e.g. the Chief of staff loop
  // → "claude-sonnet-5"), overriding the Opus-4.8/high default in t3code.ts.
  if (loop.model === "claude-sonnet-5") {
    return {
      instanceId: "claudeAgent",
      model: "claude-sonnet-5",
      options: [
        { id: "effort", value: "medium" },
        { id: "fastMode", value: false },
      ],
    };
  }
  return undefined;
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
