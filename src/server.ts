/**
 * boucle server — HTTP API over the ticket store + serves the web dashboard.
 *
 *   node src/server.ts   (or: pnpm serve)
 *
 * The web polls the API for live-ish updates; mutations are synchronous.
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";

import { BOUCLE_PORT, SPAWNED_CHAT_GUARDRAILS, resolveDbPath } from "./config.ts";
import {
  BoucleStore,
  type CreateLoopInput,
  type ListTicketsFilter,
  type SetTicketFieldsInput,
  type Ticket,
  type TicketBucket,
  type TicketKind,
  type TicketNeeds,
  type TicketStatus,
  type UpdateLoopInput,
} from "./store.ts";
import { LoopScheduler } from "./scheduler.ts";
import { createBoucleMcpServer, getMcpToken, mcpConfigToml } from "./mcp.ts";
import { fetchT3CodeEnvironmentId, getT3CodeConfig, spawnT3CodeChat } from "./t3code.ts";
import { createClickupTask, getClickupConfig } from "./clickup.ts";
import {
  addTimelineEntry,
  getBacklinks,
  getProjectPage,
  isValidProjectId,
  listProjects,
  writeProjectStatus,
  type ProjectStatus,
  type ProjectSummary,
} from "./projects.ts";
import { listMeetings, type Meeting } from "./meetings.ts";

const dbPath = resolveDbPath();
const store = new BoucleStore(dbPath);
const scheduler = new LoopScheduler(store, dbPath);
const app = new Hono();

app.get("/api/health", (c) => c.json({ ok: true }));

app.get("/api/tickets/open", (c) => c.json(store.listOpen()));

app.get("/api/projects", (c) => c.json(listProjects(store.listOpen(), store.listProjectMeta())));

// Recorded meetings — read-only view of the gbrain meetings/ notes. Recording itself
// stays native (menu bar); the dashboard only surfaces what the recorder + loop produce.
app.get("/api/meetings", (c) => c.json(listMeetings()));

// Status changes write into the gbrain page's frontmatter (the file is the source
// of truth); the sqlite overlay only backs ticket-only projects that have no page.
app.post("/api/projects/:id/status", async (c) => {
  const id = c.req.param("id");
  if (!isValidProjectId(id)) return c.json({ error: "invalid project id" }, 400);
  const body = (await c.req.json()) as { status: ProjectStatus | null };
  if (!body.status) return c.json({ error: "status required" }, 400);
  const result = writeProjectStatus(id, body.status);
  if (result === "no_page") {
    store.setProjectStatus(id, body.status);
  } else {
    // The file now answers for status — drop any stale override left by the old overlay.
    store.setProjectStatus(id, null);
  }
  return c.json({ ok: true, wroteBrain: result !== "no_page" });
});

/** A meeting belongs to a project via front-matter `related_projects` or a body wikilink. */
function meetingTouchesProject(meeting: Meeting, projectId: string): boolean {
  if (meeting.relatedProjects.some((p) => p === projectId || p === `projects/${projectId}`)) return true;
  return meeting.body.includes(`[[projects/${projectId}]]`) || meeting.body.includes(`[[projects/${projectId}|`);
}

// Heavy per-project payload — fetched when a project is selected, not polled.
app.get("/api/projects/:id/detail", async (c) => {
  const id = c.req.param("id");
  if (!isValidProjectId(id)) return c.json({ error: "invalid project id" }, 400);
  const page = getProjectPage(id);
  const backlinks = page ? await getBacklinks(id) : [];
  const meetings = listMeetings()
    .filter((m) => meetingTouchesProject(m, id))
    .slice(0, 12)
    .map(({ body: _body, ...light }) => light);
  const resolved = [...store.list({ project: id, status: "done" }), ...store.list({ project: id, status: "dropped" })]
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, 20);
  return c.json({ page, backlinks, meetings, resolvedTickets: resolved });
});

// Append a dated entry to the page's `## Timeline` (Boucle writes the brain).
app.post("/api/projects/:id/timeline", async (c) => {
  const id = c.req.param("id");
  if (!isValidProjectId(id)) return c.json({ error: "invalid project id" }, 400);
  const body = (await c.req.json()) as { text: string; date?: string };
  const text = (body.text ?? "").trim();
  if (!text) return c.json({ error: "text required" }, 400);
  if (body.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
    return c.json({ error: "date must be YYYY-MM-DD" }, 400);
  }
  const timeline = addTimelineEntry(id, text, body.date);
  if (timeline === null) return c.json({ error: "no gbrain page for this project" }, 404);
  return c.json({ timeline });
});

// "Brief me" — spawn a read-only t3code chat that gathers gbrain + ticket context
// for one project and reports where it stands.
app.post("/api/projects/:id/brief", async (c) => {
  const id = c.req.param("id");
  if (!isValidProjectId(id)) return c.json({ error: "invalid project id" }, 400);
  const cfg = getT3CodeConfig(store);
  if (cfg === null) {
    return c.json({ error: "t3code not configured. Set its URL + token in Settings." }, 400);
  }
  const project = listProjects(store.listOpen(), store.listProjectMeta()).find((p) => p.projectId === id);
  if (!project) return c.json({ error: "project not found" }, 404);
  try {
    const result = await spawnT3CodeChat(cfg, {
      defaultProject: store.getMeta("defaultProject") ?? "dataiku",
      title: `Brief: ${project.title}`,
      prompt: buildBriefPrompt(project),
    });
    return c.json(result);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 502);
  }
});

function buildBriefPrompt(p: ProjectSummary): string {
  const tickets = p.openTickets
    .map((t) => `- [${t.status}] ${t.title}${t.nextAction ? ` — next: ${t.nextAction}` : ""}`)
    .join("\n");
  return [
    `Brief Loris on the "${p.title}" project (gbrain slug: projects/${p.projectId}). He wants to walk into it cold and know exactly where it stands.`,
    "",
    "Do this, read-only:",
    `1. Read the gbrain page (\`gbrain get projects/${p.projectId}\`), its backlinks (\`gbrain backlinks projects/${p.projectId}\`), and any recent related meeting notes in the brain's meetings/ folder.`,
    "2. Cross-check the open Boucle tickets below against the page's State/Timeline.",
    "",
    "Open Boucle tickets:",
    tickets.length > 0 ? tickets : "- (none)",
    "",
    "Then reply with a tight brief: current state in two sentences, what moved in the last two weeks, open blockers/questions, and the 3 most valuable next actions (say which are already tracked as tickets). Do not create or modify tickets, and do not edit the brain in this chat.",
    "",
    SPAWNED_CHAT_GUARDRAILS,
  ].join("\n");
}

app.post("/api/projects/reorder", async (c) => {
  const body = (await c.req.json()) as { order: string[] };
  store.setProjectOrder(body.order ?? []);
  return c.json({ ok: true });
});


app.get("/api/tickets/next", (c) => {
  const project = c.req.query("project") ?? null;
  const limit = Number.parseInt(c.req.query("limit") ?? "50", 10);
  return c.json(store.next(project, limit));
});

app.get("/api/tickets", (c) => {
  const filter: ListTicketsFilter = {};
  const status = c.req.query("status");
  const project = c.req.query("project");
  const needs = c.req.query("needs");
  if (status) filter.status = status as TicketStatus;
  if (project) filter.project = project;
  if (needs) filter.needs = needs as TicketNeeds;
  return c.json(store.list(filter));
});

app.get("/api/tickets/:id", (c) => {
  const id = c.req.param("id");
  const ticket = store.getById(id);
  return c.json({
    ticket,
    events: ticket ? store.listEvents(ticket.ticketId) : [],
    enriching: scheduler.isEnriching(id),
  });
});

app.post("/api/tickets/upsert", async (c) => c.json(store.upsert(await c.req.json())));

app.post("/api/tickets/:id/transition", async (c) => {
  const body = (await c.req.json()) as {
    toStatus: TicketStatus;
    snoozedUntil?: string | null;
    reason?: string | null;
    workRef?: string | null;
  };
  return c.json(
    store.transition(
      c.req.param("id"),
      body.toStatus,
      body.snoozedUntil ?? null,
      body.reason ?? null,
      body.workRef ?? null,
    ),
  );
});

app.post("/api/tickets/:id/set", async (c) => {
  const body = (await c.req.json()) as Omit<SetTicketFieldsInput, "ticketId">;
  return c.json(store.setFields({ ...body, ticketId: c.req.param("id") }));
});

app.post("/api/reprioritize", (c) => c.json({ updated: store.reprioritize() }));

// "Ce qui avance" — resolved items per project per day, for the activity grid.
app.get("/api/activity", (c) => {
  const days = Number.parseInt(c.req.query("days") ?? "26", 10);
  return c.json(store.activity(Number.isNaN(days) ? 26 : Math.min(Math.max(days, 1), 366)));
});

// Global scheduler master switch (pauses every loop at once).
app.get("/api/loop-state", (c) => c.json({ enabled: store.getMeta("loopEnabled") === "1" }));
app.post("/api/loop-state", async (c) => {
  const body = (await c.req.json()) as { enabled: boolean };
  store.setMeta("loopEnabled", body.enabled ? "1" : "0");
  return c.json({ enabled: body.enabled });
});

// Loops — BOUCLE owns N scheduled codex runs.
const withRunState = (loop: ReturnType<typeof store.getLoop>) =>
  loop ? { ...loop, isRunning: scheduler.isRunning(loop.loopId) } : loop;

app.get("/api/loops", (c) => c.json(store.listLoops().map((l) => ({ ...l, isRunning: scheduler.isRunning(l.loopId) }))));

app.post("/api/loops", async (c) => {
  const body = (await c.req.json()) as CreateLoopInput;
  return c.json(withRunState(store.createLoop(body)));
});

app.get("/api/loops/:id", (c) => {
  const loop = store.getLoop(c.req.param("id"));
  if (!loop) return c.json({ error: "loop not found" }, 404);
  return c.json({ loop: withRunState(loop), runs: store.listRuns(loop.loopId) });
});

app.post("/api/loops/:id", async (c) => {
  const body = (await c.req.json()) as Omit<UpdateLoopInput, "loopId">;
  return c.json(withRunState(store.updateLoop({ ...body, loopId: c.req.param("id") })));
});

app.delete("/api/loops/:id", (c) => {
  store.deleteLoop(c.req.param("id"));
  return c.json({ ok: true });
});

app.post("/api/loops/:id/enabled", async (c) => {
  const body = (await c.req.json()) as { enabled: boolean };
  return c.json(withRunState(store.updateLoop({ loopId: c.req.param("id"), enabled: body.enabled })));
});

app.post("/api/loops/:id/run", (c) => {
  try {
    const run = scheduler.runNow(c.req.param("id"));
    if (run === null) return c.json({ error: "loop is already running" }, 409);
    return c.json(run);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 404);
  }
});

app.get("/api/loops/:id/runs", (c) => {
  const limit = Number.parseInt(c.req.query("limit") ?? "20", 10);
  return c.json(store.listRuns(c.req.param("id"), limit));
});

app.get("/api/settings", async (c) => {
  const cfg = getT3CodeConfig(store);
  const t3codeEnvId = cfg !== null ? await fetchT3CodeEnvironmentId(cfg) : "";
  return c.json({
    defaultProject: store.getMeta("defaultProject") ?? "dataiku",
    t3codeUrl: store.getMeta("t3codeUrl") ?? "",
    t3codeEnvId,
    t3codeConfigured: cfg !== null,
    clickupConfigured: getClickupConfig(store) !== null,
  });
});
app.post("/api/settings", async (c) => {
  const body = (await c.req.json()) as Partial<{
    defaultProject: string;
    t3codeUrl: string;
    t3codeToken: string;
    clickupToken: string;
  }>;
  if (body.defaultProject !== undefined) store.setMeta("defaultProject", body.defaultProject);
  if (body.t3codeUrl !== undefined) store.setMeta("t3codeUrl", body.t3codeUrl);
  if (body.t3codeToken !== undefined && body.t3codeToken.length > 0) {
    store.setMeta("t3codeToken", body.t3codeToken);
  }
  if (body.clickupToken !== undefined && body.clickupToken.length > 0) {
    store.setMeta("clickupToken", body.clickupToken);
  }
  return c.json({ ok: true });
});

app.post("/api/tickets/:id/spawn-chat", async (c) => {
  const ticket = store.getById(c.req.param("id"));
  if (!ticket) return c.json({ error: "ticket not found" }, 404);
  const cfg = getT3CodeConfig(store);
  if (cfg === null) {
    return c.json({ error: "t3code not configured. Set its URL + token in Settings." }, 400);
  }
  const prompt = buildPrompt(ticket);
  try {
    const result = await spawnT3CodeChat(cfg, {
      defaultProject: store.getMeta("defaultProject") ?? "dataiku",
      title: ticket.title,
      prompt,
    });
    store.setFields({ ticketId: ticket.ticketId, threadId: result.threadId });
    return c.json(result);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 502);
  }
});

// Manually create an item. For tasks/scopes we normally kick off a t3code chat that
// researches and writes the description; quick-capture passes chat:false for an
// instant, silent create (ideas especially).
app.post("/api/epics", async (c) => {
  const body = (await c.req.json()) as {
    title: string;
    project?: string | null;
    bucket?: TicketBucket | null;
    kind?: TicketKind;
    chat?: boolean;
    /** No project picked but the user wants Boucle to find one (⌘K "Auto"). */
    autoRoute?: boolean;
  };
  const title = (body.title ?? "").trim();
  if (!title) return c.json({ error: "title required" }, 400);
  const kind = body.kind ?? "task";
  const wantsChat = body.chat ?? (kind === "task" || kind === "scope");
  const ticket = store.upsert({
    dedupeKey: `manual:${randomUUID()}`,
    title,
    source: "manual",
    createdBy: "human",
    project: body.project ?? null,
    bucket: body.bucket ?? null,
    kind,
    needs: wantsChat ? "claude" : "none",
  });
  // The capture itself is always instant; routing happens behind it. A describe-chat
  // already researches + sets the project, so the micro-run only covers the chat-less path.
  if (!wantsChat && !ticket.project && body.autoRoute) {
    scheduler.smartCapture(randomUUID().slice(0, 8), buildRoutePrompt(ticket));
  }
  const cfg = getT3CodeConfig(store);
  if (!wantsChat || cfg === null) {
    return c.json({ ticket, openUrl: null, chat: false });
  }
  try {
    const result = await spawnT3CodeChat(cfg, {
      defaultProject: store.getMeta("defaultProject") ?? "dataiku",
      title: ticket.title,
      prompt: buildDescribePrompt(ticket),
    });
    const updated = store.setFields({ ticketId: ticket.ticketId, threadId: result.threadId });
    return c.json({ ticket: updated, openUrl: result.openUrl, chat: true });
  } catch (error) {
    // The EPIC exists even if the describe-chat could not spawn — surface both.
    return c.json({ ticket, openUrl: null, chat: false, error: error instanceof Error ? error.message : String(error) });
  }
});

/** Micro-run prompt: file one just-captured, project-less item into the right project. */
function buildRoutePrompt(t: Ticket): string {
  const projects = listProjects(store.listOpen(), store.listProjectMeta())
    .filter((p) => p.status === "in_progress" || p.status === "scoping" || p.openTicketCount > 0)
    .map((p) => `- ${p.projectId} — ${p.title}${p.summary ? ` — ${p.summary.slice(0, 120)}` : ""}`)
    .join("\n");
  return [
    "Loris quick-captured a single item in Boucle without picking a project. Give it a home.",
    "",
    `Item: ticketId ${t.ticketId} | kind ${t.kind} | title: ${t.title}`,
    "",
    "Known projects (slug — title — summary):",
    projects,
    "",
    "Do this:",
    "1. If the title clearly belongs to ONE project from the list, call ticket_set(ticketId, { project: <slug> }).",
    "   You may skim the local gbrain notes under /Users/loris.alexandre@dataiku.com/Documents/dataiku to disambiguate,",
    "   but do NOT open Slack/Gmail/Calendar/Drive/ClickUp.",
    "2. If it is genuinely cross-project or unclear, do nothing — leaving it in misc is correct.",
    "3. At most one ticket_set. Never create tickets, never change the title, never message anyone.",
  ].join("\n");
}

app.post("/api/tickets/:id/clickup", async (c) => {
  const ticket = store.getById(c.req.param("id"));
  if (!ticket) return c.json({ error: "ticket not found" }, 404);
  if (ticket.clickupTaskId) {
    return c.json({ error: "ticket already has a ClickUp task" }, 409);
  }
  const cfg = getClickupConfig(store);
  if (cfg === null) {
    return c.json({ error: "ClickUp not configured. Add the API key in Settings." }, 400);
  }
  try {
    const task = await createClickupTask(cfg, {
      title: ticket.title,
      body: ticket.body,
      nextAction: ticket.nextAction,
      project: ticket.project,
      requester: ticket.requester,
      permalink: ticket.permalink,
    });
    const updated = store.setFields({
      ticketId: ticket.ticketId,
      clickupTaskId: task.id,
      wantsClickup: false,
    });
    return c.json({ ticket: updated, url: task.url, listLabel: task.listLabel });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 502);
  }
});

// Smart capture — paste raw text (a Slack message, meeting notes…); a one-shot
// codex run splits it into typed items, routes them to projects, and merges with
// existing open tickets instead of duplicating. Async: poll GET /api/capture/smart.
app.post("/api/capture/smart", async (c) => {
  const body = (await c.req.json()) as { text: string; project?: string | null };
  const text = (body.text ?? "").trim();
  if (!text) return c.json({ error: "text required" }, 400);
  const batchId = randomUUID().slice(0, 8);
  const projects = listProjects(store.listOpen(), store.listProjectMeta())
    .filter((p) => p.status === "in_progress" || p.status === "scoping" || p.openTicketCount > 0)
    .map((p) => `- ${p.projectId} — ${p.title}`)
    .join("\n");
  scheduler.smartCapture(batchId, buildSmartCapturePrompt(text, body.project ?? null, projects, batchId));
  return c.json({ ok: true, batchId }, 202);
});

app.get("/api/capture/smart", (c) => c.json(scheduler.listSmartRuns()));

function buildSmartCapturePrompt(text: string, preset: string | null, projects: string, batchId: string): string {
  return [
    "Loris pasted raw text into Boucle's quick-capture (usually a Slack message or meeting notes).",
    "Parse it into Boucle items using the boucle MCP tools. Work from the text itself; only open a",
    "connector if a reference in the text truly needs disambiguation. Do not message anyone.",
    "",
    "Pasted text:",
    '"""',
    text,
    '"""',
    "",
    preset ? `Preset project (default when an item has no clearer home): ${preset}` : "No preset project.",
    "",
    "Known projects (slug — title):",
    projects,
    "",
    "Do this:",
    "1. FIRST call ticket_list for open tickets — the chief loop may already track some of these asks.",
    "   When an existing open ticket covers an item, ticket_set that ticket to enrich it (fill missing",
    "   body/nextAction/dueAt/project/kind, append new links to body) — do NOT create a duplicate.",
    `2. For genuinely new items: ticket_upsert with dedupeKey "paste:${batchId}:<n>", source "manual",`,
    "   createdBy 'human'. Short imperative title. kind: task = actionable; idea = to remember, not yet",
    "   actionable; conv = pointer to a conversation; scope = a larger design to break down. Route to a",
    "   project slug from the list when obvious (else the preset, else null). Set bucket by urgency,",
    "   dueAt when the text states a deadline, one concrete nextAction, requester when obvious, and put",
    "   the relevant excerpt + links in body.",
    "3. Precision over recall: at most ~10 items; skip pure-FYI noise.",
    "4. Call reprioritize once at the end.",
  ].join("\n");
}

app.post("/api/tickets/:id/enrich", async (c) => {
  const ticket = store.getById(c.req.param("id"));
  if (!ticket) return c.json({ error: "ticket not found" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { note?: string };
  const note = (body.note ?? "").trim();
  const started = scheduler.enrichTicket(ticket.ticketId, buildEnrichPrompt(ticket, note));
  if (!started) return c.json({ error: "a codex re-run is already in progress for this ticket" }, 409);
  return c.json({ ok: true }, 202);
});

/** Prompt for a one-shot codex run that re-investigates a ticket with a human correction note. */
function buildEnrichPrompt(t: Ticket, note: string): string {
  const lines = [
    "Loris reviewed this captured ticket in Boucle and added a correction/context note.",
    "Re-investigate it, then update the SAME ticket in place — never create a duplicate.",
    "",
    "Ticket:",
    `- ticketId: ${t.ticketId}  (use this for ticket_get / ticket_set)`,
    `- title: ${t.title}`,
    `- status: ${t.status} | priority: ${t.priority} | needs: ${t.needs}`,
    `- project: ${t.project ?? "—"}`,
    `- requester: ${t.requester ?? "—"}`,
    `- source: ${t.source}${t.permalink ? ` — ${t.permalink}` : ""}`,
  ];
  if (t.nextAction) lines.push(`- nextAction: ${t.nextAction}`);
  if (t.body.trim().length > 0) lines.push("", "Current body:", t.body.trim());
  lines.push(
    "",
    "Loris's note (authoritative — apply the corrections it states):",
    note.length > 0 ? note : "(no note — just dig for more context)",
    "",
    "Do this:",
    "1. Take the note as ground truth: fix the project slug, who people actually are, the real ask, etc.",
    "2. Search the connectors (Slack, Gmail, Calendar, Drive/Docs, ClickUp) and the local gbrain in " +
      "/Users/loris.alexandre@dataiku.com/Documents/dataiku for context that completes the picture: the real ask, " +
      "who's involved, the blocker, the deadline, the right project, and one concrete next action.",
    "3. Call ticket_get(ticketId) for the latest, then ticket_set(ticketId, …) to correct " +
      "title/body/project/requester/needs/priority/nextAction. Use ticket_upsert only if the dedupeKey/source identity must change.",
    "4. Always feed the gbrain. Treat every correction here as a durable signal: whenever the note or your " +
      "findings surface a project, an identity (who someone really is, aliases), ownership, a decision, a blocker, " +
      "or a relationship that outlives this ticket, write it into the relevant gbrain note under " +
      "/Users/loris.alexandre@dataiku.com/Documents/dataiku (create the note if none fits) and reindex the brain. " +
      "When in doubt, capture it — bias toward persisting. If you spot adjacent gbrain notes worth updating or " +
      "creating beyond this ticket, do so and say which.",
    "5. Stay idempotent: update this ticketId, never spawn a second ticket for the same thing.",
    "6. Call reprioritize when done. Do not message anyone.",
  );
  return lines.join("\n");
}

/** First-turn prompt for a manually-created task: research it, then write its description in place. */
function buildDescribePrompt(t: Ticket): string {
  const lines = [
    `Loris just created a new task in Boucle and wants you to research it and write its description.`,
    "",
    "Task:",
    `- ticketId: ${t.ticketId}  (use this for ticket_get / ticket_set)`,
    `- title: ${t.title}`,
    `- project: ${t.project ?? "— (figure out the right gbrain project slug if you can)"}`,
    "",
    "Do this:",
    "1. Gather context from the connectors (Slack, Gmail, Calendar, Drive/Docs, ClickUp) and the local gbrain " +
      "in /Users/loris.alexandre@dataiku.com/Documents/dataiku to understand what this EPIC really is: the goal, " +
      "who's involved, current state, blockers, the right project, and a concrete next action.",
    "2. Call ticket_get(ticketId) for the latest, then ticket_set(ticketId, …) to fill in a clear `body` " +
      "(the description), `nextAction`, `project` (gbrain slug), and a `bucket` " +
      "(urgent / to_do_next / cool_to_do / maybe_one_day) reflecting how pressing it is.",
    "3. Feed durable findings back into the relevant gbrain notes and reindex the brain.",
    "4. Stay idempotent: update THIS ticketId, never create a second ticket. Do not message anyone.",
    "",
    SPAWNED_CHAT_GUARDRAILS,
  ];
  return lines.join("\n");
}

function buildPrompt(t: Ticket): string {
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

// MCP — BOUCLE's tools for Codex/Claude over HTTP (bearer-gated, one server per request).
app.all("/mcp", async (c) => {
  const token = getMcpToken(store);
  if (c.req.header("authorization") !== `Bearer ${token}`) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const mcp = createBoucleMcpServer(store);
  const transport = new StreamableHTTPTransport();
  await mcp.connect(transport);
  return transport.handleRequest(c);
});

const CLI_PATH = fileURLToPath(new URL("./cli.ts", import.meta.url));
app.get("/api/mcp-info", (c) => {
  const token = getMcpToken(store);
  const url = `http://127.0.0.1:${BOUCLE_PORT}/mcp`;
  return c.json({ url, token, configToml: mcpConfigToml({ url, token, cliPath: CLI_PATH, dbPath }) });
});

// Static web (built by Vite into ./web/dist), with SPA fallback.
app.use("/assets/*", serveStatic({ root: "./web/dist" }));
app.get("/", serveStatic({ path: "./web/dist/index.html" }));
app.get("*", serveStatic({ path: "./web/dist/index.html" }));

serve({ fetch: app.fetch, port: BOUCLE_PORT }, (info) => {
  scheduler.start();
  process.stdout.write(`boucle server on http://localhost:${info.port}\n`);
});
