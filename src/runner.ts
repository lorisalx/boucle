// Agent-runner seam with Vibe as the sole supported loop runner.

import { execVibe, type VibeExecOptions, type VibeExecResult, type VibeExecSpec } from "./vibe.ts";
import { readVibeTranscript, type VibeTranscript } from "./vibe-transcript.ts";

export interface AgentRunner {
  exec(spec: VibeExecSpec, options: VibeExecOptions): Promise<VibeExecResult>;
  readTranscript(workdir: string, scope: string, sessionId: string): Promise<VibeTranscript | null>;
}

export class VibeRunner implements AgentRunner {
  exec(spec: VibeExecSpec, options: VibeExecOptions): Promise<VibeExecResult> {
    return execVibe(spec, options);
  }

  readTranscript(workdir: string, scope: string, sessionId: string): Promise<VibeTranscript | null> {
    return readVibeTranscript(workdir, scope, sessionId);
  }
}

let selected: AgentRunner | null = null;

export function getAgentRunner(): AgentRunner {
  if (selected) return selected;
  const name = (process.env.BOUCLE_RUNNER ?? "vibe").trim().toLowerCase();
  if (name !== "vibe") throw new Error(`BOUCLE_RUNNER=${name || "(empty)"} is not yet supported.`);
  selected = new VibeRunner();
  return selected;
}
