import { graphSearch } from "./graph.ts";
import type { Identity } from "./identity.ts";
import { getProjectPage, isValidProjectId } from "./projects.ts";
import type { ToolSpec } from "./providers/types.ts";
import type { BoucleStore, ListTicketsFilter, SetTicketFieldsInput, TicketStatus } from "./store.ts";

const enumValues = (values: readonly string[]) => ({ type: "string", enum: values });

const STATUSES = ["inbox", "triaged", "next", "snoozed", "blocked", "in_progress", "done", "dropped"] as const;
const PRIORITIES = ["urgent", "high", "normal", "low"] as const;
const KINDS = ["task", "idea", "conv", "scope"] as const;
const BUCKETS = ["urgent", "to_do_next", "cool_to_do", "maybe_one_day"] as const;
const NEEDS = ["claude", "codex", "human", "none"] as const;
const EFFORTS = ["xs", "s", "m", "l", "xl"] as const;

/** Store-backed tools safe to expose to a provider conversation. */
export function buildBoucleTools(identity: Identity): readonly ToolSpec[] {
  return [
    {
      type: "function",
      function: {
        name: "brain_search",
        description: `Search tickets, ticket history, meeting notes, and ${identity.demoMode ? "synthetic " : ""}brain project pages before creating or merging work.`,
        parameters: {
          type: "object",
          properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 20 } },
          required: ["query"],
          additionalProperties: false,
        },
      },
    },
  {
    type: "function",
    function: {
      name: "brain_graph_search",
      description:
        "GraphRAG search: hybrid-search seeds expanded over the brain's entity graph (projects, tickets, meetings, people). Returns the connected neighborhood with a via-path per node explaining how it was reached. Use when a question spans entities (who owns what, what a meeting decided about a project).",
      parameters: {
        type: "object",
        properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 25 } },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ticket_list",
      description: "List Boucle tickets ranked by score, optionally filtered by status, project, or needs.",
      parameters: {
        type: "object",
        properties: { status: enumValues(STATUSES), project: { type: "string" }, needs: enumValues(NEEDS) },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ticket_next",
      description: "Get the ranked actionable queue, globally or for one project.",
      parameters: {
        type: "object",
        properties: { project: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 100 } },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ticket_get",
      description: "Get one ticket and its resolution timeline.",
      parameters: {
        type: "object",
        properties: { ticketId: { type: "string" } },
        required: ["ticketId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ticket_set",
      description: "Update mutable fields on one ticket and recompute its score.",
      parameters: {
        type: "object",
        properties: {
          ticketId: { type: "string" },
          title: { type: "string" },
          body: { type: "string" },
          priority: enumValues(PRIORITIES),
          kind: enumValues(KINDS),
          bucket: { anyOf: [enumValues(BUCKETS), { type: "null" }] },
          project: { type: ["string", "null"] },
          needs: enumValues(NEEDS),
          effort: { anyOf: [enumValues(EFFORTS), { type: "null" }] },
          dueAt: { type: ["string", "null"] },
          nextAction: { type: ["string", "null"] },
        },
        required: ["ticketId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ticket_transition",
      description: "Move a ticket to a new lifecycle status and record why.",
      parameters: {
        type: "object",
        properties: {
          ticketId: { type: "string" },
          toStatus: enumValues(STATUSES),
          snoozedUntil: { type: ["string", "null"] },
          reason: { type: ["string", "null"] },
          workRef: { type: ["string", "null"] },
        },
        required: ["ticketId", "toStatus"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ticket_comment",
      description: "Add a note to a ticket's timeline without changing its fields.",
      parameters: {
        type: "object",
        properties: { ticketId: { type: "string" }, text: { type: "string" } },
        required: ["ticketId", "text"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "project_page_read",
      description: `Read the ${identity.demoMode ? "synthetic " : ""}brain page and timeline for a project slug.`,
      parameters: {
        type: "object",
        properties: { projectId: { type: "string" } },
        required: ["projectId"],
        additionalProperties: false,
      },
    },
  },
  ];
}

export const BOUCLE_BRAIN_TOOL_NAMES = new Set([
  "brain_search",
  "brain_graph_search",
  "ticket_list",
  "ticket_next",
  "ticket_get",
  "project_page_read",
]);

/** Strictly read-only tool declarations for the global brain conversation. */
export function buildBoucleBrainTools(identity: Identity): readonly ToolSpec[] {
  return buildBoucleTools(identity).filter((tool) => BOUCLE_BRAIN_TOOL_NAMES.has(tool.function.name));
}

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

/** The single implementation used by MCP registrations and provider relays. */
export async function executeBoucleTool(store: BoucleStore, name: string, args: ToolArgs): Promise<unknown> {
  switch (name) {
    case "brain_search":
      return store.search(requiredString(args, "query"), typeof args.limit === "number" ? args.limit : 20);
    case "brain_graph_search":
      return graphSearch(requiredString(args, "query"), typeof args.limit === "number" ? args.limit : undefined);
    case "ticket_list":
      return store.list(args as ListTicketsFilter);
    case "ticket_next":
      return store.next(typeof args.project === "string" ? args.project : null, typeof args.limit === "number" ? args.limit : 50);
    case "ticket_get": {
      const ticketId = requiredString(args, "ticketId");
      const ticket = store.getById(ticketId);
      return { ticket, events: ticket ? store.listEvents(ticketId) : [] };
    }
    case "ticket_set":
      validateProject(args.project);
      return store.setFields(args as unknown as SetTicketFieldsInput);
    case "ticket_transition":
      return store.transition(
        requiredString(args, "ticketId"),
        requiredString(args, "toStatus") as TicketStatus,
        typeof args.snoozedUntil === "string" ? args.snoozedUntil : null,
        typeof args.reason === "string" ? args.reason : null,
        typeof args.workRef === "string" ? args.workRef : null,
      );
    case "ticket_comment": {
      const ticketId = requiredString(args, "ticketId");
      if (!store.getById(ticketId)) throw new Error(`Ticket not found: ${ticketId}`);
      store.addEvent(ticketId, "note", requiredString(args, "text"));
      return { ok: true };
    }
    case "project_page_read": {
      const projectId = requiredString(args, "projectId");
      if (!isValidProjectId(projectId)) throw new Error("projectId must be a valid project slug");
      return getProjectPage(projectId);
    }
    default:
      throw new Error(`Unknown Boucle tool: ${name}`);
  }
}
