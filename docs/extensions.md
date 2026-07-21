# Extensions

Boucle is extensible without forking. An extension is a plain TypeScript module loaded with
dynamic `import()` at startup — **no build step, no bundler, no manifest format**. It can add
agent tools, HTTP routes, web pages, agent runners, providers, and event handlers.

## Trust model

Extensions are local code that runs in-process with the **same privileges as Boucle itself**.
There is no sandbox: an extension can read and write your database, call the network, and run
any code. Boucle is self-hosted and single-user — only install extensions you trust, the same
way you would trust any dependency. There is no remote installation and no marketplace.

A broken extension is isolated: if its import throws, its manifest is invalid, or its `setup`
throws, it is recorded with `status: "error"` and its message, logged once, and the server
boots normally. An extension can never take Boucle down.

## Where extensions live

Two directories are scanned, in this order (name collisions: the first wins, the later one is
skipped with an error status):

1. `<repo>/extensions/` — bundled examples, shipped enabled.
2. `$BOUCLE_EXTENSIONS_DIR` — your own extensions. Defaults to `$XDG_DATA_HOME/boucle/extensions`
   (next to the database).

Each immediate subdirectory with an `index.ts` (or `index.js`) is a candidate. The directory
name is the extension name and doubles as its namespace: `[a-z][a-z0-9-]*`.

## A minimal extension

```ts
// $BOUCLE_EXTENSIONS_DIR/ntfy-notify/index.ts
export default {
  name: "ntfy-notify",
  version: "0.1.0",
  description: "Push a ntfy.sh notification when a ticket is created",
  settings: [{ key: "topic", label: "ntfy topic", env: "BOUCLE_NTFY_TOPIC", placeholder: "boucle-me" }],
  setup(ctx) {
    ctx.on("ticket.created", async (ev) => {
      const topic = ctx.settings.get("topic");
      if (!topic) return;
      await fetch(`https://ntfy.sh/${topic}`, { method: "POST", body: ev.ticket.title });
    });
  },
};
```

That is the whole thing: a directory, an `index.ts`, a default-exported object. Restart Boucle
and it loads.

### `definePlugin` (optional sugar)

Bundled examples import a tiny identity helper for editor autocomplete:

```ts
import { definePlugin } from "../../src/extensions/types.ts";
export default definePlugin({ name: "hello-world", setup(ctx) { /* … */ } });
```

External extensions in your data dir **cannot resolve that path** — and don't need to. A plain
object literal of the same shape (as above) is identical at runtime. Use `definePlugin` only
when your editor can see the Boucle source; otherwise just export the object.

## The `ctx` API

`setup(ctx)` receives everything an extension can register or read. All registration is collected
once at startup — nothing is hot-swappable.

| Member | Purpose |
|---|---|
| `ctx.on(event, handler)` | Subscribe to a core event (table below). Handlers are isolated. |
| `ctx.registerTool(def)` | Add an agent tool. Its name is auto-prefixed `<ext>_` (hyphens → `_`). Exposed over MCP **and** to provider chat. |
| `ctx.registerRoute(method, path, handler)` | Mount a Hono handler under `/api/ext/<name>/<path>`. |
| `ctx.registerPage(def)` | Add a nav item + page; static assets are served from `<dir>/web/` at `/ext/<name>/`. |
| `ctx.registerRunner(runner)` | Contribute an agent runner selectable via the `runner` setting. |
| `ctx.registerProvider(name, factory)` | Contribute a provider selectable via the `provider` setting. |
| `ctx.settings.get(key)` | Read a declared setting, resolved meta → env → `undefined` (live, uncached). |
| `ctx.kv` | `get`/`set`/`delete` namespaced KV persistence (stored under `ext.<name>.kv.`). |
| `ctx.db` | The raw `node:sqlite` handle — for extensions that need real tables (use `ext_<name>_` names). |
| `ctx.boucle` | `{ store, search, executeTool(name, args) }` — the same surface the agent tools use. |
| `ctx.log(msg)` | Log to server stdout, prefixed `[ext:<name>]`. |

### A tool (read-only)

```ts
ctx.registerTool({
  name: "stats",                 // exposed as hello_world_stats
  title: "Open ticket stats",
  description: "Count of open tickets, grouped by status.",
  schema: {},                    // a Zod raw shape, e.g. { query: z.string() }
  readOnly: true,
  handler: () => ctx.boucle.store.listOpen().length,
});
```

`readOnly` tools are also offered to the read-only global brain chat. Non-`readOnly` tools can
mutate. Prefer routing writes through `ctx.boucle.executeTool("ticket_upsert", …)` so they go
through the same validation, scoring, and events as any other capture.

### A route

```ts
ctx.registerRoute("post", "/hook", async (c) => {
  const body = await c.req.json();
  const ticket = await ctx.boucle.executeTool("ticket_upsert", {
    dedupeKey: `webhook:${crypto.randomUUID()}`,
    title: body.title,
    source: "manual",
    createdBy: "human",
  });
  return c.json({ ok: true, ticket });
});
// POST http://localhost:4419/api/ext/<name>/hook
```

### A page

`ctx.registerPage({ label, icon })` adds a sidebar item. The page itself is a self-contained
`web/index.html` under the extension directory, served at `/ext/<name>/` and rendered in the
shell inside a sandboxed iframe. It can call its own `/api/ext/<name>/…` routes and the public
`/api/*` surface. Icons are a small named subset of [lucide](https://lucide.dev) (`puzzle`,
`bell`, `box`, `plug`, `webhook`, `zap`, `activity`); anything else falls back to `puzzle`.

## Events

`ctx.on(event, handler)` handlers run asynchronously and fire-and-forget; a throwing handler is
logged and never affects the core flow or other handlers.

| Event | Payload |
|---|---|
| `ticket.created` | `{ ticket }` |
| `ticket.updated` | `{ ticket, changed: string[] }` |
| `ticket.transitioned` | `{ ticket, from, to }` |
| `capture.created` | `{ text, kind, project, ticketId }` |
| `loop.run.finished` | `{ loopId, loopName, ok, costUsd, output }` |
| `settings.changed` | `{ keys: string[] }` |
| `server.started` | `{ port }` |

## Settings

Declare settings in the manifest; they appear as fields in **Settings → Extensions** and resolve
`meta` (saved in the UI) → `env` (the declared `env` var) → `undefined`. Settings are **plain
values**: anything sensitive (API keys, secrets) should come from an environment variable, the
same doctrine Boucle uses for provider keys — declare `env` and leave the value unset in the UI.
Environment-backed values are never returned to the browser; the UI shows only that the variable
is set.

Setting keys must be unique within the manifest. `enabled` and keys beginning with `kv.` are
reserved for the extension toggle and `ctx.kv` storage.

## Enable / disable

Every extension has a per-name toggle in **Settings → Extensions** (stored as
`ext.<name>.enabled`, default on). Toggling takes effect **on restart** — registration happens
once at boot, so there is no fake hot reload.

List everything from the CLI without starting the server:

```
boucle ext list
```

## Constraints for extension authors

Boucle's backend runs directly under Node ≥23.6 with type-stripping. Your `index.ts` is loaded
the same way, so the same rules apply: **no `enum`, no namespaces with values, no parameter
properties, no `import`/`export =`** — plain `interface`/`type`/functions and ordinary imports
only. Keep to Node built-ins and `fetch`; Boucle ships **no runtime dependencies** and neither
should an extension expect any to be installed for it.

See `extensions/hello-world/` (a page + route + tool) and `extensions/webhook-capture/`
(a secret-gated capture webhook) for complete, working templates.
