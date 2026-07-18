/**
 * boucle MCP — exposes the ticket store (and the t3code chat handoff) as tools.
 *
 * One registry, served two ways: over HTTP at /mcp (see server.ts) and over stdio
 * (`boucle mcp`, see cli.ts). Loops point Codex/Claude at these tools so a run can
 * capture, rank, update tickets, and kick off agent work — instead of shelling out
 * to the `boucle` CLI.
 */
import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type {
  BoucleStore,
  ListTicketsFilter,
  SetTicketFieldsInput,
  Ticket,
  TicketSourceEvent,
  UpsertTicketInput,
} from "./store.ts";
import { SPAWNED_CHAT_GUARDRAILS } from "./config.ts";
import { getT3CodeConfig, spawnT3CodeChat } from "./t3code.ts";

const SOURCES = ["slack", "gmail", "gcal", "clickup", "manual"] as const;
const PRIORITIES = ["urgent", "high", "normal", "low"] as const;
const KINDS = ["task", "idea", "conv", "scope"] as const;
const KIND_DESC =
  "What the item IS: task = actionable; idea = something Loris wants to remember (not yet actionable); conv = pointer to an agent conversation; scope = a larger design to break down. Default task.";
const BUCKETS = ["urgent", "to_do_next", "cool_to_do", "maybe_one_day"] as const;
const NEEDS = ["claude", "codex", "human", "none"] as const;
const EFFORTS = ["xs", "s", "m", "l", "xl"] as const;
const STATUSES = ["inbox", "triaged", "next", "snoozed", "blocked", "in_progress", "done", "dropped"] as const;
const DECISIONS = ["ticketed", "ignored", "merged"] as const;

type ToolResult = { content: Array<{ type: "text"; text: string }> };

function ok(value: unknown): ToolResult {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }] };
}

/** Stable bearer token for the HTTP transport. Env override, else generated once into boucle_meta. */
export function getMcpToken(store: BoucleStore): string {
  const fromEnv = (process.env.BOUCLE_MCP_TOKEN ?? "").trim();
  if (fromEnv) return fromEnv;
  let token = store.getMeta("mcpToken");
  if (!token) {
    token = randomUUID().replace(/-/g, "");
    store.setMeta("mcpToken", token);
  }
  return token;
}

/** A copy-pasteable codex/claude `config.toml` block for both transports. */
export function mcpConfigToml(opts: { url: string; token: string; cliPath: string; dbPath: string }): string {
  return `# HTTP transport — the boucle server must be running:
[mcp_servers.boucle]
url = "${opts.url}"
bearer_token = "${opts.token}"

# --- or stdio transport (no running server / token needed) ---
# [mcp_servers.boucle]
# command = "node"
# args = ["${opts.cliPath}", "mcp"]
# env = { BOUCLE_DB = "${opts.dbPath}" }
`;
}

/** First-user-message prompt for a spawned chat (mirrors server.ts buildPrompt). */
function buildChatPrompt(t: Ticket): string {
  const lines = [`Help me with this task: ${t.title}`];
  if (t.body.trim().length > 0) lines.push("", t.body.trim());
  const meta: string[] = [];
  if (t.project) meta.push(`Project: ${t.project}`);
  if (t.requester) meta.push(`Requested by: ${t.requester}`);
  meta.push(`Source: ${t.source}${t.permalink ? ` — ${t.permalink}` : ""}`);
  if (t.nextAction) meta.push(`Next action: ${t.nextAction}`);
  if (meta.length > 0) lines.push("", ...meta.map((m) => `- ${m}`));
  lines.push("", SPAWNED_CHAT_GUARDRAILS);
  return lines.join("\n");
}

export function createBoucleMcpServer(store: BoucleStore): McpServer {
  const server = new McpServer({ name: "boucle", version: "0.1.0" });

  server.registerTool(
    "ticket_upsert",
    {
      title: "Upsert ticket",
      description:
        "Create or refresh a ticket. Idempotent on dedupeKey (e.g. \"slack:C123:1700000000.0001\", \"gmail:<id>\"): re-running with the same key never duplicates and preserves human triage (status/priority/project).",
      inputSchema: {
        dedupeKey: z.string().describe("Stable per-signal key; reuse it to update instead of duplicate."),
        title: z.string().describe("Short imperative, e.g. \"Reply to Daniel re: alerts\"."),
        source: z.enum(SOURCES),
        body: z.string().optional(),
        priority: z.enum(PRIORITIES).optional(),
        kind: z.enum(KINDS).optional().describe(KIND_DESC),
        bucket: z
          .enum(BUCKETS)
          .nullable()
          .optional()
          .describe("Triage bucket for the EPIC (how pressing). Defaults from priority when omitted."),
        project: z.string().nullable().optional().describe("gbrain project slug if obvious."),
        sourceRef: z.string().nullable().optional(),
        permalink: z.string().nullable().optional(),
        requester: z.string().nullable().optional().describe("person slug who asked, e.g. first-last."),
        needs: z.enum(NEEDS).optional().describe("claude/codex for agent work, human for Loris-only, none for trivial."),
        effort: z.enum(EFFORTS).nullable().optional(),
        dueAt: z.string().nullable().optional().describe("ISO 8601."),
        nextAction: z.string().nullable().optional().describe("The single concrete next step."),
        threadId: z
          .string()
          .nullable()
          .optional()
          .describe(
            "t3code chat thread UUID. Set automatically by spawn_chat — do NOT set this manually and never put a Slack channel/thread id here.",
          ),
      },
      annotations: { idempotentHint: true },
    },
    async (args) => ok(store.upsert(args as UpsertTicketInput)),
  );

  server.registerTool(
    "ticket_list",
    {
      title: "List tickets",
      description: "List tickets ranked by score, optionally filtered by status/project/needs.",
      inputSchema: {
        status: z.enum(STATUSES).optional(),
        project: z.string().optional(),
        needs: z.enum(NEEDS).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => ok(store.list(args as ListTicketsFilter)),
  );

  server.registerTool(
    "ticket_next",
    {
      title: "What's next",
      description: "The ranked, actionable queue (open, non-snoozed), global or per-project.",
      inputSchema: {
        project: z.string().optional(),
        limit: z.number().int().positive().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ project, limit }) => ok(store.next(project ?? null, limit ?? 50)),
  );

  server.registerTool(
    "ticket_get",
    {
      title: "Get ticket",
      description: "One ticket plus its resolution timeline (events).",
      inputSchema: { ticketId: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ ticketId }) => {
      const ticket = store.getById(ticketId);
      return ok({ ticket, events: ticket ? store.listEvents(ticketId) : [] });
    },
  );

  server.registerTool(
    "ticket_set",
    {
      title: "Set ticket fields",
      description: "Edit mutable fields (priority/bucket/project/needs/effort/dueAt/nextAction/threadId/clickupTaskId/wantsClickup) and recompute score.",
      inputSchema: {
        ticketId: z.string(),
        title: z.string().optional(),
        body: z.string().optional(),
        priority: z.enum(PRIORITIES).optional(),
        kind: z.enum(KINDS).optional().describe(KIND_DESC),
        bucket: z.enum(BUCKETS).nullable().optional().describe("Triage bucket for the EPIC (how pressing)."),
        project: z.string().nullable().optional(),
        needs: z.enum(NEEDS).optional(),
        effort: z.enum(EFFORTS).nullable().optional(),
        dueAt: z.string().nullable().optional(),
        nextAction: z.string().nullable().optional(),
        threadId: z.string().nullable().optional(),
        wantsClickup: z.boolean().optional(),
        clickupTaskId: z.string().nullable().optional(),
      },
    },
    async (args) => ok(store.setFields(args as SetTicketFieldsInput)),
  );

  server.registerTool(
    "ticket_transition",
    {
      title: "Transition ticket",
      description:
        "Move a ticket to a new status (inbox/triaged/next/snoozed/blocked/in_progress/done/dropped). snoozedUntil only applies to 'snoozed'. Pass `reason` when closing (done/dropped) — it lands in the timeline so the queue records WHY it self-cleaned. Pass `workRef` to link the work that resolved it (e.g. the Claude convo that did it, a ClickUp/PR URL) so the ticket points back to it.",
      inputSchema: {
        ticketId: z.string(),
        toStatus: z.enum(STATUSES),
        snoozedUntil: z.string().nullable().optional().describe("ISO 8601; only for --to snoozed."),
        reason: z.string().nullable().optional().describe("One line on why, e.g. \"Loris replied in-thread; ClickUp CU-123 created\". Recorded on the timeline."),
        workRef: z
          .string()
          .nullable()
          .optional()
          .describe(
            "Pointer to the work that resolved this. If you (an agent) did the work, pass your own resumable convo reference verbatim (the SessionStart context gives it, e.g. \"claude --resume <id> (cwd: …)\"); or a ClickUp/PR URL.",
          ),
      },
    },
    async ({ ticketId, toStatus, snoozedUntil, reason, workRef }) =>
      ok(store.transition(ticketId, toStatus, snoozedUntil ?? null, reason ?? null, workRef ?? null)),
  );

  server.registerTool(
    "source_seen",
    {
      title: "Was signal already classified?",
      description: "Check whether a dedupeKey was already triaged (so a loop can skip repeats).",
      inputSchema: { dedupeKey: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ dedupeKey }) => {
      const event = store.getSourceEvent(dedupeKey);
      return ok(event ? { seen: true, ...event } : { seen: false });
    },
  );

  server.registerTool(
    "mark_source_seen",
    {
      title: "Record signal classification",
      description: "Audit/dedupe: record that a signal was ticketed/ignored/merged. Idempotent on dedupeKey.",
      inputSchema: {
        source: z.enum(SOURCES),
        sourceRef: z.string(),
        dedupeKey: z.string(),
        ticketId: z.string().nullable().optional(),
        decision: z.enum(DECISIONS),
      },
      annotations: { idempotentHint: true },
    },
    async (args) => {
      const input = { ...args, ticketId: args.ticketId ?? null } as Omit<TicketSourceEvent, "seenAt">;
      store.markSourceSeen(input);
      return ok({ ok: true });
    },
  );

  server.registerTool(
    "reprioritize",
    {
      title: "Reprioritize",
      description: "Recompute scores for all open tickets. Run once at the end of a capture pass.",
      inputSchema: {},
    },
    async () => ok({ updated: store.reprioritize() }),
  );

  server.registerTool(
    "spawn_chat",
    {
      title: "Kick off an agent chat",
      description:
        "Start a Claude/agent conversation in t3code for a ticket and link the thread back to it. Requires t3code configured in Settings. Use for tickets that need agent work (needs=claude/codex).",
      inputSchema: { ticketId: z.string() },
    },
    async ({ ticketId }) => {
      const ticket = store.getById(ticketId);
      if (!ticket) return ok({ error: "ticket not found" });
      const cfg = getT3CodeConfig(store);
      if (cfg === null) return ok({ error: "t3code not configured. Set its URL + token in Settings." });
      try {
        const result = await spawnT3CodeChat(cfg, {
          defaultProject: store.getMeta("defaultProject") ?? "dataiku",
          title: ticket.title,
          prompt: buildChatPrompt(ticket),
        });
        store.setFields({ ticketId, threadId: result.threadId });
        return ok(result);
      } catch (error) {
        return ok({ error: error instanceof Error ? error.message : String(error) });
      }
    },
  );

  return server;
}
