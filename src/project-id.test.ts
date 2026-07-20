import assert from "node:assert/strict";
import test from "node:test";

import { isValidProjectId, normalizeProjectId } from "./project-id.ts";

test("a slug that is already canonical is returned unchanged", () => {
  for (const slug of ["genai-monitoring", "companion-agent", "salesforce-mcp-security", "pg-agent"]) {
    assert.equal(normalizeProjectId(slug), slug);
  }
});

test("a brain path where a slug belongs collapses to the slug", () => {
  // The accident that split genai-monitoring's history across two rows.
  assert.equal(normalizeProjectId("projects/genai-monitoring"), "genai-monitoring");
  assert.equal(normalizeProjectId("projects/genai-monitoring.md"), "genai-monitoring");
  assert.equal(normalizeProjectId("/Users/x/brain/projects/companion-agent.md"), "companion-agent");
  assert.equal(normalizeProjectId("projects/"), null);
});

test("case, spaces and underscores fold into the canonical form", () => {
  assert.equal(normalizeProjectId("GenAI-Monitoring"), "genai-monitoring");
  assert.equal(normalizeProjectId("companion agent"), "companion-agent");
  assert.equal(normalizeProjectId("companion_agent"), "companion-agent");
  assert.equal(normalizeProjectId("  agent-hub  "), "agent-hub");
  assert.equal(normalizeProjectId("agent--hub"), "agent-hub");
});

test("absent or unusable values become null rather than a stored non-match", () => {
  assert.equal(normalizeProjectId(null), null);
  assert.equal(normalizeProjectId(undefined), null);
  assert.equal(normalizeProjectId(""), null);
  assert.equal(normalizeProjectId("   "), null);
  assert.equal(normalizeProjectId("---"), null);
  // Nothing valid survives, so the caller rejects instead of persisting garbage.
  assert.equal(normalizeProjectId("!!!"), null);
});

test("every normalized slug satisfies the validator that guards the filesystem", () => {
  const inputs = ["projects/genai-monitoring", "GenAI Monitoring", "companion_agent", "agent-hub.md"];
  for (const input of inputs) {
    const slug = normalizeProjectId(input);
    assert.ok(slug, `expected a slug for ${input}`);
    assert.ok(isValidProjectId(slug), `${slug} must pass isValidProjectId`);
  }
});
