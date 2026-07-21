// webhook-capture — wire anything into Boucle: POST a JSON payload, get a ticket.
//
//   curl -X POST http://localhost:4419/api/ext/webhook-capture/hook \
//        -H 'content-type: application/json' \
//        -H 'x-boucle-secret: <secret>' \
//        -d '{"title":"Deploy failed","body":"see CI run 123","project":"boucle"}'
//
// The optional shared secret (BOUCLE_WEBHOOK_SECRET or the Settings field) gates the route.
// It creates the ticket through ctx.boucle.executeTool so it goes through the same validation,
// scoring, and `ticket.created` event as any other capture.
import { randomUUID } from "node:crypto";

import type { Context } from "hono";

import { definePlugin } from "../../src/extensions/types.ts";

export default definePlugin({
  name: "webhook-capture",
  version: "0.1.0",
  description: "Turn an inbound webhook into a Boucle ticket.",
  settings: [
    { key: "secret", label: "Shared secret", env: "BOUCLE_WEBHOOK_SECRET", placeholder: "optional x-boucle-secret header", secret: true },
  ],
  setup(ctx) {
    ctx.registerRoute("post", "/hook", async (c: Context) => {
      const secret = ctx.settings.get("secret");
      if (secret && c.req.header("x-boucle-secret") !== secret) {
        return c.json({ error: "unauthorized" }, 401);
      }
      const body = (await c.req.json().catch(() => null)) as
        | { title?: unknown; body?: unknown; project?: unknown }
        | null;
      if (!body || typeof body !== "object") return c.json({ error: "json body required" }, 400);
      const title = typeof body.title === "string" ? body.title.trim() : "";
      if (!title) return c.json({ error: "title required" }, 400);

      const args: Record<string, unknown> = {
        dedupeKey: `webhook:${randomUUID()}`,
        title,
        source: "manual",
        createdBy: "human",
        needs: "none",
      };
      if (typeof body.body === "string") args.body = body.body;
      if (typeof body.project === "string") args.project = body.project;

      try {
        const ticket = await ctx.boucle.executeTool("ticket_upsert", args);
        ctx.log(`captured "${title}"`);
        return c.json({ ok: true, ticket });
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
      }
    });
  },
});
