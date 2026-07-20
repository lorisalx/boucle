import { z } from "zod";

import type { Identity } from "./identity.ts";
import type { ToolSpec } from "./providers/types.ts";
import type { BoucleStore } from "./store.ts";
import { listTools } from "./tools/registry.ts";

/** Store-backed tools exposed to a provider conversation. */
export function buildBoucleTools(_identity: Identity): readonly ToolSpec[] {
  return listTools().map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: z.toJSONSchema(z.object(tool.schema)) as Record<string, unknown>,
    },
  }));
}

/** Strictly read-only tool declarations for the global brain conversation. */
export function buildBoucleBrainTools(_identity: Identity): readonly ToolSpec[] {
  return listTools()
    .filter((tool) => tool.readOnly)
    .map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: z.toJSONSchema(z.object(tool.schema)) as Record<string, unknown>,
      },
    }));
}

type ToolArgs = Record<string, unknown>;

/** The single implementation used by MCP registrations and provider relays. */
export async function executeBoucleTool(store: BoucleStore, name: string, args: ToolArgs): Promise<unknown> {
  const tool = listTools().find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Unknown Boucle tool: ${name}`);
  return tool.handler({ store }, args);
}
