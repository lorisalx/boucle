# Boucle OSS phase 3: extensions

Boucle is supposed to be highly customizable — people have their own workflows, their own
capture sources, their own notification channels, their own agent tooling. Phase 3 adds a
first-class extension system so that customization does not require forking the repo.

Same non-negotiables as phases 1–2: the demo works out of the box with zero extensions
installed, no env var breaks, **no new runtime dependencies**, and everything respects Node
type-stripping constraints (no `enum`, no namespaces with values, no parameter properties —
plain `interface`/`type`/functions only). Backend TS runs directly under Node ≥23.6, which is
the load-bearing trick of this whole design: **an extension is a plain `.ts` module loaded
with dynamic `import()` at startup. No build step, no bundler, no manifest format.**

Trust model: extensions are local code running in-process with the same privileges as Boucle
itself. This is a self-hosted, single-user product; we document that clearly instead of
pretending to sandbox. No remote installation, no marketplace, in this phase.

---

## What an extension looks like (target DX)

A directory under the extensions dir containing an `index.ts` with a default export:

```ts
// ~/.local/share/boucle/extensions/ntfy-notify/index.ts
import { definePlugin } from "boucle/extensions"; // resolved via the ctx-relative import shim, see D1

export default definePlugin({
  name: "ntfy-notify",            // [a-z][a-z0-9-]*, unique, doubles as namespace
  version: "0.1.0",
  description: "Push a ntfy.sh notification when a ticket is created",
  settings: [
    { key: "topic", label: "ntfy topic", env: "BOUCLE_NTFY_TOPIC", placeholder: "boucle-loris" },
  ],
  setup(ctx) {
    ctx.on("ticket.created", async (ev) => {
      const topic = ctx.settings.get("topic");
      if (!topic) return;
      await fetch(`https://ntfy.sh/${topic}`, { method: "POST", body: ev.ticket.title });
    });
  },
});
```

Extension discovery order (all loaded, name collisions = later one skipped with an error
status): `<repo>/extensions/` (bundled examples, ship enabled), then
`$BOUCLE_EXTENSIONS_DIR` (default `$XDG_DATA_HOME/boucle/extensions` next to the DB).
Each immediate subdirectory with an `index.ts` or `index.js` is a candidate.

A broken extension (import throws, `setup` throws, invalid manifest) is **isolated**: it is
recorded with `status: "error"` and its message, logged once, and the server boots normally.
An extension can never take Boucle down.

Per-extension enable/disable is a `boucle_meta` key (`ext.<name>.enabled`, default `"1"`).
Toggling from the Settings UI takes effect **on restart** (the toggle response says so —
honest, no fake hot reload in this phase).

---

## The ctx API (what setup receives)

```ts
interface ExtensionContext {
  // events — see workstream B
  on<K extends keyof BoucleEvents>(event: K, handler: (ev: BoucleEvents[K]) => void | Promise<void>): void;

  // agent tools — registered in the SAME unified registry as core tools (workstream A),
  // so they are automatically exposed over MCP (loops/runners) AND to provider chat.
  registerTool(def: ToolDef): void;   // name is auto-prefixed `<ext>_` to avoid collisions

  // HTTP — mounted under /api/ext/<name>/... ; handler is a plain Hono handler
  registerRoute(method: "get" | "post" | "put" | "delete", path: string, handler: Handler): void;

  // web UI — a nav item + static assets served at /ext/<name>/*, rendered in the shell (workstream D)
  registerPage(def: { label: string; icon?: string }): void;  // assets from <extension dir>/web/

  // runners & providers — same interfaces core uses, added to the now-dynamic registries
  registerRunner(runner: AgentRunner): void;
  registerProvider(name: string, factory: (store: SettingsStore) => Provider): void;

  // settings declared in the manifest, resolved meta → env → undefined
  settings: { get(key: string): string | undefined };

  // namespaced KV persistence (boucle_meta with `ext.<name>.kv.` prefix) — enough for state;
  // extensions needing real tables can use ctx.db (the raw DatabaseSync) with `ext_<name>_` table names
  kv: { get(key: string): string | undefined; set(key: string, value: string): void; delete(key: string): void };
  db: DatabaseSync;

  // read/write access to Boucle itself, same surface the agent tools use
  boucle: { store: BoucleStore; search: BrainSearch; executeTool(name: string, args: unknown): Promise<unknown> };

  log: (msg: string) => void;  // prefixed `[ext:<name>]`, goes to server stdout
}
```

Everything above is additive registration collected at startup; nothing is hot-swappable.

---

## Workstream A — unify the tool registry (prerequisite refactor)

Today a tool exists in three places: `mcp.ts` (`server.registerTool`, zod schemas),
`boucle-tools.ts` (`buildBoucleTools`, hand-written JSON schemas), and the
`executeBoucleTool` switch. Extensions cannot plug into a triplicated seam, and the
duplication is already a maintenance smell.

- New `src/tools/registry.ts`:

```ts
export interface ToolDef {
  name: string;
  title: string;
  description: string;
  schema: ZodRawShape;          // the zod shape used today in mcp.ts
  readOnly: boolean;            // replaces BOUCLE_BRAIN_TOOL_NAMES + MCP annotations
  handler: (deps: ToolDeps, args: any) => Promise<unknown>;
}
export function registerCoreTool(def: ToolDef): void;
export function listTools(): ToolDef[];
```

- Move the 14 core tools into `src/tools/core.ts` as `ToolDef`s. The implementations are the
  existing `executeBoucleTool` switch bodies; delete the switch, replace with registry lookup.
- `mcp.ts` becomes a loop: `for (const t of listTools()) server.registerTool(t.name, {...}, ...)`.
- `boucle-tools.ts`'s hand-written JSON schemas are replaced by `z.toJSONSchema(z.object(t.schema))`
  (zod 4 has it built in — no new dependency). `buildBoucleBrainTools` = `listTools().filter(t => t.readOnly)`.
- Behavior contract: the MCP tool list, tool descriptions, and provider-chat tool JSON must
  stay functionally identical (small JSON-schema formatting diffs from zod are fine; tool
  names, required fields, and enums must not change). Add a test that snapshots the tool
  names + required params before/after.

## Workstream B — event bus

- New `src/extensions/events.ts`: a tiny typed emitter (no deps, ~40 lines).

```ts
export interface BoucleEvents {
  "ticket.created":      { ticket: Ticket };
  "ticket.updated":      { ticket: Ticket; changed: string[] };
  "ticket.transitioned": { ticket: Ticket; from: string; to: string };
  "capture.created":     { text: string; kind: string; project: string | null; ticketId: string | null };
  "loop.run.finished":   { loopId: string; loopName: string; ok: boolean; costUsd: number | null; output: string };
  "settings.changed":    { keys: string[] };
  "server.started":      { port: number };
}
export function emit<K>(event: K, payload: BoucleEvents[K]): void;  // fire-and-forget
export function on<K>(event: K, handler: ...): void;
```

- Handlers run async, each wrapped in try/catch; a throwing handler logs
  (`[ext:<name>] handler for ticket.created failed: ...`) and never affects the core flow or
  other handlers. `emit` never awaits handlers (fire-and-forget with `.catch`).
- Emit points: `store.upsert` (created vs updated — upsert already knows which),
  `store.transition`, the capture endpoints in server.ts, `scheduler.run`/`execTracked`
  completion, the settings PUT handler, and the `serve()` callback.
- Core stays oblivious: emitting with zero listeners is free.

## Workstream C — loader, registries, settings, HTTP

### C1. Loader — `src/extensions/loader.ts`

- `loadExtensions(deps): Promise<LoadedExtension[]>` — scan the two dirs, dynamic-`import()`
  each candidate, validate the manifest (name regex, no duplicate, `setup` is a function),
  check `ext.<name>.enabled`, build the ctx, call `setup(ctx)` inside try/catch, collect
  registrations. `LoadedExtension = { name, version, description, dir, status: "active" | "disabled" | "error", error?: string, pages, toolNames, routeCount }`.
- `definePlugin` is an identity function with the manifest type — lives in
  `src/extensions/types.ts`. **D1 import shim**: extensions can't `import "boucle/extensions"`
  from an arbitrary dir, so the loader passes nothing at import time; `definePlugin` is
  optional sugar — a plain default-export object literal with the same shape works. Bundled
  examples import it relatively (`../../src/extensions/types.ts`); external extensions just
  export the object. Document both. (No path mapping tricks, no node_modules symlinks.)
- server.ts wiring: after the singletons, before the settings/static routes:
  `const extensions = await loadExtensions({ store, search, scheduler, app })` (server.ts is
  ESM, top-level await is fine). Extension routes land on a sub-Hono mounted at
  `app.route("/api/ext/<name>", subApp)` and static pages via `serveStatic` at
  `/ext/<name>/*` → `<dir>/web/` — both registered before the `app.get("*")` SPA catch-all.
- `GET /api/extensions` → the LoadedExtension list (no secrets). `POST /api/extensions/:name/toggle`
  → flips `ext.<name>.enabled`, responds `{ restartRequired: true }`.
- CLI: `boucle ext list` — one line per extension with status (reuses the loader in dry mode:
  scan + manifest validation without calling setup).

### C2. Dynamic runner & provider registries

- `runner.ts`: the hardcoded `runners` record becomes a `Map` seeded with vibe/codex/claude +
  `registerRunner(r)`. `RunnerName` widens from the literal union to `string`; the settings
  guards (`settings.ts:77,153`, server.ts loop PUT) validate against `knownRunnerNames()`
  instead of the literal array.
- `providers/index.ts`: the mistral/openai if-else becomes a `Map<string, factory>` seeded
  with both + `registerProvider(name, factory)`. Same treatment for the `ProviderName` guard.
- Ordering constraint: extensions load before the fail-fast provider/runner validation would
  reject an extension-provided name — move the try/catch boot check (server.ts:76-82) to
  after `loadExtensions`. A meta-configured runner from a since-removed extension must
  degrade to the default with a logged warning, not crash the boot.

### C3. Extension settings

- Manifest `settings` entries resolve `boucle_meta["ext.<name>.<key>"]` → `process.env[env]`
  → `undefined`, exposed through `ctx.settings.get`.
- `GET /api/settings` grows an `extensions` section: per extension, the declared fields with
  current value + source (meta/env/unset). Secrets stay out of scope: extension settings are
  plain values; anything sensitive should use env vars, same doctrine as API keys (document it).
- `PUT /api/settings` accepts `{ extensions: { "<name>": { "<key>": "value" } } }`, validated
  against declared keys only, written to meta, `settings.changed` emitted (extensions can
  re-read via `ctx.settings.get` — values are read live from meta, no caching, so no
  invalidation dance needed).

## Workstream D — web UI

- **Nav**: `Shell.tsx`'s `NAV` array stays; `NavLinks` appends items from a new
  `useExtensions()` hook (`GET /api/extensions`, cached). Each active extension with a
  registered page contributes `{ hash: "#/ext/<name>", label, icon }`. Icon: small named
  subset of lucide icons (map string → component, fallback `Puzzle`).
- **Page**: `App.tsx` route chain gets one new branch: `#/ext/<name>` →
  `<ExtensionPage name>` — an iframe filling the content area, `src="/ext/<name>/"`,
  sandboxed `allow-same-origin allow-scripts allow-forms`. The extension's `web/index.html`
  is fully self-contained (it can call `/api/ext/<name>/...` and the public `/api/*`).
  Iframe-in-shell is the honest v1: zero coupling to the host bundle, no module federation.
- **Settings page**: one "Extensions" card — list of extensions with status pill
  (active/disabled/error+message), enable/disable toggle ("takes effect on restart"), and the
  declared settings fields as inputs (same save-per-card pattern as existing cards).
- `api.ts`: add the `Extension` type + `api.extensions()`, `api.toggleExtension()`, extend the
  `Settings` type. Types hand-mirrored as usual.

## Workstream E — bundled examples, docs, tests

- `extensions/hello-world/` — registers a page (static `web/index.html` that fetches
  `/api/ext/hello-world/stats` and renders open-ticket counts) + one route + one read-only
  tool (`hello_world_stats`). Serves as the template and the QA target.
- `extensions/webhook-capture/` — `POST /api/ext/webhook-capture/hook` accepting
  `{ title, body?, project? }` (+ optional shared-secret setting checked via header),
  creating a ticket through `ctx.boucle.executeTool("ticket_upsert", ...)` and emitting
  nothing itself (capture.created comes from core). The "wire anything into Boucle" demo.
- `docs/extensions.md` — the authoring guide: DX example, full ctx reference, events table,
  dirs, enable/disable, trust model, type-stripping constraints for extension authors.
- README: short "Extensions" section linking to the doc.
- Tests (`node:test`, colocated): `tools-registry.test.ts` (snapshot of core tool names +
  required params, readOnly filtering), `events.test.ts` (isolation: throwing handler doesn't
  break siblings), `extensions-loader.test.ts` (tmp-dir fixtures: loads a good extension,
  isolates a broken one, respects disabled flag, name collision, KV namespacing, settings
  resolution meta→env). Existing tests must stay green.

---

## Sequencing

1. **A + B** — pure refactor + bus, no behavior change, tests prove it.
2. **C** — loader + registries + settings + HTTP + CLI, with loader tests.
3. **D + E** — web UI, examples, docs.

Each stage leaves `pnpm typecheck`, `node --test src/`, and a booting server green.
