import type { ZodRawShape } from "zod";

import { CORE_TOOLS } from "./core.ts";
import type { BoucleStore } from "../store.ts";

export interface ToolDeps {
  store: BoucleStore;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  schema: ZodRawShape;
  readOnly: boolean;
  handler: (deps: ToolDeps, args: any) => Promise<unknown>;
}

const tools: ToolDef[] = [...CORE_TOOLS];

export function registerCoreTool(def: ToolDef): () => void {
  if (tools.some((tool) => tool.name === def.name)) {
    throw new Error(`Boucle tool already registered: ${def.name}`);
  }
  tools.push(def);
  return () => {
    const index = tools.indexOf(def);
    if (index !== -1) tools.splice(index, 1);
  };
}

export function listTools(): ToolDef[] {
  return [...tools];
}
