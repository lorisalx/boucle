// Runner-neutral seam. Vibe, Codex, and Claude are adapters behind this interface.

import { ClaudeRunner } from "./claude.ts";
import { CodexRunner } from "./codex.ts";
import { registerRunnerName, unregisterRunnerName } from "./selectors.ts";
import { resolveRunnerSetting, type RunnerName, type SettingsStore } from "./settings.ts";
import { execVibe } from "./vibe.ts";
import { readVibeTranscript } from "./vibe-transcript.ts";

export interface AgentExecSpec {
  readonly prompt: string;
  readonly scope: string;
  readonly model: string | null;
  readonly mcpUrl: string;
  readonly mcpToken: string;
  readonly dbPath: string;
  readonly workdir: string;
  readonly resumeSessionId: string | null;
  readonly maxPriceUsd: number;
  readonly timeoutMin: number;
}

export interface AgentExecResult {
  readonly sessionId: string | null;
  readonly costUsd: number | null;
  readonly output: string;
  readonly code: number | null;
  readonly timedOut: boolean;
}

export interface TranscriptEntry {
  readonly role: "user" | "assistant" | "tool";
  readonly content: string;
  readonly toolName?: string;
}

export interface Transcript {
  readonly meta: {
    readonly sessionId: string;
    readonly title: string | null;
    readonly startTime: string | null;
    readonly endTime: string | null;
    readonly costUsd: number | null;
  };
  readonly entries: TranscriptEntry[];
}

export interface AgentRunner {
  readonly name: RunnerName;
  exec(spec: AgentExecSpec): Promise<AgentExecResult>;
  readTranscript(workdir: string, scope: string, sessionId: string): Promise<Transcript | null>;
}

export class VibeRunner implements AgentRunner {
  readonly name = "vibe" as const;

  exec(spec: AgentExecSpec): Promise<AgentExecResult> {
    return execVibe(
      {
        prompt: spec.prompt,
        model: spec.model,
        sessionId: spec.resumeSessionId,
        scopeId: spec.scope,
      },
      {
        dbPath: spec.dbPath,
        mcpToken: spec.mcpToken,
        mcpUrl: spec.mcpUrl,
        workdir: spec.workdir,
      },
    );
  }

  readTranscript(workdir: string, scope: string, sessionId: string): Promise<Transcript | null> {
    return readVibeTranscript(workdir, scope, sessionId);
  }
}

const DEFAULT_RUNNER = "vibe";

const runners = new Map<string, AgentRunner>([
  ["vibe", new VibeRunner()],
  ["codex", new CodexRunner()],
  ["claude", new ClaudeRunner()],
]);

const warnedMissing = new Set<string>();

/** Extensions add runners to the live registry (also registers the name for settings validation). */
export function registerRunner(runner: AgentRunner): () => void {
  if (runners.has(runner.name)) {
    throw new Error(`runner already registered: ${runner.name}`);
  }
  runners.set(runner.name, runner);
  registerRunnerName(runner.name);
  return () => {
    if (runners.get(runner.name) !== runner) return;
    runners.delete(runner.name);
    unregisterRunnerName(runner.name);
  };
}

export function getAgentRunner(override: RunnerName | null = null, store: SettingsStore | null = null): AgentRunner {
  const wanted = override ?? resolveRunnerSetting(store).value;
  const runner = runners.get(wanted);
  if (runner) return runner;
  // A meta-configured runner from a since-removed extension degrades to the default
  // rather than crashing — warn once so the misconfiguration is visible.
  if (!warnedMissing.has(wanted)) {
    warnedMissing.add(wanted);
    console.error(`[boucle] unknown runner "${wanted}"; falling back to ${DEFAULT_RUNNER}.`);
  }
  return runners.get(DEFAULT_RUNNER)!;
}
