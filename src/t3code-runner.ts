/**
 * t3code as a loop runner. Unlike the CLI runners, this one does not execute an agent
 * locally — it dispatches the turn into a t3code thread and returns immediately. The
 * conversation (and its transcript) lives in t3code, so there is no cost or session to
 * report back and no local transcript to read.
 *
 * A loop keeps one thread for its lifetime: the first run spawns it, later runs post
 * another turn into it, so a recurring loop reads as one continuing conversation.
 */
import type { AgentExecResult, AgentExecSpec, AgentRunner, Transcript } from "./runner.ts";
import type { SettingsStore } from "./settings.ts";
import { continueT3CodeChat, getT3CodeConfig, spawnT3CodeChat } from "./t3code.ts";

/**
 * Map a loop's `model` to a t3code model selection. A loop opts into a specific agent
 * by naming its model; anything unrecognized falls through to the t3code default.
 */
function modelSelectionFor(model: string | null) {
  if (!model) return undefined;
  if (model.startsWith("gpt-")) {
    return {
      instanceId: "codex",
      model,
      options: [
        { id: "reasoningEffort", value: "medium" },
        { id: "fastMode", value: false },
      ],
    };
  }
  if (model.startsWith("claude-")) {
    return {
      instanceId: "claudeAgent",
      model,
      options: [
        { id: "effort", value: "medium" },
        { id: "fastMode", value: false },
      ],
    };
  }
  return undefined;
}

export class T3CodeRunner implements AgentRunner {
  readonly name = "t3code" as const;

  private readonly store: SettingsStore;

  constructor(store: SettingsStore) {
    this.store = store;
  }

  async exec(spec: AgentExecSpec): Promise<AgentExecResult> {
    const cfg = getT3CodeConfig(this.store);
    if (cfg === null) {
      throw new Error("t3code runner selected but t3code is not configured (set the URL and token in Settings).");
    }

    // Prefer the caller's label; scope is an id, so it only serves as a last resort.
    const label = spec.title?.trim() || spec.scope;
    const title = spec.scope.startsWith("loops_") ? `Loop: ${label}` : label;
    // Sent on continue as well as spawn: the loop's configured model is the source of
    // truth for every run, not just the one that happened to create the thread.
    const modelSelection = modelSelectionFor(spec.model);
    const result = spec.resumeSessionId
      ? await continueT3CodeChat(cfg, {
          threadId: spec.resumeSessionId,
          title,
          prompt: spec.prompt,
          ...(modelSelection ? { modelSelection } : {}),
        })
      : await spawnT3CodeChat(cfg, { title, prompt: spec.prompt, modelSelection });

    return {
      sessionId: result.threadId,
      costUsd: null,
      output: `Dispatched to t3code conversation.\nThread: ${result.openUrl}`,
      code: 0,
      timedOut: false,
      openUrl: result.openUrl,
    };
  }

  /** Transcripts live in t3code, not on disk. */
  readTranscript(): Promise<Transcript | null> {
    return Promise.resolve(null);
  }
}
