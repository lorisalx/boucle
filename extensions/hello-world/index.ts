// hello-world — the minimal Boucle extension and authoring template.
//
// It registers all three of the "surface" primitives: a nav page (served from ./web/),
// an HTTP route, and a read-only agent tool. Copy this directory to start your own.
//
// Bundled examples import definePlugin relatively. An external extension in your data dir
// cannot resolve this path — there, just `export default { name, version, setup(ctx) {...} }`
// (a plain object literal of the same shape); definePlugin is only editor sugar.
import type { Context } from "hono";

import { definePlugin } from "../../src/extensions/types.ts";

function openTicketStats(ctx: import("../../src/extensions/types.ts").ExtensionContext) {
  const open = ctx.boucle.store.listOpen();
  const byStatus: Record<string, number> = {};
  for (const ticket of open) byStatus[ticket.status] = (byStatus[ticket.status] ?? 0) + 1;
  return { open: open.length, byStatus };
}

export default definePlugin({
  name: "hello-world",
  version: "0.1.0",
  description: "A tiny example: a page, a route, and a read-only tool.",
  setup(ctx) {
    // Nav item + page. Assets come from ./web/, served at /ext/hello-world/.
    ctx.registerPage({ label: "Hello", icon: "puzzle" });

    // GET /api/ext/hello-world/stats — the page fetches this.
    ctx.registerRoute("get", "/stats", (c: Context) => c.json(openTicketStats(ctx)));

    // A read-only agent tool, exposed over MCP and to provider chat as `hello_world_stats`.
    ctx.registerTool({
      name: "stats",
      title: "Open ticket stats",
      description: "Count of currently-open Boucle tickets, grouped by status.",
      schema: {},
      readOnly: true,
      handler: () => openTicketStats(ctx),
    });
  },
});
