// Public extension surface: the manifest an extension exports and the ctx its setup receives.
//
// Extensions are plain .ts modules loaded with dynamic import() at startup (Node type-stripping,
// no build step). `definePlugin` is optional sugar — a plain object literal of the same shape
// works identically, which is what external extensions (that cannot resolve this file) export.

import type { DatabaseSync } from "node:sqlite";

import type { Handler } from "hono";
import type { ZodRawShape } from "zod";

import type { BoucleEvents } from "./events.ts";
import type { ProviderFactory } from "../providers/index.ts";
import type { AgentRunner } from "../runner.ts";
import type { BrainSearch } from "../search.ts";
import type { BoucleStore } from "../store.ts";

export type ExtensionHttpMethod = "get" | "post" | "put" | "delete";

/** One declared, UI-configurable setting. Resolved meta -> env -> undefined. */
export interface ExtensionSettingSpec {
  key: string;
  label?: string;
  env?: string;
  placeholder?: string;
}

/** A tool an extension contributes. Its name is auto-prefixed `<ext>_` in the shared registry. */
export interface ExtensionToolDef {
  name: string;
  title: string;
  description: string;
  schema: ZodRawShape;
  readOnly: boolean;
  handler: (args: any) => Promise<unknown> | unknown;
}

/** A nav item + self-contained web UI served from `<extension dir>/web/`. */
export interface ExtensionPageDef {
  label: string;
  icon?: string;
}

export interface ExtensionContext {
  /** Subscribe to a core event. Handlers are isolated: a throw is logged, never propagated. */
  on<K extends keyof BoucleEvents>(event: K, handler: (ev: BoucleEvents[K]) => void | Promise<void>): void;

  /** Register an agent tool (auto-prefixed `<ext>_`), exposed over MCP and to provider chat. */
  registerTool(def: ExtensionToolDef): void;

  /** Mount an HTTP handler under `/api/ext/<name>/<path>`. */
  registerRoute(method: ExtensionHttpMethod, path: string, handler: Handler): void;

  /** Add a nav item + page; assets are served from `<extension dir>/web/` at `/ext/<name>/`. */
  registerPage(def: ExtensionPageDef): void;

  /** Contribute an agent runner selectable via the `runner` setting. */
  registerRunner(runner: AgentRunner): void;

  /** Contribute a provider selectable via the `provider` setting. */
  registerProvider(name: string, factory: ProviderFactory): void;

  /** Declared settings, resolved meta -> env -> undefined (read live, no caching). */
  settings: { get(key: string): string | undefined };

  /** Namespaced KV persistence (boucle_meta with an `ext.<name>.kv.` prefix). */
  kv: { get(key: string): string | undefined; set(key: string, value: string): void; delete(key: string): void };

  /** Raw sqlite handle for extensions that need real tables (use `ext_<name>_` names). */
  db: DatabaseSync;

  /** Read/write access to Boucle itself — the same surface the agent tools use. */
  boucle: { store: BoucleStore; search: BrainSearch; executeTool(name: string, args: unknown): Promise<unknown> };

  /** Log to server stdout, prefixed `[ext:<name>]`. */
  log: (msg: string) => void;
}

export interface ExtensionManifest {
  name: string;
  version?: string;
  description?: string;
  settings?: ExtensionSettingSpec[];
  setup: (ctx: ExtensionContext) => void | Promise<void>;
}

/** Identity helper: gives editors the manifest type. A plain object literal works just as well. */
export function definePlugin(manifest: ExtensionManifest): ExtensionManifest {
  return manifest;
}

export type ExtensionStatus = "active" | "disabled" | "error";

/** The public record for one discovered extension (no secrets). */
export interface LoadedExtension {
  name: string;
  version: string;
  description: string;
  dir: string;
  status: ExtensionStatus;
  error?: string;
  settings: ExtensionSettingSpec[];
  pages: ExtensionPageDef[];
  toolNames: string[];
  routeCount: number;
}
