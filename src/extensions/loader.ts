// Extension loader: discover, import, validate, and wire extensions at startup.
//
// An extension is a directory with an `index.ts`/`index.js` default-exporting a manifest.
// Discovery order: bundled `<repo>/extensions/`, then the user dir. A broken extension is
// isolated (status "error") and never takes the server down. Nothing is hot-reloadable —
// enable/disable and settings take effect on the next boot.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import { serveStatic } from "@hono/node-server/serve-static";
import type { Hono } from "hono";

import { on as onEvent, type BoucleEvents } from "./events.ts";
import {
  type ExtensionContext,
  type ExtensionManifest,
  type ExtensionPageDef,
  type ExtensionSettingSpec,
  type ExtensionToolDef,
  type LoadedExtension,
} from "./types.ts";
import { executeBoucleTool } from "../boucle-tools.ts";
import { resolveExtensionDirs } from "../config.ts";
import { registerProvider } from "../providers/index.ts";
import { registerRunner } from "../runner.ts";
import type { BrainSearch } from "../search.ts";
import type { BoucleStore } from "../store.ts";
import { registerCoreTool } from "../tools/registry.ts";

const NAME_RE = /^[a-z][a-z0-9-]*$/;

export interface LoaderDeps {
  store: BoucleStore;
  search?: BrainSearch;
  app?: Hono;
  /** Override the search dirs (tests point this at a fixture dir; defaults to resolveExtensionDirs). */
  dirs?: string[];
  /** Validate + report only: import each candidate but never build ctx, call setup, or mount. */
  dryRun?: boolean;
}

interface Candidate {
  name: string;
  dir: string;
  indexFile: string;
}

/** Every immediate subdirectory (across the search dirs) that has an index.ts/index.js. */
function discover(dirs: string[]): Candidate[] {
  const candidates: Candidate[] = [];
  for (const base of dirs) {
    if (!existsSync(base)) continue;
    let entries;
    try {
      entries = readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = join(base, entry.name);
      const indexFile = ["index.ts", "index.js"].map((f) => join(dir, f)).find((f) => existsSync(f));
      if (indexFile) candidates.push({ name: entry.name, dir, indexFile });
    }
  }
  return candidates;
}

function validateManifest(manifest: unknown): ExtensionManifest {
  if (typeof manifest !== "object" || manifest === null) throw new Error("default export is not a manifest object");
  const m = manifest as Partial<ExtensionManifest>;
  if (typeof m.name !== "string" || !NAME_RE.test(m.name)) {
    throw new Error(`invalid extension name: ${String(m.name)} (expected [a-z][a-z0-9-]*)`);
  }
  if (typeof m.setup !== "function") throw new Error("manifest.setup must be a function");
  return m as ExtensionManifest;
}

function metaKey(name: string, key: string): string {
  return `ext.${name}.${key}`;
}

function isEnabled(store: BoucleStore, name: string): boolean {
  return (store.getMeta(metaKey(name, "enabled")) ?? "1") !== "0";
}

/** meta[`ext.<name>.<key>`] -> process.env[spec.env] -> undefined. */
function resolveSetting(store: BoucleStore, name: string, spec: ExtensionSettingSpec | undefined): string | undefined {
  const meta = store.getMeta(metaKey(name, spec?.key ?? ""));
  if (meta !== null) return meta;
  if (spec?.env) {
    const env = (process.env[spec.env] ?? "").trim();
    if (env.length > 0) return env;
  }
  return undefined;
}

/** Build the ctx handed to one extension's setup(). Registrations mutate the passed accumulators. */
function buildContext(
  deps: LoaderDeps,
  manifest: ExtensionManifest,
  acc: { toolNames: string[]; routes: Array<{ method: string; path: string; handler: any }>; pages: ExtensionPageDef[] },
): ExtensionContext {
  const { store } = deps;
  const name = manifest.name;
  const specs = manifest.settings ?? [];
  const kvPrefix = `kv.`;
  return {
    on<K extends keyof BoucleEvents>(event: K, handler: (ev: BoucleEvents[K]) => void | Promise<void>) {
      // Name the wrapper after the extension so a throwing handler logs `[ext:<name>]`.
      const named = { [name]: (ev: BoucleEvents[K]) => handler(ev) }[name] as (ev: BoucleEvents[K]) => void | Promise<void>;
      onEvent(event, named);
    },
    registerTool(def: ExtensionToolDef) {
      // Hyphens in the extension name become underscores so the tool name is a valid
      // identifier (e.g. ext "hello-world" + "stats" -> "hello_world_stats").
      const fullName = `${name.replace(/-/g, "_")}_${def.name}`;
      registerCoreTool({
        name: fullName,
        title: def.title,
        description: def.description,
        schema: def.schema,
        readOnly: def.readOnly,
        handler: (_deps, args) => Promise.resolve(def.handler(args)),
      });
      acc.toolNames.push(fullName);
    },
    registerRoute(method, path, handler) {
      acc.routes.push({ method, path: path.startsWith("/") ? path : `/${path}`, handler });
    },
    registerPage(def: ExtensionPageDef) {
      acc.pages.push(def);
    },
    registerRunner(runner) {
      registerRunner(runner);
    },
    registerProvider(providerName, factory) {
      registerProvider(providerName, factory);
    },
    settings: {
      get: (key: string) => resolveSetting(store, name, specs.find((s) => s.key === key) ?? { key }),
    },
    kv: {
      get: (key: string) => store.getMeta(metaKey(name, kvPrefix + key)) ?? undefined,
      set: (key: string, value: string) => store.setMeta(metaKey(name, kvPrefix + key), value),
      delete: (key: string) => store.setMetaValues([[metaKey(name, kvPrefix + key), null]]),
    },
    db: store.rawDb as DatabaseSync,
    boucle: {
      store,
      search: deps.search as BrainSearch,
      executeTool: (toolName, args) => executeBoucleTool(store, toolName, args as Record<string, unknown>),
    },
    log: (msg: string) => process.stdout.write(`[ext:${name}] ${msg}\n`),
  };
}

/** Mount an extension's collected routes (sub-Hono) and static page assets onto the app. */
function mount(app: Hono, ext: Candidate, routes: Array<{ method: string; path: string; handler: any }>, hasPage: boolean): void {
  if (routes.length > 0) {
    for (const route of routes) {
      app.on(route.method.toUpperCase(), `/api/ext/${ext.name}${route.path}`, route.handler);
    }
  }
  if (hasPage) {
    const prefix = `/ext/${ext.name}`;
    const root = join(ext.dir, "web");
    app.use(`${prefix}/*`, serveStatic({ root, rewriteRequestPath: (p) => p.slice(prefix.length) || "/" }));
  }
}

export async function loadExtensions(deps: LoaderDeps): Promise<LoadedExtension[]> {
  const results: LoadedExtension[] = [];
  const seen = new Set<string>();

  for (const candidate of discover(deps.dirs ?? resolveExtensionDirs())) {
    if (seen.has(candidate.name)) {
      results.push(errorRecord(candidate, "duplicate extension name (a bundled extension already uses it)"));
      continue;
    }
    seen.add(candidate.name);

    let manifest: ExtensionManifest;
    try {
      const mod = (await import(pathToFileURL(candidate.indexFile).href)) as { default?: unknown };
      manifest = validateManifest(mod.default);
    } catch (error) {
      results.push(errorRecord(candidate, message(error)));
      continue;
    }

    const base: LoadedExtension = {
      name: manifest.name,
      version: manifest.version ?? "0.0.0",
      description: manifest.description ?? "",
      dir: candidate.dir,
      status: "active",
      settings: manifest.settings ?? [],
      pages: [],
      toolNames: [],
      routeCount: 0,
    };

    if (!isEnabled(deps.store, manifest.name)) {
      results.push({ ...base, status: "disabled" });
      continue;
    }

    if (deps.dryRun) {
      results.push(base);
      continue;
    }

    const acc = { toolNames: [] as string[], routes: [] as Array<{ method: string; path: string; handler: any }>, pages: [] as ExtensionPageDef[] };
    try {
      await manifest.setup(buildContext(deps, manifest, acc));
    } catch (error) {
      results.push({ ...base, status: "error", error: message(error), toolNames: acc.toolNames, pages: acc.pages, routeCount: acc.routes.length });
      continue;
    }
    if (deps.app) mount(deps.app, candidate, acc.routes, acc.pages.length > 0);
    results.push({ ...base, toolNames: acc.toolNames, pages: acc.pages, routeCount: acc.routes.length });
  }

  return results;
}

function errorRecord(candidate: Candidate, error: string): LoadedExtension {
  return {
    name: candidate.name,
    version: "0.0.0",
    description: "",
    dir: candidate.dir,
    status: "error",
    error,
    settings: [],
    pages: [],
    toolNames: [],
    routeCount: 0,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A settings field with its resolved current value + source, for the settings API. */
export interface ExtensionSettingView {
  key: string;
  label?: string;
  placeholder?: string;
  value: string;
  source: "meta" | "env" | "unset";
}

export function viewExtensionSettings(store: BoucleStore, ext: LoadedExtension): ExtensionSettingView[] {
  return ext.settings.map((spec) => {
    const meta = store.getMeta(metaKey(ext.name, spec.key));
    if (meta !== null) return field(spec, meta, "meta");
    if (spec.env) {
      const env = (process.env[spec.env] ?? "").trim();
      if (env.length > 0) return field(spec, env, "env");
    }
    return field(spec, "", "unset");
  });
}

function field(spec: ExtensionSettingSpec, value: string, source: "meta" | "env" | "unset"): ExtensionSettingView {
  const view: ExtensionSettingView = { key: spec.key, value, source };
  if (spec.label !== undefined) view.label = spec.label;
  if (spec.placeholder !== undefined) view.placeholder = spec.placeholder;
  return view;
}

/** Persist one extension setting to meta (empty string clears the override). */
export function writeExtensionSetting(store: BoucleStore, name: string, key: string, value: string): void {
  store.setMetaValues([[metaKey(name, key), value.trim().length > 0 ? value : null]]);
}

/** Flip `ext.<name>.enabled`. Returns the new enabled state. */
export function toggleExtension(store: BoucleStore, name: string): boolean {
  const next = !isEnabled(store, name);
  store.setMeta(metaKey(name, "enabled"), next ? "1" : "0");
  return next;
}
