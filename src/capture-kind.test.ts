import assert from "node:assert/strict";
import test from "node:test";

import { inferCaptureKind } from "./capture-kind.ts";
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

test("auto capture kind falls back to idea without a configured provider", async () => {
  const provider = new FakeProvider(false, "task");
  assert.equal(await inferCaptureKind(provider, "A possible launch theme", null), "idea");
  assert.equal(provider.calls, 0);
});
