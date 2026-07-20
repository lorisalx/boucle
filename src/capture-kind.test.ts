import assert from "node:assert/strict";
import test from "node:test";

import { inferCaptureKind, inferCaptureKindOffline } from "./capture-kind.ts";
import type { ChatMessage, Provider, ToolSpec } from "./providers/types.ts";

class FakeProvider implements Provider {
  readonly name = "fake";
  readonly chatModel = "fake-model";
  calls = 0;
  private readonly configured: boolean;
  private readonly response: string;

  constructor(configured: boolean, response: string) {
    this.configured = configured;
    this.response = response;
  }

  isConfigured(): boolean { return this.configured; }
  supportsEmbeddings(): boolean { return false; }
  supportsTranscription(): boolean { return false; }
  async chat(_messages: ChatMessage[], _tools: ToolSpec[]): Promise<ChatMessage> {
    this.calls += 1;
    return { role: "assistant", content: this.response };
  }
  async embed(_texts: readonly string[]): Promise<number[][]> { return []; }
  async transcribe(_file: Blob, _filename: string): Promise<string> { return ""; }
}

test("auto capture kind uses provider inference and accepts a project hint", async () => {
  const provider = new FakeProvider(true, "task");
  assert.equal(await inferCaptureKind(provider, "Send the launch brief", "launch"), "task");
  assert.equal(provider.calls, 1);
});

test("auto capture kind falls back to offline heuristics without a configured provider", async () => {
  // No keyword match — offline heuristic degrades gracefully to idea.
  const provider = new FakeProvider(false, "task");
  assert.equal(await inferCaptureKind(provider, "An interesting concept to explore", null), "idea");
  assert.equal(provider.calls, 0);
});

test("auto capture kind falls back to offline heuristics when the provider call throws", async () => {
  class ThrowingProvider extends FakeProvider {
    override async chat(): Promise<ChatMessage> { throw new Error("timeout"); }
  }
  const provider = new ThrowingProvider(true, "");
  // "Fix" matches the task keyword list.
  assert.equal(await inferCaptureKind(provider, "Fix the login redirect", null), "task");
});

// ── inferCaptureKindOffline ─────────────────────────────────────────────────

test("offline heuristic: task keywords", () => {
  assert.equal(inferCaptureKindOffline("Fix the login redirect"), "task");
  assert.equal(inferCaptureKindOffline("Add dark mode toggle"), "task");
  assert.equal(inferCaptureKindOffline("Update the README"), "task");
  assert.equal(inferCaptureKindOffline("Deploy the staging branch"), "task");
  assert.equal(inferCaptureKindOffline("Write release notes"), "task");
  assert.equal(inferCaptureKindOffline("Review the PR"), "task");
});

test("offline heuristic: scope keywords", () => {
  assert.equal(inferCaptureKindOffline("Plan the Q3 roadmap"), "scope");
  assert.equal(inferCaptureKindOffline("Design the new auth flow"), "scope");
  assert.equal(inferCaptureKindOffline("RFC: pluggable runner interface"), "scope");
  assert.equal(inferCaptureKindOffline("Architecture proposal for the search layer"), "scope");
});

test("offline heuristic: conv keywords", () => {
  assert.equal(inferCaptureKindOffline("Call with Loris about federation"), "conv");
  assert.equal(inferCaptureKindOffline("Meeting notes: weekly sync"), "conv");
  assert.equal(inferCaptureKindOffline("Catch-up with Chris on Friday"), "conv");
  assert.equal(inferCaptureKindOffline("Debrief after the demo"), "conv");
});

test("offline heuristic: idea fallback for unknown captures", () => {
  assert.equal(inferCaptureKindOffline("An interesting concept to explore"), null);
  assert.equal(inferCaptureKindOffline("Something I want to remember"), null);
  assert.equal(inferCaptureKindOffline(""), null);
});

test("offline heuristic: case-insensitive matching", () => {
  assert.equal(inferCaptureKindOffline("FIX the BUG"), "task");
  assert.equal(inferCaptureKindOffline("DESIGN a new auth flow"), "scope");
  assert.equal(inferCaptureKindOffline("SYNC with engineering"), "conv");
});
