#!/usr/bin/env node
/**
 * boucle CLI — the loop and scripts shell out to this to capture/rank tickets.
 *
 *   boucle ticket upsert --dedupe-key <k> --title <t> --source <s> [flags]
 *   boucle ticket list|get|transition|set ...
 *   boucle next [--project <p>] [--limit N] [--json]
 *   boucle source-seen <dedupeKey>
 *   boucle reprioritize
 *
 * DB: --db <path> | $BOUCLE_DB | ~/.boucle/boucle.db
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

import {
  BoucleStore,
  type SetTicketFieldsInput,
  type TicketEffort,
  type TicketNeeds,
  type TicketPriority,
  type TicketSource,
  type TicketStatus,
  type UpsertTicketInput,
  type Ticket,
} from "./store.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    db: { type: "string" },
    json: { type: "boolean", default: false },
    "dedupe-key": { type: "string" },
    title: { type: "string" },
    source: { type: "string" },
    body: { type: "string" },
    priority: { type: "string" },
    project: { type: "string" },
    "source-ref": { type: "string" },
    permalink: { type: "string" },
    requester: { type: "string" },
    needs: { type: "string" },
    effort: { type: "string" },
    "due-at": { type: "string" },
    "next-action": { type: "string" },
    "thread-id": { type: "string" },
    status: { type: "string" },
    to: { type: "string" },
    "snooze-until": { type: "string" },
    limit: { type: "string" },
  },
});

function resolveDbPath(): string {
  const explicit = (values.db as string | undefined) ?? process.env.BOUCLE_DB;
  const path = explicit && explicit.trim() ? explicit.trim() : join(homedir(), ".boucle", "boucle.db");
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

function fail(message: string): never {
  process.stderr.write(`boucle: ${message}\n`);
  process.exit(1);
}

function out(json: boolean, value: unknown, human: string): void {
  process.stdout.write((json ? JSON.stringify(value, null, 2) : human) + "\n");
}

function ticketLine(t: Ticket): string {
  const project = t.project ? ` (${t.project})` : "";
  const next = t.nextAction ? ` — next: ${t.nextAction}` : "";
  return `${t.priority.toUpperCase().padEnd(6)} ${t.score.toFixed(1).padStart(7)}  [${t.status}/${t.needs}] ${t.title}${project}${next}  {${t.ticketId}}`;
}

function ticketList(tickets: Ticket[]): string {
  return tickets.length === 0 ? "(no tickets)" : tickets.map(ticketLine).join("\n");
}

const json = values.json as boolean;
const dbPath = resolveDbPath();
const store = new BoucleStore(dbPath);
const [group, action] = positionals;

function req(name: string, value: string | undefined): string {
  if (value === undefined || value.trim() === "") fail(`missing required --${name}`);
  return value;
}

if (group === "ticket" && action === "upsert") {
  const input: UpsertTicketInput = {
    dedupeKey: req("dedupe-key", values["dedupe-key"] as string | undefined),
    title: req("title", values.title as string | undefined),
    source: req("source", values.source as string | undefined) as TicketSource,
  };
  if (values.body !== undefined) input.body = values.body as string;
  if (values.priority !== undefined) input.priority = values.priority as TicketPriority;
  if (values.project !== undefined) input.project = values.project as string;
  if (values["source-ref"] !== undefined) input.sourceRef = values["source-ref"] as string;
  if (values.permalink !== undefined) input.permalink = values.permalink as string;
  if (values.requester !== undefined) input.requester = values.requester as string;
  if (values.needs !== undefined) input.needs = values.needs as TicketNeeds;
  if (values.effort !== undefined) input.effort = values.effort as TicketEffort;
  if (values["due-at"] !== undefined) input.dueAt = values["due-at"] as string;
  if (values["next-action"] !== undefined) input.nextAction = values["next-action"] as string;
  if (values["thread-id"] !== undefined) input.threadId = values["thread-id"] as string;
  const ticket = store.upsert(input);
  out(json, ticket, `Upserted ${ticketLine(ticket)}`);
} else if (group === "ticket" && action === "list") {
  const tickets = store.list({
    ...(values.status !== undefined ? { status: values.status as TicketStatus } : {}),
    ...(values.project !== undefined ? { project: values.project as string } : {}),
    ...(values.needs !== undefined ? { needs: values.needs as TicketNeeds } : {}),
  });
  out(json, tickets, ticketList(tickets));
} else if (group === "ticket" && action === "get") {
  const ticketId = req("ticket-id", positionals[2]);
  const ticket = store.getById(ticketId);
  if (!ticket) out(json, null, `No ticket ${ticketId}.`);
  else out(json, { ...ticket, events: store.listEvents(ticketId) }, ticketLine(ticket));
} else if (group === "ticket" && action === "transition") {
  const ticketId = req("ticket-id", positionals[2]);
  const toStatus = req("to", values.to as string | undefined) as TicketStatus;
  const ticket = store.transition(ticketId, toStatus, values["snooze-until"] as string | undefined);
  out(json, ticket, `Updated ${ticketLine(ticket)}`);
} else if (group === "ticket" && action === "set") {
  const ticketId = req("ticket-id", positionals[2]);
  const input: SetTicketFieldsInput = { ticketId };
  if (values.priority !== undefined) input.priority = values.priority as TicketPriority;
  if (values.project !== undefined) input.project = values.project as string;
  if (values.needs !== undefined) input.needs = values.needs as TicketNeeds;
  if (values.effort !== undefined) input.effort = values.effort as TicketEffort;
  if (values["due-at"] !== undefined) input.dueAt = values["due-at"] as string;
  if (values["next-action"] !== undefined) input.nextAction = values["next-action"] as string;
  if (values["thread-id"] !== undefined) input.threadId = values["thread-id"] as string;
  const ticket = store.setFields(input);
  out(json, ticket, `Updated ${ticketLine(ticket)}`);
} else if (group === "next") {
  const limit = values.limit !== undefined ? Number.parseInt(values.limit as string, 10) : 50;
  const tickets = store.next((values.project as string | undefined) ?? null, limit);
  out(json, tickets, ticketList(tickets));
} else if (group === "source-seen") {
  const dedupeKey = req("dedupe-key", positionals[1]);
  const event = store.getSourceEvent(dedupeKey);
  out(true, event ? { seen: true, ...event } : { seen: false }, "");
} else if (group === "reprioritize") {
  const updated = store.reprioritize();
  out(json, { updated }, `Reprioritized ${updated} ticket(s).`);
} else if (group === "mcp") {
  // Serve BOUCLE's tools over stdio (for codex/claude `mcp_servers` command/args).
  const { createBoucleMcpServer } = await import("./mcp.ts");
  const { BrainSearch } = await import("./search.ts");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const search = new BrainSearch(dbPath, store);
  const { initBrainGraph } = await import("./graph.ts");
  initBrainGraph(store, search);
  await search.bootstrap();
  const server = createBoucleMcpServer(store);
  await server.connect(new StdioServerTransport());
  // Stays alive on stdin until the client disconnects.
} else if (group === "mcp-config") {
  const { getMcpToken, mcpConfigToml } = await import("./mcp.ts");
  const { fileURLToPath } = await import("node:url");
  const port = process.env.BOUCLE_PORT ?? "4419";
  const url = `http://127.0.0.1:${port}/mcp`;
  out(false, null, mcpConfigToml({
    url,
    token: getMcpToken(store),
    cliPath: fileURLToPath(import.meta.url),
    dbPath: resolveDbPath(),
  }));
} else {
  fail(
    "usage: boucle <ticket upsert|list|get|transition|set | next | source-seen | reprioritize | mcp | mcp-config> [flags]",
  );
}
