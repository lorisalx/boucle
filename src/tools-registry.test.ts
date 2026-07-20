import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import { buildBoucleBrainTools } from "./boucle-tools.ts";
import type { Identity } from "./identity.ts";
import { listTools } from "./tools/registry.ts";

const identity: Identity = { appName: "Boucle", ownerName: "", orgName: "", demoMode: false };

test("core tool names and required parameters match the pre-registry surface", () => {
  const snapshot = listTools().map((tool) => {
    const json = z.toJSONSchema(z.object(tool.schema)) as { required?: string[] };
    return [tool.name, json.required ?? []] as const;
  });

  assert.deepEqual(snapshot, [
    ["brain_search", ["query"]],
    ["brain_graph_search", ["query"]],
    ["ticket_upsert", ["dedupeKey", "title", "source"]],
    ["ticket_list", []],
    ["ticket_next", []],
    ["ticket_get", ["ticketId"]],
    ["ticket_set", ["ticketId"]],
    ["ticket_transition", ["ticketId", "toStatus"]],
    ["ticket_comment", ["ticketId", "text"]],
    ["project_page_read", ["projectId"]],
    ["source_seen", ["dedupeKey"]],
    ["mark_source_seen", ["source", "sourceRef", "dedupeKey", "decision"]],
    ["reprioritize", []],
    ["spawn_chat", ["ticketId"]],
  ]);
});

test("read-only registry tools match the former brain tool set", () => {
  const expected = [
    "brain_search",
    "brain_graph_search",
    "ticket_list",
    "ticket_next",
    "ticket_get",
    "project_page_read",
  ];

  assert.deepEqual(listTools().filter((tool) => tool.readOnly).map((tool) => tool.name), expected);
  assert.deepEqual(buildBoucleBrainTools(identity).map((tool) => tool.function.name), expected);
});
