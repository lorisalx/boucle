// Extension loader: discover, import, validate, and wire extensions at startup.
//
// An extension is a directory with an `index.ts`/`index.js` default-exporting a manifest.
// Discovery order: bundled `<repo>/extensions/`, then the user dir. A broken extension is
// isolated (status "error") and never takes the server down. Nothing is hot-reloadable —
// enable/disable and settings take effect on the next boot.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { serveStatic } from "@hono/node-server/serve-static";
import type { Handler, Hono } from "hono";

import { on as onEvent, type BoucleEvents } from "./events.ts";
import {
  type ExtensionContext,
  type ExtensionHttpMethod,
  type ExtensionManifest,
  type ExtensionPageDef,
  type ExtensionSettingSpec,
  type ExtensionToolDef,
  type LoadedExtension,
} from "./types.ts";
import { executeBoucleTool } from "../boucle-tools.ts";
import { resolveExtensionDirs } from "../config.ts";
import { registerProvider } from "../providers/index.ts";
import { registerRunner, type AgentRunner } from "../runner.ts";
import type { BrainSearch } from "../search.ts";
import type { BoucleStore } from "../store.ts";
import { registerCoreTool, type ToolDef } from "../tools/registry.ts";

const NAME_RE = /^[a-z][a-z0-9-]*$/;
const TOOL_NAME_RE = /^[a-z][a-z0-9_]*$/;
const HTTP_METHODS = new Set<ExtensionHttpMethod>(["get", "post", "put", "delete"]);

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

interface ExtensionRoute {
  method: ExtensionHttpMethod;
  path: string;
  handler: Handler;
}

type Registration = () => () => void;

interface PendingExtension {
  toolNames: string[];
  routes: ExtensionRoute[];
  pages: ExtensionPageDef[];
  registrations: Registration[];
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
  if (m.version !== undefined && typeof m.version !== "string") throw new Error("manifest.version must be a string");
  if (m.description !== undefined && typeof m.description !== "string") {
    throw new Error("manifest.description must be a string");
  }
  if (m.settings !== undefined) validateSettingSpecs(m.settings);
  return m as ExtensionManifest;
}

function validateSettingSpecs(settings: unknown): asserts settings is ExtensionSettingSpec[] {
  if (!Array.isArray(settings)) throw new Error("manifest.settings must be an array");
  const keys = new Set<string>();
  for (const value of settings) {
    if (typeof value !== "object" || value === null) throw new Error("each extension setting must be an object");
    const spec = value as Partial<ExtensionSettingSpec>;
    if (typeof spec.key !== "string" || spec.key.length === 0) throw new Error("extension setting key must be a non-empty string");
    if (spec.key === "enabled" || spec.key.startsWith("kv.")) {
      throw new Error(`extension setting key is reserved: ${spec.key}`);
    }
    if (keys.has(spec.key)) throw new Error(`duplicate extension setting key: ${spec.key}`);
    keys.add(spec.key);
    for (const field of ["label", "env", "placeholder"] as const) {
      if (spec[field] !== undefined && typeof spec[field] !== "string") {
        throw new Error(`extension setting ${spec.key}.${field} must be a string`);
      }
    }
  }
}

function metaKey(name: string, key: string): string {
  return `ext.${name}.${key}`;
}

function isEnabled(store: BoucleStore, name: string): boolean {
  return (store.getMeta(metaKey(name, "enabled")) ?? "1") !== "0";
}

/** meta[`ext.<name>.<key>`] -> process.env[spec.env] -> undefined. */
function resolveSetting(store: BoucleStore, name: string, spec: ExtensionSettingSpec): string | undefined {
  const meta = store.getMeta(metaKey(name, spec.key));
  if (meta !== null) return meta;
  if (spec.env) {
    const env = (process.env[spec.env] ?? "").trim();
    if (env.length > 0) return env;
  }
  return undefined;
}

/** Build the ctx handed to one extension's setup(). Registrations mutate the passed accumulators. */
function buildContext(
  deps: LoaderDeps,
  manifest: ExtensionManifest,
  pending: PendingExtension,
): ExtensionContext {
  const { store } = deps;
  const name = manifest.name;
  const specs = manifest.settings ?? [];
  const declaredSettings = new Map(specs.map((spec) => [spec.key, spec]));
  return {
    on<K extends keyof BoucleEvents>(event: K, handler: (ev: BoucleEvents[K]) => void | Promise<void>) {
      // Name the wrapper after the extension so a throwing handler logs `[ext:<name>]`.
      const named = { [name]: (ev: BoucleEvents[K]) => handler(ev) }[name] as (ev: BoucleEvents[K]) => void | Promise<void>;
      pending.registrations.push(() => onEvent(event, named));
    },
    registerTool(def: ExtensionToolDef) {
      validateTool(def);
      // Hyphens in the extension name become underscores so the tool name is a valid
      // identifier (e.g. ext "hello-world" + "stats" -> "hello_world_stats").
      const fullName = `${name.replace(/-/g, "_")}_${def.name}`;
      const tool: ToolDef = {
        name: fullName,
        title: def.title,
        description: def.description,
        schema: def.schema,
        readOnly: def.readOnly,
        handler: (_deps, args) => Promise.resolve(def.handler(args)),
      };
      pending.registrations.push(() => registerCoreTool(tool));
      pending.toolNames.push(fullName);
    },
    registerRoute(method, path, handler) {
      if (!HTTP_METHODS.has(method)) throw new Error(`unsupported extension route method: ${String(method)}`);
      if (typeof path !== "string") throw new Error("extension route path must be a string");
      if (typeof handler !== "function") throw new Error("extension route handler must be a function");
      const normalizedPath = path.startsWith("/") ? path : `/${path}`;
      if (normalizedPath.includes("\0") || /(^|\/)\.\.?(\/|$)/.test(normalizedPath)) {
        throw new Error(`invalid extension route path: ${path}`);
      }
      pending.routes.push({ method, path: normalizedPath, handler });
    },
    registerPage(def: ExtensionPageDef) {
      if (typeof def !== "object" || def === null || typeof def.label !== "string" || def.label.trim().length === 0) {
        throw new Error("extension page label must be a non-empty string");
      }
      if (def.icon !== undefined && typeof def.icon !== "string") throw new Error("extension page icon must be a string");
      pending.pages.push(def);
    },
    registerRunner(runner) {
      validateRunner(runner);
      pending.registrations.push(() => registerRunner(runner));
    },
    registerProvider(providerName, factory) {
      if (!NAME_RE.test(providerName)) throw new Error(`invalid provider name: ${providerName}`);
      if (typeof factory !== "function") throw new Error("provider factory must be a function");
      pending.registrations.push(() => registerProvider(providerName, factory));
    },
    settings: {
      get: (key: string) => {
        const spec = declaredSettings.get(key);
        return spec ? resolveSetting(store, name, spec) : undefined;
      },
    },
    kv: {
      get: (key: string) => store.getMeta(metaKey(name, `kv.${key}`)) ?? undefined,
      set: (key: string, value: string) => store.setMeta(metaKey(name, `kv.${key}`), value),
      delete: (key: string) => store.setMetaValues([[metaKey(name, `kv.${key}`), null]]),
    },
    db: store.rawDb,
    boucle: {
      store,
      get search(): BrainSearch {
        if (!deps.search) throw new Error("ctx.boucle.search is unavailable during this load");
        return deps.search;
      },
      executeTool: (toolName, args) => executeBoucleTool(store, toolName, args as Record<string, unknown>),
    },
    log: (msg: string) => process.stdout.write(`[ext:${name}] ${msg}\n`),
  };
}

function validateTool(def: ExtensionToolDef): void {
  if (typeof def !== "object" || def === null) throw new Error("extension tool must be an object");
  if (!TOOL_NAME_RE.test(def.name)) throw new Error(`invalid extension tool name: ${String(def.name)}`);
  if (typeof def.title !== "string" || typeof def.description !== "string") {
    throw new Error(`extension tool ${def.name} must have a string title and description`);
  }
  if (typeof def.schema !== "object" || def.schema === null) throw new Error(`extension tool ${def.name} schema must be an object`);
  if (typeof def.readOnly !== "boolean") throw new Error(`extension tool ${def.name} readOnly must be a boolean`);
  if (typeof def.handler !== "function") throw new Error(`extension tool ${def.name} handler must be a function`);
}

function validateRunner(runner: AgentRunner): void {
  if (typeof runner !== "object" || runner === null || !NAME_RE.test(runner.name)) {
    throw new Error(`invalid runner name: ${String(runner?.name)}`);
  }
  if (typeof runner.exec !== "function" || typeof runner.readTranscript !== "function") {
    throw new Error(`runner ${runner.name} must implement exec and readTranscript`);
  }
}

function commitRegistrations(registrations: Registration[]): () => void {
  const undo: Array<() => void> = [];
  try {
    for (const register of registrations) undo.push(register());
  } catch (error) {
    for (const rollback of undo.reverse()) rollback();
    throw error;
  }
  return () => {
    for (const rollback of undo.reverse()) rollback();
  };
}

/** Mount an extension's collected routes (sub-Hono) and static page assets onto the app. */
function mount(app: Hono, ext: Candidate, routes: ExtensionRoute[], hasPage: boolean): void {
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
    if (!NAME_RE.test(candidate.name)) {
      results.push(errorRecord(candidate, `invalid extension directory name: ${candidate.name} (expected [a-z][a-z0-9-]*)`));
      continue;
    }
    if (seen.has(candidate.name)) {
      results.push(errorRecord(candidate, "duplicate extension name (a bundled extension already uses it)"));
      continue;
    }
    seen.add(candidate.name);

    let manifest: ExtensionManifest;
    try {
      const mod = (await import(pathToFileURL(candidate.indexFile).href)) as { default?: unknown };
      manifest = validateManifest(mod.default);
      if (manifest.name !== candidate.name) {
        throw new Error(`manifest name ${manifest.name} does not match directory name ${candidate.name}`);
      }
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

    const pending: PendingExtension = { toolNames: [], routes: [], pages: [], registrations: [] };
    try {
      await manifest.setup(buildContext(deps, manifest, pending));
      if (pending.pages.length > 0 && !existsSync(join(candidate.dir, "web", "index.html"))) {
        throw new Error("extension registered a page but has no web/index.html");
      }
      const rollback = commitRegistrations(pending.registrations);
      try {
        if (deps.app) mount(deps.app, candidate, pending.routes, pending.pages.length > 0);
      } catch (error) {
        rollback();
        throw error;
      }
    } catch (error) {
      results.push({
        ...base,
        status: "error",
        error: message(error),
        toolNames: pending.toolNames,
        pages: pending.pages,
        routeCount: pending.routes.length,
      });
      continue;
    }
    results.push({ ...base, toolNames: pending.toolNames, pages: pending.pages, routeCount: pending.routes.length });
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
      if (env.length > 0) return field(spec, "", "env");
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

/** Flip `ext.<name>.enabled`. Returns the new enabled state. */
export function toggleExtension(store: BoucleStore, name: string): boolean {
  const next = !isEnabled(store, name);
  store.setMeta(metaKey(name, "enabled"), next ? "1" : "0");
  return next;
}
