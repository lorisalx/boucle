/**
 * Boucle ticket store — standalone, node:sqlite, zero native deps.
 *
 * Standalone TicketStore: deterministic scoring (the loop
 * assigns priority/effort; we derive a stable rank), dedupe-keyed upsert,
 * lifecycle transitions, a resolution timeline (ticket_events), and a tiny
 * key/value settings table.
 */
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

export type TicketStatus =
  | "inbox"
  | "triaged"
  | "next"
  | "snoozed"
  | "blocked"
  | "in_progress"
  | "done"
  | "dropped";
export type TicketPriority = "urgent" | "high" | "normal" | "low";
/** Human-picked triage bucket for an EPIC — the on-screen control that replaces priority. */
export type TicketBucket = "urgent" | "to_do_next" | "cool_to_do" | "maybe_one_day";
/**
 * What an item IS — Boucle holds a brain, not just a todo list. task = actionable;
 * idea = something to not forget (not yet actionable); conv = pointer to an agent
 * conversation; scope = a larger design/scope to break down later.
 */
export type TicketKind = "task" | "idea" | "conv" | "scope";
export type TicketNeeds = "claude" | "codex" | "human" | "none";
export type TicketEffort = "xs" | "s" | "m" | "l" | "xl";
export type TicketSource = "slack" | "gmail" | "gcal" | "manual";
export type TicketCreatedBy = "chief" | "human";
export type TicketSourceDecision = "ticketed" | "ignored" | "merged";
export type TicketEventKind =
  | "created"
  | "status"
  | "priority"
  | "project"
  | "needs"
  | "chat"
  | "note"
  | "field";

export const OPEN_STATUSES: ReadonlySet<TicketStatus> = new Set([
  "inbox",
  "triaged",
  "next",
  "snoozed",
  "blocked",
  "in_progress",
]);
const NEXT_STATUSES: ReadonlySet<TicketStatus> = new Set([
  "inbox",
  "triaged",
  "next",
  "in_progress",
]);

export interface Ticket {
  ticketId: string;
  title: string;
  body: string;
  status: TicketStatus;
  priority: TicketPriority;
  kind: TicketKind;
  /** null until triaged; new EPICs default from priority (see bucketFromPriority). */
  bucket: TicketBucket | null;
  score: number;
  project: string | null;
  source: TicketSource;
  sourceRef: string | null;
  permalink: string | null;
  requester: string | null;
  needs: TicketNeeds;
  effort: TicketEffort | null;
  dueAt: string | null;
  snoozedUntil: string | null;
  nextAction: string | null;
  threadId: string | null;
  /** A pointer to the work that resolved this — e.g. a resumable agent session or PR URL. */
  workRef: string | null;
  dedupeKey: string;
  createdAt: string;
  updatedAt: string;
  createdBy: TicketCreatedBy;
}

export interface TicketEvent {
  eventId: string;
  ticketId: string;
  kind: TicketEventKind;
  summary: string;
  at: string;
}

export interface TicketSourceEvent {
  source: TicketSource;
  sourceRef: string;
  dedupeKey: string;
  ticketId: string | null;
  decision: TicketSourceDecision;
  seenAt: string;
}

export interface UpsertTicketInput {
  dedupeKey: string;
  title: string;
  source: TicketSource;
  body?: string;
  priority?: TicketPriority;
  kind?: TicketKind;
  bucket?: TicketBucket | null;
  project?: string | null;
  sourceRef?: string | null;
  permalink?: string | null;
  requester?: string | null;
  needs?: TicketNeeds;
  effort?: TicketEffort | null;
  dueAt?: string | null;
  nextAction?: string | null;
  threadId?: string | null;
  createdBy?: TicketCreatedBy;
}

export interface SetTicketFieldsInput {
  ticketId: string;
  title?: string;
  body?: string;
  priority?: TicketPriority;
  kind?: TicketKind;
  bucket?: TicketBucket | null;
  project?: string | null;
  needs?: TicketNeeds;
  effort?: TicketEffort | null;
  dueAt?: string | null;
  nextAction?: string | null;
  threadId?: string | null;
  workRef?: string | null;
}

export interface ListTicketsFilter {
  status?: TicketStatus;
  project?: string;
  needs?: TicketNeeds;
}

/** Initial bucket for a fresh/back-filled EPIC, derived from its priority. */
export function bucketFromPriority(priority: TicketPriority): TicketBucket {
  switch (priority) {
    case "urgent":
      return "urgent";
    case "high":
      return "to_do_next";
    case "normal":
      return "cool_to_do";
    case "low":
      return "maybe_one_day";
  }
}

// ===============================
// Project overlay — editable status + order layered over the read-only gbrain files
// ===============================

export interface ProjectMeta {
  statusOverride: string | null;
  sortOrder: number | null;
}

// ===============================
// Loops — scheduled Vibe runs that BOUCLE owns
// ===============================

export type LoopRunStatus = "running" | "ok" | "error" | "timeout";
export type LoopRunTrigger = "schedule" | "manual" | "smart_capture" | "enrich";

export interface Loop {
  loopId: string;
  name: string;
  description: string;
  /** The full instructions handed to Vibe CLI as the prompt. */
  prompt: string;
  enabled: boolean;
  /** Minimum minutes between runs. */
  intervalMinutes: number;
  /** CSV of weekday short names (e.g. "Mon,Tue,Wed,Thu,Fri"); empty = every day. */
  activeDays: string;
  /** Active window hours [start, end). When start === end the loop runs all day. */
  activeStartHour: number;
  activeEndHour: number;
  /** IANA timezone the active window is evaluated in. */
  timezone: string;
  /** CODEX_HOME for the spawned process; null inherits the server's env. */
  codexHome: string | null;
  /** `codex --profile <profile>`; null omits the flag. */
  profile: string | null;
  /** `codex -m <model>`; null uses the profile default. */
  model: string | null;
  /** Persistent Vibe session used for this loop's scheduled/manual runs. */
  threadId: string | null;
  threadProject: string | null;
  threadOpenUrl: string | null;
  lastRunAt: string | null;
  lastStatus: LoopRunStatus | null;
  createdAt: string;
  updatedAt: string;
}

export interface LoopRun {
  runId: string;
  loopId: string;
  startedAt: string;
  finishedAt: string | null;
  status: LoopRunStatus;
  exitCode: number | null;
  summary: string;
  trigger: LoopRunTrigger;
  costUsd: number | null;
  sessionId: string | null;
}

export interface LoopCostSummary {
  totalCostUsd: number;
  warning: string | null;
  blocked: boolean;
}

export interface CreateLoopInput {
  name: string;
  prompt: string;
  description?: string;
  enabled?: boolean;
  intervalMinutes?: number;
  activeDays?: string;
  activeStartHour?: number;
  activeEndHour?: number;
  timezone?: string;
  codexHome?: string | null;
  profile?: string | null;
  model?: string | null;
}

export interface UpdateLoopInput {
  loopId: string;
  name?: string;
  prompt?: string;
  description?: string;
  enabled?: boolean;
  intervalMinutes?: number;
  activeDays?: string;
  activeStartHour?: number;
  activeEndHour?: number;
  timezone?: string;
  codexHome?: string | null;
  profile?: string | null;
  model?: string | null;
  threadId?: string | null;
  threadProject?: string | null;
  threadOpenUrl?: string | null;
}

const PRIORITY_WEIGHT: Record<TicketPriority, number> = { urgent: 1000, high: 100, normal: 10, low: 1 };
const EFFORT_PENALTY: Record<TicketEffort, number> = { xs: 0, s: 0.5, m: 1, l: 2, xl: 3 };
const DAY_MS = 86_400_000;

function computeScore(
  t: Pick<Ticket, "priority" | "dueAt" | "effort" | "updatedAt">,
  nowMs: number,
): number {
  let score = PRIORITY_WEIGHT[t.priority];
  if (t.dueAt !== null) {
    const dueMs = Date.parse(t.dueAt);
    if (!Number.isNaN(dueMs)) {
      const days = (dueMs - nowMs) / DAY_MS;
      score += days <= 0 ? 50 : days < 1 ? 30 : days < 3 ? 15 : days < 7 ? 5 : 0;
    }
  }
  const updatedMs = Date.parse(t.updatedAt);
  if (!Number.isNaN(updatedMs)) {
    score += Math.min(Math.max(0, (nowMs - updatedMs) / DAY_MS) * 0.5, 20);
  }
  if (t.effort !== null) score -= EFFORT_PENALTY[t.effort];
  return score;
}

const TICKET_COLUMNS = `
  ticket_id AS ticketId, title, body, status, priority, kind, bucket, score, project, source,
  source_ref AS sourceRef, permalink, requester, needs, effort,
  due_at AS dueAt, snoozed_until AS snoozedUntil, next_action AS nextAction,
  thread_id AS threadId,
  work_ref AS workRef,
  dedupe_key AS dedupeKey, created_at AS createdAt, updated_at AS updatedAt, created_by AS createdBy
`;

type RawTicket = Ticket;

function toTicket(row: RawTicket): Ticket {
  return row;
}

const LOOP_COLUMNS = `
  loop_id AS loopId, name, description, prompt, enabled,
  interval_minutes AS intervalMinutes, active_days AS activeDays,
  active_start_hour AS activeStartHour, active_end_hour AS activeEndHour,
  timezone, codex_home AS codexHome, profile, model,
  thread_id AS threadId, thread_project AS threadProject, thread_open_url AS threadOpenUrl,
  last_run_at AS lastRunAt, last_status AS lastStatus,
  created_at AS createdAt, updated_at AS updatedAt
`;

type RawLoop = Omit<Loop, "enabled"> & { enabled: number };

function toLoop(row: RawLoop): Loop {
  return { ...row, enabled: row.enabled === 1 };
}

/** Default chief-of-staff heartbeat loop, seeded on first boot. */
export const DEFAULT_CHIEF_PROMPT = `Act as a lightweight chief of staff for Nora Bellier, Brumeline's Head of Product. Use only the
synthetic material in fake-brain/ plus Boucle's MCP tools. Keep project knowledge current and prioritize
pending asks, blockers, decisions, launch changes, access issues, and review requests. Review recent local
activity broadly: project notes, meeting notes, ticket history, Nora's own replies, and ordinary team updates.
Do not treat triage as only a keyword-search problem; read the relevant context directly. Pay particular
attention to work involving Camille Dervaux, Émile Rousset, Inès Marceau, Théo Valmont, Maëlle Courtois,
and Bastien Leroux. An ask directed at Nora counts whether or not her name is stated explicitly. Record
durable signals on the relevant fake-brain project pages. Stay quiet if nothing meaningful changed. Outside
Monday-Friday 08:00-18:00 Europe/Paris, return DONT_NOTIFY unless the current thread already contains an
urgent issue.

Nora owns product delivery across Brumeline's customer-operations platform: Renewal Signal, Partner Portal,
Onboarding Copilot, Hélium Migration, Permissions Core, and Usage Observatory. Other people's
action items are not Nora's tickets, even when they appear in a meeting she attended.

Work the queue via the MCP tools (never send an outbound message):
- Self-clean first. Review open tickets with ticket_list / ticket_next and re-check the matching project,
  meeting, and ticket history. Use ticket_transition to mark work done or dropped when it was handled, became
  obsolete, or belongs to another teammate. Always pass a one-line \`reason\`, and set \`workRef\` when a
  local project artifact records the resolution. Read before closing; when unsure, leave it open.
- Create tickets only for action items Nora herself must do. Skip other teammates' commitments, FYIs, and
  announcements. Use ticket_upsert with an idempotent synthetic dedupeKey. Give each ticket a short imperative
  title, appropriate priority, matching fake-brain project slug, needs, requester slug, and one concrete next
  action. Meeting and project signals may update the fake brain without becoming tickets.
- Use source_seen to skip already-classified signals and mark_source_seen to record decisions.
- For actionable tickets with needs=codex or needs=claude and no linked thread, call spawn_chat once. Let
  spawn_chat set the thread link; never write threadId by hand.
- Call reprioritize once at the end. Keep it to about 12 tickets per run; prefer precision over recall.`;

export const DEFAULT_MEETINGS_PROMPT = `Process freshly recorded synthetic meeting transcripts for Nora Bellier. The recorder drops raw markdown
files in fake-brain/meetings/ with YAML frontmatter containing \`processed: false\`. Turn each unprocessed
transcript into a clean meeting note and create Boucle tickets for Nora's own action items.

Do exactly this each run:
1. List fake-brain/meetings/*.md and open only files whose frontmatter has \`processed: false\`. If none exist,
   return DONT_NOTIFY without touching curated notes.
2. Read each selected transcript in full. Remote recordings use \`**Me:**\` for Nora and \`**Them:**\` for
   everyone else. Single-track recordings may have no speaker labels; use attendees_raw and context without
   inventing attribution.
3. Rewrite the file in place in the existing house style. Preserve the YAML frontmatter, resolve attendees to
   fictional \`people/<slug>\` values, keep title and call_link, add tags and related_projects, and set
   \`processed: true\`. Add a title, summary blockquote, Key points, Decisions, Action items with owners, and
   Connections with people/project wikilinks. Preserve the raw transcript under a collapsed Transcript section.
4. Create a ticket only for action items Nora committed to. Use ticket_upsert with dedupeKey
   "meeting:<filename>:<n>", a short imperative title, priority from urgency, the matching project slug,
   suitable needs, requester, and one concrete next action. Use source "manual". Do not invent tasks.
5. Update the relevant fake-brain project pages with durable meeting signals, then trigger the local reindex shim.
6. Call reprioritize once. Summarize which meetings were processed and how many tickets were created, or return
   DONT_NOTIFY when there was nothing to process.`;

export const DEFAULT_TIMELINE_SCRIBE_PROMPT = `Keep fake-brain project timelines current from Boucle ticket activity so the Projects page reflects what
the Brumeline team actually shipped.

Do exactly this each run:
1. Call ticket_list with status "done", then status "dropped". Keep only tickets updated in the last 24 hours
   that have a project slug. If none qualify, return DONT_NOTIFY.
2. Open fake-brain/projects/<slug>.md for each affected project and read its "## Timeline" section. For each
   meaningful completion — something shipped, decided, fixed, or unblocked — append one entry in the format
   \`- **YYYY-MM-DD** | <past-tense one-liner>\`. Skip dropped noise, snooze churn, and trivia. Include workRef
   when useful and combine related same-day completions naturally.
3. Before writing, check the full page for the event. Append only, never rewrite or delete existing entries,
   keep oldest-first order, and create "## Timeline" only when missing.
4. After any edit, run scripts/gbrain-noop import fake-brain. It is intentionally a local no-op for this demo.
5. Summarize which pages changed, or return DONT_NOTIFY if none did.`;

interface SeedTicket extends UpsertTicketInput {
  status: TicketStatus;
  snoozeDays?: number;
  workRef?: string;
}

const DEFAULT_TICKETS: SeedTicket[] = [
  {
    dedupeKey: "seed:renewal-signal:thresholds",
    title: "Validate the renewal alert thresholds",
    body: "Maëlle is waiting for the final matrix before launching the pilot across at-risk accounts.",
    status: "next",
    priority: "urgent",
    bucket: "urgent",
    project: "renewal-signal",
    source: "manual",
    requester: "people/maelle-courtois",
    needs: "human",
    effort: "s",
    nextAction: "Review the three proposed thresholds and record the decision on the project page.",
  },
  {
    dedupeKey: "seed:renewal-signal:email-copy",
    title: "Review the alert email copy",
    body: "The tone should remain factual and offer the account manager a next action.",
    status: "triaged",
    priority: "normal",
    bucket: "cool_to_do",
    project: "renewal-signal",
    source: "gmail",
    requester: "people/ines-marceau",
    needs: "human",
    effort: "xs",
    nextAction: "Comment on the English version prepared by Inès.",
  },
  {
    dedupeKey: "seed:partner-portal:beta-scope",
    title: "Finalize the partner beta scope",
    body: "The beta must cover file sharing without including delegated billing.",
    status: "in_progress",
    priority: "high",
    bucket: "to_do_next",
    project: "partner-portal",
    source: "gcal",
    requester: "people/theo-valmont",
    needs: "human",
    effort: "m",
    nextAction: "Draft the beta entry and exit criteria.",
  },
  {
    dedupeKey: "seed:partner-portal:mockup",
    title: "Annotate the file-sharing mockup",
    body: "Two empty states and the expired-link case still need decisions.",
    status: "inbox",
    priority: "normal",
    bucket: "cool_to_do",
    project: "partner-portal",
    source: "manual",
    requester: "people/ines-marceau",
    needs: "human",
    effort: "s",
    nextAction: "Add product comments to the three affected screens.",
  },
  {
    dedupeKey: "seed:onboarding-copilot:suggestions",
    title: "Test copilot suggestions across five journeys",
    body: "The test set covers a simple start, two imports, and two multi-team accounts.",
    status: "next",
    priority: "high",
    bucket: "to_do_next",
    project: "onboarding-copilot",
    source: "manual",
    requester: "people/emile-rousset",
    needs: "claude",
    effort: "m",
    nextAction: "Run the protocol and classify unhelpful or ambiguous suggestions.",
  },
  {
    dedupeKey: "seed:onboarding-copilot:consent",
    title: "Decide the copilot consent copy",
    body: "The wording must explain which configuration data is analyzed.",
    status: "blocked",
    priority: "high",
    bucket: "to_do_next",
    project: "onboarding-copilot",
    source: "gmail",
    requester: "people/camille-dervaux",
    needs: "human",
    effort: "s",
    nextAction: "Wait for external counsel's review, then choose the final version.",
  },
  {
    dedupeKey: "seed:helium-migration:wave-two",
    title: "Prepare the second Hélium wave list",
    body: "Twelve customer workspaces are eligible after the first wave completed without a major incident.",
    status: "triaged",
    priority: "high",
    bucket: "to_do_next",
    project: "helium-migration",
    source: "manual",
    requester: "people/bastien-leroux",
    needs: "human",
    effort: "s",
    nextAction: "Validate the exclusions with Maëlle before publishing the list.",
  },
  {
    dedupeKey: "seed:helium-migration:rollback",
    title: "Document the Hélium rollback signal",
    body: "The technical runbook exists; it is missing the product criterion that triggers a rollback.",
    status: "done",
    priority: "normal",
    bucket: "cool_to_do",
    project: "helium-migration",
    source: "manual",
    requester: "people/emile-rousset",
    needs: "human",
    effort: "xs",
    nextAction: "Add the failure threshold to the runbook.",
    workRef: "https://brumeline.example/runbooks/helium-rollback",
  },
  {
    dedupeKey: "seed:permissions-core:matrix",
    title: "Decide the Manager role permissions",
    body: "Data export and user invitations remain the two disputed permissions.",
    status: "in_progress",
    priority: "urgent",
    bucket: "urgent",
    project: "permissions-core",
    source: "gcal",
    requester: "people/camille-dervaux",
    needs: "human",
    effort: "m",
    nextAction: "Choose the minimum matrix before the security review.",
  },
  {
    dedupeKey: "seed:permissions-core:audit",
    title: "Add revocation events to the audit log",
    body: "The prototype logs grants but not yet revocations.",
    status: "blocked",
    priority: "normal",
    bucket: "cool_to_do",
    project: "permissions-core",
    source: "manual",
    requester: "people/bastien-leroux",
    needs: "codex",
    effort: "m",
    nextAction: "Resume when the versioned event schema has been merged.",
  },
  {
    dedupeKey: "seed:usage-observatory:cohorts",
    title: "Name the usage dashboard cohorts",
    body: "The current segments make technical sense but are opaque to the Sales team.",
    status: "snoozed",
    snoozeDays: 5,
    priority: "low",
    bucket: "maybe_one_day",
    project: "usage-observatory",
    source: "manual",
    requester: "people/theo-valmont",
    needs: "human",
    effort: "xs",
    nextAction: "Propose four labels after the next weekly data collection.",
  },
  {
    dedupeKey: "seed:usage-observatory:export",
    title: "Scope the monthly metrics export",
    body: "The sales need is real, but the format and recipients have not yet been established.",
    status: "inbox",
    priority: "low",
    bucket: "maybe_one_day",
    project: "usage-observatory",
    source: "slack",
    requester: "people/theo-valmont",
    needs: "human",
    effort: "m",
    nextAction: "Ask Théo for an example of the expected report.",
  },
  {
    dedupeKey: "seed:renewal-signal:history",
    title: "Compare the signal with the quarter's renewals",
    body: "A quick retrospective review will verify that the signal does not generate too many alerts.",
    status: "next",
    priority: "normal",
    bucket: "cool_to_do",
    project: "renewal-signal",
    source: "manual",
    requester: "people/maelle-courtois",
    needs: "codex",
    effort: "m",
    nextAction: "Prepare a prediction/outcome matrix for the quarter's accounts.",
  },
  {
    dedupeKey: "seed:partner-portal:billing",
    title: "Explore delegated partner billing",
    body: "An idea saved for after the beta; no customer commitment makes it a priority today.",
    status: "triaged",
    priority: "low",
    kind: "idea",
    bucket: "maybe_one_day",
    project: "partner-portal",
    source: "manual",
    requester: "people/camille-dervaux",
    needs: "none",
    effort: "l",
    nextAction: "Revisit the idea after feedback from the first three partners.",
  },
  {
    dedupeKey: "seed:onboarding-copilot:video",
    title: "Produce a guided video before the beta",
    body: "The in-app tour makes this video redundant for the first pilot group.",
    status: "dropped",
    priority: "low",
    bucket: "maybe_one_day",
    project: "onboarding-copilot",
    source: "manual",
    requester: "people/maelle-courtois",
    needs: "human",
    effort: "l",
    nextAction: "Produce nothing until comprehension of the in-app tour has been measured.",
  },
];

export class BoucleStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tickets (
        ticket_id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL, priority TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'task',
        bucket TEXT, score REAL NOT NULL DEFAULT 0,
        project TEXT, source TEXT NOT NULL, source_ref TEXT, permalink TEXT, requester TEXT,
        needs TEXT NOT NULL DEFAULT 'human', effort TEXT, due_at TEXT, snoozed_until TEXT,
        next_action TEXT, thread_id TEXT, work_ref TEXT, dedupe_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by TEXT NOT NULL DEFAULT 'chief'
      );
      CREATE INDEX IF NOT EXISTS idx_tickets_status_score ON tickets(status, score DESC);
      CREATE INDEX IF NOT EXISTS idx_tickets_project_status ON tickets(project, status);
      CREATE TABLE IF NOT EXISTS ticket_events (
        event_id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, kind TEXT NOT NULL,
        summary TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ticket_events_ticket ON ticket_events(ticket_id, created_at);
      CREATE TABLE IF NOT EXISTS ticket_source_events (
        event_id TEXT PRIMARY KEY, source TEXT NOT NULL, source_ref TEXT NOT NULL,
        dedupe_key TEXT NOT NULL UNIQUE, ticket_id TEXT, decision TEXT NOT NULL, seen_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS boucle_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS loops (
        loop_id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        prompt TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0,
        interval_minutes INTEGER NOT NULL DEFAULT 60, active_days TEXT NOT NULL DEFAULT '',
        active_start_hour INTEGER NOT NULL DEFAULT 0, active_end_hour INTEGER NOT NULL DEFAULT 0,
        timezone TEXT NOT NULL DEFAULT 'Europe/Paris', codex_home TEXT, profile TEXT, model TEXT,
        thread_id TEXT, thread_project TEXT, thread_open_url TEXT,
        last_run_at TEXT, last_status TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS loop_runs (
        run_id TEXT PRIMARY KEY, loop_id TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
        status TEXT NOT NULL, exit_code INTEGER, summary TEXT NOT NULL DEFAULT '',
        trigger TEXT NOT NULL DEFAULT 'schedule', cost_usd REAL, session_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_loop_runs_loop ON loop_runs(loop_id, started_at DESC);
      CREATE TABLE IF NOT EXISTS project_meta (
        project_id TEXT PRIMARY KEY, status_override TEXT, sort_order REAL, updated_at TEXT NOT NULL
      );
    `);
    this.migrate();
    this.closeAbandonedRuns();
    this.seedLoops();
    this.seedTickets();
  }

  /** Additive column migrations for DBs created before a column existed. */
  private migrate(): void {
    const cols = this.db.prepare(`PRAGMA table_info(tickets)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "work_ref")) {
      this.db.exec(`ALTER TABLE tickets ADD COLUMN work_ref TEXT`);
    }
    if (!cols.some((c) => c.name === "kind")) {
      this.db.exec(`ALTER TABLE tickets ADD COLUMN kind TEXT NOT NULL DEFAULT 'task'`);
    }
    if (!cols.some((c) => c.name === "bucket")) {
      this.db.exec(`ALTER TABLE tickets ADD COLUMN bucket TEXT`);
      // Backfill from priority so the board is immediately useful, not a wall of "untriaged".
      this.db.exec(`
        UPDATE tickets SET bucket = CASE priority
          WHEN 'urgent' THEN 'urgent'
          WHEN 'high' THEN 'to_do_next'
          WHEN 'normal' THEN 'cool_to_do'
          ELSE 'maybe_one_day'
        END WHERE bucket IS NULL
      `);
    }
    const loopCols = this.db.prepare(`PRAGMA table_info(loops)`).all() as Array<{ name: string }>;
    if (!loopCols.some((c) => c.name === "thread_id")) {
      this.db.exec(`ALTER TABLE loops ADD COLUMN thread_id TEXT`);
    }
    if (!loopCols.some((c) => c.name === "thread_project")) {
      this.db.exec(`ALTER TABLE loops ADD COLUMN thread_project TEXT`);
    }
    if (!loopCols.some((c) => c.name === "thread_open_url")) {
      this.db.exec(`ALTER TABLE loops ADD COLUMN thread_open_url TEXT`);
    }
    const runCols = this.db.prepare(`PRAGMA table_info(loop_runs)`).all() as Array<{ name: string }>;
    if (!runCols.some((c) => c.name === "cost_usd")) {
      this.db.exec(`ALTER TABLE loop_runs ADD COLUMN cost_usd REAL`);
    }
    if (!runCols.some((c) => c.name === "session_id")) {
      this.db.exec(`ALTER TABLE loop_runs ADD COLUMN session_id TEXT`);
    }
    // Phase 1 shipped these seeded loops with legacy runner models and one short interval.
    this.db.exec(`
      UPDATE loops SET model = 'devstral-2512'
      WHERE name IN ('Chief of staff', 'Meetings', 'Project timelines')
        AND (model IS NULL OR model LIKE 'gpt-%' OR model LIKE 'claude-%');
      UPDATE loops SET interval_minutes = 60
      WHERE name = 'Meetings' AND interval_minutes < 60;
      UPDATE loops
      SET thread_id = NULL, thread_project = NULL, thread_open_url = NULL
      WHERE thread_id IS NOT NULL AND COALESCE(thread_project, '') != 'vibe';
    `);
  }

  /** Insert the default loops, so a fresh install has working loops. Idempotent per loop name. */
  private seedLoops(): void {
    const count = this.db.prepare(`SELECT COUNT(*) AS n FROM loops`).get() as { n: number };
    if (count.n === 0) {
      this.createLoop({
        name: "Chief of staff",
        description: "Capture and rank materially new asks from Brumeline's synthetic activity.",
        prompt: DEFAULT_CHIEF_PROMPT,
        enabled: false,
        intervalMinutes: 60,
        activeDays: "Mon,Tue,Wed,Thu,Fri",
        activeStartHour: 8,
        activeEndHour: 18,
        timezone: "Europe/Paris",
        codexHome: null,
        profile: null,
      });
    }
    this.ensureLoopByName("Meetings", () => ({
      name: "Meetings",
      description: "Summarize synthetic meeting transcripts and file Nora's action items as tickets.",
      prompt: DEFAULT_MEETINGS_PROMPT,
      enabled: false,
      // Weekdays only (no meetings on weekends), any hour a transcript lands.
      intervalMinutes: 60,
      activeDays: "Mon,Tue,Wed,Thu,Fri",
      activeStartHour: 0,
      activeEndHour: 0,
      timezone: "Europe/Paris",
      codexHome: null,
      profile: null,
      model: "devstral-2512",
    }));
    this.ensureLoopByName("Project timelines", () => ({
      name: "Project timelines",
      description: "Write done-ticket outcomes into the gbrain project pages' ## Timeline sections.",
      prompt: DEFAULT_TIMELINE_SCRIBE_PROMPT,
      enabled: false,
      // Twice a working day is plenty — timelines are a digest, not a live feed.
      intervalMinutes: 360,
      activeDays: "Mon,Tue,Wed,Thu,Fri",
      activeStartHour: 9,
      activeEndHour: 19,
      timezone: "Europe/Paris",
      codexHome: null,
      profile: null,
      model: "devstral-2512",
    }));
  }

  /** Give a brand-new database a representative synthetic board. */
  private seedTickets(): void {
    const count = this.db.prepare(`SELECT COUNT(*) AS n FROM tickets`).get() as { n: number };
    if (count.n !== 0) return;
    for (const seed of DEFAULT_TICKETS) {
      const ticket = this.upsert(seed);
      if (seed.status === "inbox") continue;
      const snoozedUntil =
        seed.status === "snoozed"
          ? new Date(Date.now() + (seed.snoozeDays ?? 1) * DAY_MS).toISOString()
          : null;
      this.transition(ticket.ticketId, seed.status, snoozedUntil, "Synthetic first-boot seed", seed.workRef);
    }
  }

  /** Create a loop with the given name only if none exists yet (survives restarts on existing DBs). */
  private ensureLoopByName(name: string, build: () => CreateLoopInput): void {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM loops WHERE name = ?`).get(name) as { n: number };
    if (row.n === 0) this.createLoop(build());
  }

  private closeAbandonedRuns(): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE loop_runs
         SET status = 'timeout', finished_at = ?, exit_code = NULL,
             summary = CASE
               WHEN summary IS NULL OR summary = '' THEN 'Marked timeout on Boucle server startup; previous process exited before closing this run.'
               ELSE summary || char(10) || 'Marked timeout on Boucle server startup; previous process exited before closing this run.'
             END
         WHERE status = 'running' AND finished_at IS NULL`,
      )
      .run(now);
  }

  private recordEvent(ticketId: string, kind: TicketEventKind, summary: string, at: string): void {
    this.db
      .prepare(`INSERT INTO ticket_events (event_id, ticket_id, kind, summary, created_at) VALUES (?,?,?,?,?)`)
      .run(randomUUID(), ticketId, kind, summary, at);
  }

  /** Append a free-form event to a ticket's timeline (manual/agent actions). */
  addEvent(ticketId: string, kind: TicketEventKind, summary: string): void {
    this.recordEvent(ticketId, kind, summary, new Date().toISOString());
  }

  getById(ticketId: string): Ticket | null {
    const row = this.db.prepare(`SELECT ${TICKET_COLUMNS} FROM tickets WHERE ticket_id = ? LIMIT 1`).get(ticketId) as
      | RawTicket
      | undefined;
    return row ? toTicket(row) : null;
  }

  getByDedupeKey(dedupeKey: string): Ticket | null {
    const row = this.db.prepare(`SELECT ${TICKET_COLUMNS} FROM tickets WHERE dedupe_key = ? LIMIT 1`).get(dedupeKey) as
      | RawTicket
      | undefined;
    return row ? toTicket(row) : null;
  }

  getByThreadId(threadId: string): Ticket | null {
    const row = this.db.prepare(`SELECT ${TICKET_COLUMNS} FROM tickets WHERE thread_id = ? LIMIT 1`).get(threadId) as
      | RawTicket
      | undefined;
    return row ? toTicket(row) : null;
  }

  upsert(input: UpsertTicketInput): Ticket {
    const now = new Date();
    const nowIso = now.toISOString();
    const nowMs = now.getTime();
    const existing = this.getByDedupeKey(input.dedupeKey);

    const priority = input.priority ?? "normal";
    const dueAt = input.dueAt ?? null;
    const effort = input.effort ?? null;
    const ticket: Ticket = {
      ticketId: existing?.ticketId ?? randomUUID(),
      title: input.title,
      body: input.body ?? "",
      status: existing?.status ?? "inbox",
      priority: existing?.priority ?? priority,
      kind: existing?.kind ?? input.kind ?? "task",
      bucket: existing ? existing.bucket : (input.bucket ?? bucketFromPriority(priority)),
      score: 0,
      project: existing ? existing.project : (input.project ?? null),
      source: input.source,
      sourceRef: input.sourceRef ?? existing?.sourceRef ?? null,
      permalink: input.permalink ?? existing?.permalink ?? null,
      requester: input.requester ?? existing?.requester ?? null,
      needs: existing?.needs ?? input.needs ?? "human",
      effort: existing ? existing.effort : effort,
      dueAt: existing ? existing.dueAt : dueAt,
      snoozedUntil: existing?.snoozedUntil ?? null,
      nextAction: input.nextAction ?? existing?.nextAction ?? null,
      threadId: existing?.threadId ?? input.threadId ?? null,
      workRef: existing?.workRef ?? null,
      dedupeKey: input.dedupeKey,
      createdAt: existing?.createdAt ?? nowIso,
      updatedAt: existing?.updatedAt ?? nowIso,
      createdBy: existing?.createdBy ?? input.createdBy ?? "chief",
    };
    // On a fresh ticket compute score; on a repeat we only refresh descriptive
    // fields and preserve triage (status/priority/project/score).
    if (existing) {
      this.db
        .prepare(`UPDATE tickets SET body = ?, permalink = ?, source_ref = ?, next_action = ? WHERE dedupe_key = ?`)
        .run(ticket.body, ticket.permalink, ticket.sourceRef, ticket.nextAction, input.dedupeKey);
      return this.getByDedupeKey(input.dedupeKey)!;
    }
    ticket.score = computeScore(ticket, nowMs);
    this.db
      .prepare(
        `INSERT INTO tickets (ticket_id,title,body,status,priority,kind,bucket,score,project,source,source_ref,permalink,requester,needs,effort,due_at,snoozed_until,next_action,thread_id,work_ref,dedupe_key,created_at,updated_at,created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        ticket.ticketId, ticket.title, ticket.body, ticket.status, ticket.priority, ticket.kind, ticket.bucket, ticket.score,
        ticket.project, ticket.source, ticket.sourceRef, ticket.permalink, ticket.requester, ticket.needs,
        ticket.effort, ticket.dueAt, ticket.snoozedUntil, ticket.nextAction, ticket.threadId,
        ticket.workRef, ticket.dedupeKey, ticket.createdAt,
        ticket.updatedAt, ticket.createdBy,
      );
    this.recordEvent(ticket.ticketId, "created", `Captured from ${ticket.source}`, nowIso);
    return ticket;
  }

  private writeTicket(t: Ticket): void {
    this.db
      .prepare(
        `UPDATE tickets SET title=?,body=?,status=?,priority=?,kind=?,bucket=?,score=?,project=?,source=?,source_ref=?,permalink=?,requester=?,needs=?,effort=?,due_at=?,snoozed_until=?,next_action=?,thread_id=?,work_ref=?,created_by=?,updated_at=? WHERE ticket_id=?`,
      )
      .run(
        t.title, t.body, t.status, t.priority, t.kind, t.bucket, t.score, t.project, t.source, t.sourceRef, t.permalink,
        t.requester, t.needs, t.effort, t.dueAt, t.snoozedUntil, t.nextAction, t.threadId,
        t.workRef, t.createdBy, t.updatedAt, t.ticketId,
      );
  }

  transition(
    ticketId: string,
    toStatus: TicketStatus,
    snoozedUntil?: string | null,
    reason?: string | null,
    workRef?: string | null,
  ): Ticket {
    const prev = this.getById(ticketId);
    if (!prev) throw new Error(`Ticket not found: ${ticketId}`);
    const now = new Date();
    const snooze = toStatus === "snoozed" ? (snoozedUntil ?? null) : null;
    const ref = workRef && workRef.trim().length > 0 ? workRef.trim() : prev.workRef;
    const updated: Ticket = {
      ...prev,
      status: toStatus,
      snoozedUntil: snooze,
      workRef: ref,
      updatedAt: now.toISOString(),
    };
    updated.score = computeScore(updated, now.getTime());
    this.writeTicket(updated);
    const note = toStatus === "snoozed" && snooze ? ` (until ${snooze})` : "";
    const why = reason && reason.trim().length > 0 ? ` — ${reason.trim()}` : "";
    this.recordEvent(ticketId, "status", `${prev.status} → ${toStatus}${note}${why}`, now.toISOString());
    if (ref !== prev.workRef && ref) this.recordEvent(ticketId, "chat", `Linked work: ${ref}`, now.toISOString());
    return updated;
  }

  setFields(input: SetTicketFieldsInput): Ticket {
    const prev = this.getById(input.ticketId);
    if (!prev) throw new Error(`Ticket not found: ${input.ticketId}`);
    const now = new Date();
    const iso = now.toISOString();
    const updated: Ticket = {
      ...prev,
      title: input.title ?? prev.title,
      body: input.body ?? prev.body,
      priority: input.priority ?? prev.priority,
      kind: input.kind ?? prev.kind,
      bucket: input.bucket !== undefined ? input.bucket : prev.bucket,
      project: input.project !== undefined ? input.project : prev.project,
      needs: input.needs ?? prev.needs,
      effort: input.effort !== undefined ? input.effort : prev.effort,
      dueAt: input.dueAt !== undefined ? input.dueAt : prev.dueAt,
      nextAction: input.nextAction !== undefined ? input.nextAction : prev.nextAction,
      threadId: input.threadId !== undefined ? input.threadId : prev.threadId,
      workRef: input.workRef !== undefined ? input.workRef : prev.workRef,
      updatedAt: iso,
    };
    updated.score = computeScore(updated, now.getTime());
    this.writeTicket(updated);
    if (updated.priority !== prev.priority) this.recordEvent(updated.ticketId, "priority", `Priority ${prev.priority} → ${updated.priority}`, iso);
    if (updated.kind !== prev.kind) this.recordEvent(updated.ticketId, "field", `Kind ${prev.kind} → ${updated.kind}`, iso);
    if (updated.bucket !== prev.bucket) this.recordEvent(updated.ticketId, "field", `Bucket → ${updated.bucket ?? "none"}`, iso);
    if (updated.project !== prev.project) this.recordEvent(updated.ticketId, "project", `Project → ${updated.project ?? "none"}`, iso);
    if (updated.needs !== prev.needs) this.recordEvent(updated.ticketId, "needs", `Needs → ${updated.needs}`, iso);
    if (updated.threadId !== prev.threadId) this.recordEvent(updated.ticketId, "chat", updated.threadId ? "Linked a chat" : "Unlinked chat", iso);
    return updated;
  }

  private query(where: string, params: unknown[]): Ticket[] {
    const rows = this.db
      .prepare(`SELECT ${TICKET_COLUMNS} FROM tickets WHERE ${where} ORDER BY score DESC, updated_at ASC`)
      .all(...(params as never[])) as unknown as RawTicket[];
    return rows.map(toTicket);
  }

  /**
   * Wake snoozed tickets whose snoozed_until has passed: back to 'next' with a fresh
   * score. Called from the read paths (listOpen/next) so waking needs no extra timer.
   */
  wakeSnoozed(): number {
    const now = new Date();
    const nowIso = now.toISOString();
    const due = this.db
      .prepare(
        `SELECT ${TICKET_COLUMNS} FROM tickets
         WHERE status = 'snoozed' AND snoozed_until IS NOT NULL AND snoozed_until <= ?`,
      )
      .all(nowIso) as unknown as RawTicket[];
    for (const row of due) {
      const t = toTicket(row);
      const woke: Ticket = { ...t, status: "next", snoozedUntil: null, updatedAt: nowIso };
      woke.score = computeScore(woke, now.getTime());
      this.writeTicket(woke);
      this.recordEvent(t.ticketId, "status", `snoozed → next (woke up)`, nowIso);
    }
    return due.length;
  }

  listOpen(): Ticket[] {
    this.wakeSnoozed();
    return this.query(`status IN ('inbox','triaged','next','snoozed','blocked','in_progress')`, []);
  }

  list(filter: ListTicketsFilter): Ticket[] {
    return this.query(
      `(? IS NULL OR status = ?) AND (? IS NULL OR project = ?) AND (? IS NULL OR needs = ?)`,
      [
        filter.status ?? null, filter.status ?? null,
        filter.project ?? null, filter.project ?? null,
        filter.needs ?? null, filter.needs ?? null,
      ],
    );
  }

  next(project?: string | null, limit = 50): Ticket[] {
    this.wakeSnoozed();
    const nowIso = new Date().toISOString();
    const rows = this.db
      .prepare(
        `SELECT ${TICKET_COLUMNS} FROM tickets
         WHERE status IN ('inbox','triaged','next','in_progress')
           AND (snoozed_until IS NULL OR snoozed_until <= ?)
           AND (? IS NULL OR project = ?)
         ORDER BY score DESC, updated_at ASC LIMIT ?`,
      )
      .all(nowIso, project ?? null, project ?? null, limit) as unknown as RawTicket[];
    return rows.map(toTicket);
  }

  reprioritize(): number {
    const nowMs = Date.now();
    let updated = 0;
    for (const t of this.listOpen()) {
      const score = computeScore(t, nowMs);
      if (score !== t.score) {
        this.db.prepare(`UPDATE tickets SET score = ? WHERE ticket_id = ?`).run(score, t.ticketId);
        updated += 1;
      }
    }
    return updated;
  }

  /**
   * "What is moving forward" — items resolved (→ done) per project per day, for the activity
   * grid. Derived from the ticket_events timeline so history survives re-triage.
   */
  activity(days = 26): Array<{ day: string; project: string | null; count: number }> {
    const since = new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
    return this.db
      .prepare(
        `SELECT substr(e.created_at, 1, 10) AS day, t.project AS project, COUNT(*) AS count
         FROM ticket_events e JOIN tickets t ON t.ticket_id = e.ticket_id
         WHERE e.kind = 'status' AND e.summary LIKE '%→ done%' AND e.created_at >= ?
         GROUP BY day, project ORDER BY day ASC`,
      )
      .all(since) as Array<{ day: string; project: string | null; count: number }>;
  }

  listEvents(ticketId: string): TicketEvent[] {
    return this.db
      .prepare(
        `SELECT event_id AS eventId, ticket_id AS ticketId, kind, summary, created_at AS at
         FROM ticket_events WHERE ticket_id = ? ORDER BY created_at ASC, event_id ASC`,
      )
      .all(ticketId) as unknown as TicketEvent[];
  }

  getSourceEvent(dedupeKey: string): TicketSourceEvent | null {
    const row = this.db
      .prepare(
        `SELECT source, source_ref AS sourceRef, dedupe_key AS dedupeKey, ticket_id AS ticketId, decision, seen_at AS seenAt
         FROM ticket_source_events WHERE dedupe_key = ? LIMIT 1`,
      )
      .get(dedupeKey) as TicketSourceEvent | undefined;
    return row ?? null;
  }

  markSourceSeen(input: Omit<TicketSourceEvent, "seenAt">): void {
    this.db
      .prepare(
        `INSERT INTO ticket_source_events (event_id, source, source_ref, dedupe_key, ticket_id, decision, seen_at)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(dedupe_key) DO UPDATE SET ticket_id = excluded.ticket_id, decision = excluded.decision, seen_at = excluded.seen_at`,
      )
      .run(randomUUID(), input.source, input.sourceRef, input.dedupeKey, input.ticketId, input.decision, new Date().toISOString());
  }

  // ===============================
  // Loops
  // ===============================

  createLoop(input: CreateLoopInput): Loop {
    const now = new Date().toISOString();
    const loop: Loop = {
      loopId: randomUUID(),
      name: input.name,
      description: input.description ?? "",
      prompt: input.prompt,
      enabled: input.enabled ?? false,
      intervalMinutes: Math.max(60, input.intervalMinutes ?? 60),
      activeDays: input.activeDays ?? "",
      activeStartHour: input.activeStartHour ?? 0,
      activeEndHour: input.activeEndHour ?? 0,
      timezone: input.timezone ?? "Europe/Paris",
      codexHome: input.codexHome ?? null,
      profile: input.profile ?? null,
      model: input.model ?? "devstral-2512",
      threadId: null,
      threadProject: null,
      threadOpenUrl: null,
      lastRunAt: null,
      lastStatus: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO loops (loop_id,name,description,prompt,enabled,interval_minutes,active_days,active_start_hour,active_end_hour,timezone,codex_home,profile,model,thread_id,thread_project,thread_open_url,last_run_at,last_status,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        loop.loopId, loop.name, loop.description, loop.prompt, loop.enabled ? 1 : 0,
        loop.intervalMinutes, loop.activeDays, loop.activeStartHour, loop.activeEndHour,
        loop.timezone, loop.codexHome, loop.profile, loop.model, loop.threadId, loop.threadProject,
        loop.threadOpenUrl, loop.lastRunAt, loop.lastStatus, loop.createdAt, loop.updatedAt,
      );
    return loop;
  }

  updateLoop(input: UpdateLoopInput): Loop {
    const prev = this.getLoop(input.loopId);
    if (!prev) throw new Error(`Loop not found: ${input.loopId}`);
    const next: Loop = {
      ...prev,
      name: input.name ?? prev.name,
      description: input.description ?? prev.description,
      prompt: input.prompt ?? prev.prompt,
      enabled: input.enabled ?? prev.enabled,
      intervalMinutes: input.intervalMinutes === undefined ? prev.intervalMinutes : Math.max(60, input.intervalMinutes),
      activeDays: input.activeDays ?? prev.activeDays,
      activeStartHour: input.activeStartHour ?? prev.activeStartHour,
      activeEndHour: input.activeEndHour ?? prev.activeEndHour,
      timezone: input.timezone ?? prev.timezone,
      codexHome: input.codexHome !== undefined ? input.codexHome : prev.codexHome,
      profile: input.profile !== undefined ? input.profile : prev.profile,
      model: input.model !== undefined ? input.model : prev.model,
      threadId: input.threadId !== undefined ? input.threadId : prev.threadId,
      threadProject: input.threadProject !== undefined ? input.threadProject : prev.threadProject,
      threadOpenUrl: input.threadOpenUrl !== undefined ? input.threadOpenUrl : prev.threadOpenUrl,
      updatedAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `UPDATE loops SET name=?,description=?,prompt=?,enabled=?,interval_minutes=?,active_days=?,active_start_hour=?,active_end_hour=?,timezone=?,codex_home=?,profile=?,model=?,thread_id=?,thread_project=?,thread_open_url=?,updated_at=? WHERE loop_id=?`,
      )
      .run(
        next.name, next.description, next.prompt, next.enabled ? 1 : 0, next.intervalMinutes,
        next.activeDays, next.activeStartHour, next.activeEndHour, next.timezone, next.codexHome,
        next.profile, next.model, next.threadId, next.threadProject, next.threadOpenUrl, next.updatedAt,
        next.loopId,
      );
    return next;
  }

  setLoopThread(loopId: string, thread: { threadId: string; project: string; openUrl: string }): Loop {
    return this.updateLoop({
      loopId,
      threadId: thread.threadId,
      threadProject: thread.project,
      threadOpenUrl: thread.openUrl,
    });
  }

  deleteLoop(loopId: string): void {
    this.db.prepare(`DELETE FROM loop_runs WHERE loop_id = ?`).run(loopId);
    this.db.prepare(`DELETE FROM loops WHERE loop_id = ?`).run(loopId);
  }

  getLoop(loopId: string): Loop | null {
    const row = this.db.prepare(`SELECT ${LOOP_COLUMNS} FROM loops WHERE loop_id = ? LIMIT 1`).get(loopId) as
      | RawLoop
      | undefined;
    return row ? toLoop(row) : null;
  }

  listLoops(): Loop[] {
    const rows = this.db.prepare(`SELECT ${LOOP_COLUMNS} FROM loops ORDER BY created_at ASC`).all() as RawLoop[];
    return rows.map(toLoop);
  }

  listEnabledLoops(): Loop[] {
    const rows = this.db
      .prepare(`SELECT ${LOOP_COLUMNS} FROM loops WHERE enabled = 1 ORDER BY created_at ASC`)
      .all() as RawLoop[];
    return rows.map(toLoop);
  }

  /** Open a run row (status "running") and stamp the loop's last_run_at. */
  recordRunStart(loopId: string, trigger: LoopRunTrigger): LoopRun {
    const run: LoopRun = {
      runId: randomUUID(),
      loopId,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      status: "running",
      exitCode: null,
      summary: "",
      trigger,
      costUsd: null,
      sessionId: null,
    };
    this.db
      .prepare(
        `INSERT INTO loop_runs (run_id,loop_id,started_at,finished_at,status,exit_code,summary,trigger,cost_usd,session_id) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(run.runId, run.loopId, run.startedAt, null, run.status, null, "", run.trigger, null, null);
    this.db
      .prepare(`UPDATE loops SET last_run_at = ?, last_status = 'running' WHERE loop_id = ?`)
      .run(run.startedAt, loopId);
    return run;
  }

  /** Close a run row and mirror the terminal status onto the loop. */
  recordRunFinish(
    runId: string,
    loopId: string,
    status: LoopRunStatus,
    exitCode: number | null,
    summary: string,
    costUsd: number | null,
    sessionId: string | null,
  ): void {
    const finishedAt = new Date().toISOString();
    this.db
      .prepare(`UPDATE loop_runs SET finished_at = ?, status = ?, exit_code = ?, summary = ?, cost_usd = ?, session_id = ? WHERE run_id = ?`)
      .run(finishedAt, status, exitCode, summary, costUsd, sessionId, runId);
    this.db.prepare(`UPDATE loops SET last_status = ? WHERE loop_id = ?`).run(status, loopId);
  }

  listRuns(loopId: string, limit = 20): LoopRun[] {
    const rows = this.db
      .prepare(
        `SELECT run_id AS runId, loop_id AS loopId, started_at AS startedAt, finished_at AS finishedAt,
                status, exit_code AS exitCode, summary, trigger,
                cost_usd AS costUsd, session_id AS sessionId
         FROM loop_runs WHERE loop_id = ? ORDER BY started_at DESC LIMIT ?`,
      )
      .all(loopId, limit) as unknown as LoopRun[];
    return rows;
  }

  getLoopCostSummary(): LoopCostSummary {
    // Vibe reports per-invocation cost, so loop, capture, and enrich rows are totaled here.
    // Conversations API responses do not expose billed cost; estimating browser chat,
    // describe, or brief spend would invent numbers, so those calls are excluded.
    const row = this.db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS total FROM loop_runs`).get() as { total: number };
    const totalCostUsd = row.total;
    return {
      totalCostUsd,
      warning: totalCostUsd >= 10
        ? totalCostUsd >= 30
          ? `Vibe budget exhausted ($${totalCostUsd.toFixed(2)} recorded; hard stop at $30.00).`
          : `Vibe spend has crossed the $10 warning threshold ($${totalCostUsd.toFixed(2)} recorded).`
        : null,
      blocked: totalCostUsd >= 30,
    };
  }

  // ===============================
  // Project overlay — editable status + order over the read-only gbrain files
  // ===============================

  listProjectMeta(): Map<string, ProjectMeta> {
    const rows = this.db
      .prepare(`SELECT project_id AS projectId, status_override AS statusOverride, sort_order AS sortOrder FROM project_meta`)
      .all() as Array<{ projectId: string; statusOverride: string | null; sortOrder: number | null }>;
    return new Map(rows.map((r) => [r.projectId, { statusOverride: r.statusOverride, sortOrder: r.sortOrder }]));
  }

  private upsertProjectMeta(projectId: string, patch: Partial<{ statusOverride: string | null; sortOrder: number }>): void {
    const now = new Date().toISOString();
    const prev = this.db
      .prepare(`SELECT status_override AS statusOverride, sort_order AS sortOrder FROM project_meta WHERE project_id = ?`)
      .get(projectId) as { statusOverride: string | null; sortOrder: number | null } | undefined;
    const statusOverride = patch.statusOverride !== undefined ? patch.statusOverride : (prev?.statusOverride ?? null);
    const sortOrder = patch.sortOrder !== undefined ? patch.sortOrder : (prev?.sortOrder ?? null);
    this.db
      .prepare(
        `INSERT INTO project_meta (project_id, status_override, sort_order, updated_at) VALUES (?,?,?,?)
         ON CONFLICT(project_id) DO UPDATE SET status_override = excluded.status_override, sort_order = excluded.sort_order, updated_at = excluded.updated_at`,
      )
      .run(projectId, statusOverride, sortOrder, now);
  }

  setProjectStatus(projectId: string, status: string | null): void {
    this.upsertProjectMeta(projectId, { statusOverride: status });
  }

  setProjectOrder(orderedIds: string[]): void {
    orderedIds.forEach((projectId, i) => this.upsertProjectMeta(projectId, { sortOrder: i }));
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM boucle_meta WHERE key = ?`).get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(`INSERT INTO boucle_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(key, value);
  }
}
