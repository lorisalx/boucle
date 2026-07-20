// Runner-neutral seam. Vibe, Codex, and Claude are adapters behind this interface.

import { ClaudeRunner } from "./claude.ts";
import { CodexRunner } from "./codex.ts";
import { resolveRunnerSetting, type RunnerName, type SettingsStore } from "./settings.ts";
import { T3CodeRunner } from "./t3code-runner.ts";
import { execVibe } from "./vibe.ts";
import { readVibeTranscript } from "./vibe-transcript.ts";

export interface AgentExecSpec {
  readonly prompt: string;
  readonly scope: string;
  readonly model: string | null;
  /** Human-readable label for runners that surface the work as a named conversation. */
  readonly title?: string | null;
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
  /** Deep link to the conversation, for runners that host it outside Boucle. */
  readonly openUrl?: string | null;
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

const runners: Record<Exclude<RunnerName, "t3code">, AgentRunner> = {
  vibe: new VibeRunner(),
  codex: new CodexRunner(),
  claude: new ClaudeRunner(),
};

export function getAgentRunner(override: RunnerName | null = null, store: SettingsStore | null = null): AgentRunner {
  const name = override ?? resolveRunnerSetting(store).value;
  // t3code resolves per call: it needs the store to read its URL and token.
  if (name === "t3code") return new T3CodeRunner(store ?? { getMeta: () => null });
  return runners[name];
}
