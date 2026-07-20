import { z } from "zod";

import { graphSearch } from "../graph.ts";
import { getIdentity, type Identity } from "../identity.ts";
import { getProjectPage, isValidProjectId } from "../projects.ts";
import type {
  ListTicketsFilter,
  SetTicketFieldsInput,
  TicketSourceEvent,
  TicketStatus,
  UpsertTicketInput,
} from "../store.ts";
import type { ToolDef } from "./registry.ts";

const SOURCES = ["slack", "gmail", "gcal", "manual"] as const;
const PRIORITIES = ["urgent", "high", "normal", "low"] as const;
const KINDS = ["task", "idea", "conv", "scope"] as const;
const BUCKETS = ["urgent", "to_do_next", "cool_to_do", "maybe_one_day"] as const;
const NEEDS = ["claude", "codex", "human", "none"] as const;
const EFFORTS = ["xs", "s", "m", "l", "xl"] as const;
const STATUSES = ["inbox", "triaged", "next", "snoozed", "blocked", "in_progress", "done", "dropped"] as const;
const DECISIONS = ["ticketed", "ignored", "merged"] as const;

type ToolArgs = Record<string, unknown>;

function requiredString(args: ToolArgs, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${key} must be a non-empty string`);
  return value;
}

function validateProject(project: unknown): void {
  if (typeof project === "string" && !isValidProjectId(project)) {
    throw new Error("project must be a valid project slug");
  }
}

function kindDescription(identity: Identity): string {
  const owner = identity.ownerName || "the owner";
  return `What the item IS: task = actionable; idea = something ${owner} wants to remember (not yet actionable); conv = pointer to an agent conversation; scope = a larger design to break down. Default task.`;
}

export const CORE_TOOLS: readonly ToolDef[] = [
  {
    name: "brain_search",
    title: "Search the brain",
    get description() {
      const identity = getIdentity();
      return `Search tickets, ticket history, meetings, and ${identity.demoMode ? "synthetic " : ""}brain project pages before deduping or merging work.`;
    },
    schema: { query: z.string(), limit: z.number().int().min(1).max(20).optional() },
    readOnly: true,
    async handler({ store }, args: ToolArgs) {
      return store.search(requiredString(args, "query"), typeof args.limit === "number" ? args.limit : 20);
    },
  },
  {
    name: "brain_graph_search",
    title: "GraphRAG search over the brain",
    description:
      "Hybrid-search seeds expanded over the entity graph (projects, tickets, meetings, people). Returns the connected neighborhood with a via-path per node. Use for questions that span entities.",
    schema: { query: z.string(), limit: z.number().int().min(1).max(25).optional() },
    readOnly: true,
    async handler(_deps, args: ToolArgs) {
      return graphSearch(requiredString(args, "query"), typeof args.limit === "number" ? args.limit : undefined);
    },
  },
  {
    name: "ticket_upsert",
    title: "Upsert ticket",
    description:
      "Create or refresh a ticket. Idempotent on dedupeKey (e.g. \"slack:C123:1700000000.0001\", \"gmail:<id>\"): re-running with the same key never duplicates and preserves human triage (status/priority/project).",
    get schema() {
      const identity = getIdentity();
      const owner = identity.ownerName || "the owner";
      return {
        dedupeKey: z.string().describe("Stable per-signal key; reuse it to update instead of duplicate."),
        title: z.string().describe("Short imperative, e.g. \"Reply to Daniel re: alerts\"."),
        source: z.enum(SOURCES),
        body: z.string().optional(),
        priority: z.enum(PRIORITIES).optional(),
        kind: z.enum(KINDS).optional().describe(kindDescription(identity)),
        bucket: z
          .enum(BUCKETS)
          .nullable()
          .optional()
          .describe("Triage bucket for the EPIC (how pressing). Defaults from priority when omitted."),
        project: z.string().nullable().optional().describe("gbrain project slug if obvious."),
        sourceRef: z.string().nullable().optional(),
        permalink: z.string().nullable().optional(),
        requester: z.string().nullable().optional().describe("person slug who asked, e.g. first-last."),
        needs: z.enum(NEEDS).optional().describe(`claude/codex for agent work, human for ${owner} only, none for trivial.`),
        effort: z.enum(EFFORTS).nullable().optional(),
        dueAt: z.string().nullable().optional().describe("ISO 8601."),
        nextAction: z.string().nullable().optional().describe("The single concrete next step."),
        threadId: z
          .string()
          .nullable()
          .optional()
          .describe(
            "Provider conversation ID. Set automatically by spawn_chat — do NOT set this manually and never put a Slack channel/thread id here.",
          ),
      };
    },
    readOnly: false,
    async handler({ store }, args: ToolArgs) {
      validateProject(args.project);
      return store.upsert(args as unknown as UpsertTicketInput);
    },
  },
  {
    name: "ticket_list",
    title: "List tickets",
    description: "List tickets ranked by score, optionally filtered by status/project/needs.",
    schema: {
      status: z.enum(STATUSES).optional(),
      project: z.string().optional(),
      needs: z.enum(NEEDS).optional(),
    },
    readOnly: true,
    async handler({ store }, args: ToolArgs) {
      return store.list(args as ListTicketsFilter);
    },
  },
  {
    name: "ticket_next",
    title: "What's next",
    description: "The ranked, actionable queue (open, non-snoozed), global or per-project.",
    schema: {
      project: z.string().optional(),
      limit: z.number().int().positive().optional(),
    },
    readOnly: true,
    async handler({ store }, args: ToolArgs) {
      return store.next(typeof args.project === "string" ? args.project : null, typeof args.limit === "number" ? args.limit : 50);
    },
  },
  {
    name: "ticket_get",
    title: "Get ticket",
    description: "One ticket plus its resolution timeline (events).",
    schema: { ticketId: z.string() },
    readOnly: true,
    async handler({ store }, args: ToolArgs) {
      const ticketId = requiredString(args, "ticketId");
      const ticket = store.getById(ticketId);
      return { ticket, events: ticket ? store.listEvents(ticketId) : [] };
    },
  },
  {
    name: "ticket_set",
    title: "Set ticket fields",
    description: "Edit mutable fields (priority/bucket/project/needs/effort/dueAt/nextAction/threadId) and recompute score.",
    get schema() {
      const identity = getIdentity();
      return {
        ticketId: z.string(),
        title: z.string().optional(),
        body: z.string().optional(),
        priority: z.enum(PRIORITIES).optional(),
        kind: z.enum(KINDS).optional().describe(kindDescription(identity)),
        bucket: z.enum(BUCKETS).nullable().optional().describe("Triage bucket for the EPIC (how pressing)."),
        project: z.string().nullable().optional(),
        needs: z.enum(NEEDS).optional(),
        effort: z.enum(EFFORTS).nullable().optional(),
        dueAt: z.string().nullable().optional(),
        nextAction: z.string().nullable().optional(),
        threadId: z.string().nullable().optional(),
      };
    },
    readOnly: false,
    async handler({ store }, args: ToolArgs) {
      validateProject(args.project);
      return store.setFields(args as unknown as SetTicketFieldsInput);
    },
  },
  {
    name: "ticket_transition",
    title: "Transition ticket",
    get description() {
      return "Move a ticket to a new status (inbox/triaged/next/snoozed/blocked/in_progress/done/dropped). snoozedUntil only applies to 'snoozed'. Pass `reason` when closing (done/dropped) — it lands in the timeline so the queue records WHY it self-cleaned. Pass `workRef` to link the work that resolved it (e.g. the agent conversation or a PR URL) so the ticket points back to it.";
    },
    get schema() {
      const identity = getIdentity();
      const owner = identity.ownerName || "the owner";
      return {
        ticketId: z.string(),
        toStatus: z.enum(STATUSES),
        snoozedUntil: z.string().nullable().optional().describe("ISO 8601; only for --to snoozed."),
        reason: z.string().nullable().optional().describe(`One line on why, e.g. "${owner} replied in-thread; the draft was approved". Recorded on the timeline.`),
        workRef: z
          .string()
          .nullable()
          .optional()
          .describe(
            `Pointer to the work that resolved this. If you (an agent) did the work, pass your own resumable conversation reference verbatim; otherwise use ${identity.demoMode ? "a synthetic brain artifact" : "a brain artifact"} or PR URL.`,
          ),
      };
    },
    readOnly: false,
    async handler({ store }, args: ToolArgs) {
      return store.transition(
        requiredString(args, "ticketId"),
        requiredString(args, "toStatus") as TicketStatus,
        typeof args.snoozedUntil === "string" ? args.snoozedUntil : null,
        typeof args.reason === "string" ? args.reason : null,
        typeof args.workRef === "string" ? args.workRef : null,
      );
    },
  },
  {
    name: "ticket_comment",
    title: "Comment on ticket",
    description: "Add a note to a ticket's timeline without changing its fields.",
    schema: { ticketId: z.string(), text: z.string() },
    readOnly: false,
    async handler({ store }, args: ToolArgs) {
      const ticketId = requiredString(args, "ticketId");
      if (!store.getById(ticketId)) throw new Error(`Ticket not found: ${ticketId}`);
      store.addEvent(ticketId, "note", requiredString(args, "text"));
      return { ok: true };
    },
  },
  {
    name: "project_page_read",
    title: "Read project page",
    get description() {
      const identity = getIdentity();
      return `Read the ${identity.demoMode ? "synthetic " : ""}brain page and timeline for a project slug.`;
    },
    schema: { projectId: z.string() },
    readOnly: true,
    async handler(_deps, args: ToolArgs) {
      const projectId = requiredString(args, "projectId");
      if (!isValidProjectId(projectId)) throw new Error("projectId must be a valid project slug");
      return getProjectPage(projectId);
    },
  },
  {
    name: "source_seen",
    title: "Was signal already classified?",
    description: "Check whether a dedupeKey was already triaged (so a loop can skip repeats).",
    schema: { dedupeKey: z.string() },
    readOnly: false,
    async handler({ store }, args: ToolArgs) {
      const event = store.getSourceEvent(requiredString(args, "dedupeKey"));
      return event ? { seen: true, ...event } : { seen: false };
    },
  },
  {
    name: "mark_source_seen",
    title: "Record signal classification",
    description: "Audit/dedupe: record that a signal was ticketed/ignored/merged. Idempotent on dedupeKey.",
    schema: {
      source: z.enum(SOURCES),
      sourceRef: z.string(),
      dedupeKey: z.string(),
      ticketId: z.string().nullable().optional(),
      decision: z.enum(DECISIONS),
    },
    readOnly: false,
    async handler({ store }, args: ToolArgs) {
      const input = { ...args, ticketId: args.ticketId ?? null } as unknown as Omit<TicketSourceEvent, "seenAt">;
      store.markSourceSeen(input);
      return { ok: true };
    },
  },
  {
    name: "reprioritize",
    title: "Reprioritize",
    description: "Recompute scores for all open tickets. Run once at the end of a capture pass.",
    schema: {},
    readOnly: false,
    async handler({ store }) {
      return { updated: store.reprioritize() };
    },
  },
  {
    name: "spawn_chat",
    title: "Kick off an agent chat",
    description:
      "Start a provider conversation for a ticket and link it back to the ticket. Requires the configured provider key. Use for tickets that need agent work (needs=claude/codex).",
    schema: { ticketId: z.string() },
    readOnly: false,
    async handler({ store }, args: ToolArgs) {
      const ticket = store.getById(requiredString(args, "ticketId"));
      if (!ticket) return { error: "ticket not found" };
      try {
        const { spawnChat } = await import("../chat.ts");
        return await spawnChat(store, ticket);
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    },
  },
];
