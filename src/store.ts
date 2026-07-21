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
import { resolveBrainDir } from "./config.ts";
import { emit } from "./extensions/events.ts";
import { getIdentity, type Identity } from "./identity.ts";
import { isKnownRunnerName, knownRunnerNames } from "./selectors.ts";
import type { RunnerName } from "./settings.ts";

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
  t3codeThreadId: string | null;
  t3codeOpenUrl: string | null;
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
  t3codeThreadId?: string | null;
  t3codeOpenUrl?: string | null;
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
  t3codeThreadId?: string | null;
  t3codeOpenUrl?: string | null;
  workRef?: string | null;
}

export interface ListTicketsFilter {
  status?: TicketStatus;
  project?: string;
  needs?: TicketNeeds;
}

export interface SearchIndexer {
  reindexTicket(ticketId: string): void;
  search(query: string, limit?: number): Promise<unknown>;
}

export type ConversationKind = "chat" | "brain";

export interface ConversationRecord {
  conversationId: string;
  kind: ConversationKind;
  title: string;
  provider: string;
  model: string;
  instructions: string;
  createdAt: string;
}

export interface CreateConversationInput {
  kind: ConversationKind;
  title: string;
  provider: string;
  model: string;
  instructions: string;
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
// Loops — scheduled agent runs that Boucle owns
// ===============================

export type LoopRunStatus = "running" | "ok" | "error" | "timeout";
export type LoopRunTrigger = "schedule" | "manual" | "smart_capture" | "enrich" | "vibe_thread";

export interface Loop {
  loopId: string;
  name: string;
  description: string;
  /** The full instructions handed to the selected agent runner as the prompt. */
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
  /** Per-loop runner override; null uses the global setting. */
  runner: RunnerName | null;
  /** Persistent runner session used for this loop's scheduled/manual runs. */
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
  runner: RunnerName | null;
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
  runner?: RunnerName | null;
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
  runner?: RunnerName | null;
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
  thread_id AS threadId, t3code_thread_id AS t3codeThreadId, t3code_open_url AS t3codeOpenUrl,
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
  timezone, codex_home AS codexHome, profile, model, runner,
  thread_id AS threadId, thread_project AS threadProject, thread_open_url AS threadOpenUrl,
  last_run_at AS lastRunAt, last_status AS lastStatus,
  created_at AS createdAt, updated_at AS updatedAt
`;

type RawLoop = Omit<Loop, "enabled"> & { enabled: number };

function toLoop(row: RawLoop): Loop {
  return { ...row, enabled: row.enabled === 1 };
}

function validatedRunner(value: RunnerName | null): RunnerName | null {
  if (value === null || isKnownRunnerName(value)) return value;
  throw new Error(`runner must be one of: ${knownRunnerNames().join(", ")}, or null.`);
}

/** Default chief-of-staff heartbeat loop prompt, seeded (interpolated) on first boot. */
export function defaultChiefPrompt(identity: Identity): string {
  const owner = identity.ownerName || "the owner";
  const forOrg = identity.orgName ? ` for ${identity.orgName}` : "";
  const material = identity.demoMode ? "the synthetic material in fake-brain/" : "the material in the brain";
  const brainWord = identity.demoMode ? "fake-brain" : "brain";
  const peopleFocus = identity.demoMode
    ? "Pay particular attention to work involving Camille Dervaux, Émile Rousset, Inès Marceau, Théo Valmont, Maëlle Courtois, and Bastien Leroux. "
    : "";
  const scopeLine = identity.demoMode
    ? `\n\n${owner} owns product delivery across ${identity.orgName}'s customer-operations platform: Renewal Signal, Partner Portal, Onboarding Copilot, Hélium Migration, Permissions Core, and Usage Observatory. Other people's action items are not ${owner}'s tickets, even when they appear in a meeting they attended.`
    : `\n\nOther people's action items are not ${owner}'s tickets, even when they appear in a meeting they attended.`;
  return `Act as a lightweight chief of staff${forOrg}. Use only ${material} plus Boucle's MCP tools. Keep project knowledge current and prioritize
pending asks, blockers, decisions, launch changes, access issues, and review requests. Review recent local
activity broadly: project notes, meeting notes, ticket history, ${owner}'s own replies, and ordinary team updates.
Do not treat triage as only a keyword-search problem; read the relevant context directly. ${peopleFocus}An ask
directed at ${owner} counts whether or not their name is stated explicitly. Record durable signals on the
relevant ${brainWord} project pages. Stay quiet if nothing meaningful changed. Outside Monday-Friday 08:00-18:00
Europe/Paris, return DONT_NOTIFY unless the current thread already contains an urgent issue.${scopeLine}

Work the queue via the MCP tools (never send an outbound message):
- Before creating a ticket, use brain_search to find and merge overlapping tickets or existing brain context.
- Self-clean first. Review open tickets with ticket_list / ticket_next and re-check the matching project,
  meeting, and ticket history. Use ticket_transition to mark work done or dropped when it was handled, became
  obsolete, or belongs to another teammate. Always pass a one-line \`reason\`, and set \`workRef\` when a
  local project artifact records the resolution. Read before closing; when unsure, leave it open.
- Create tickets only for action items ${owner} must personally do. Skip other teammates' commitments, FYIs, and
  announcements. Use ticket_upsert with an idempotent dedupeKey. Give each ticket a short imperative
  title, appropriate priority, matching ${brainWord} project slug, needs, requester slug, and one concrete next
  action. Meeting and project signals may update the ${brainWord} without becoming tickets.
- Use source_seen to skip already-classified signals and mark_source_seen to record decisions.
- For actionable tickets with needs=codex or needs=claude and no linked thread, call spawn_chat once. Let
  spawn_chat set the thread link; never write threadId by hand.
- Call reprioritize once at the end. Keep it to about 12 tickets per run; prefer precision over recall.`;
}

export function defaultMeetingsPrompt(identity: Identity): string {
  const owner = identity.ownerName || "the owner";
  const brainDir = resolveBrainDir();
  const transcriptWord = identity.demoMode ? "synthetic meeting" : "meeting";
  const peopleTag = identity.demoMode ? "fictional " : "";
  return `Process freshly recorded ${transcriptWord} transcripts for ${owner}. The recorder drops raw markdown
files in ${brainDir}/meetings/ with YAML frontmatter containing \`processed: false\`. Turn each unprocessed
transcript into a clean meeting note and create Boucle tickets for ${owner}'s own action items.

Do exactly this each run:
1. List ${brainDir}/meetings/*.md and open only files whose frontmatter has \`processed: false\`. If none exist,
   return DONT_NOTIFY without touching curated notes.
2. Read each selected transcript in full. Remote recordings use \`**Me:**\` for ${owner} and \`**Them:**\` for
   everyone else. Single-track recordings may have no speaker labels; use attendees_raw and context without
   inventing attribution.
3. Rewrite the file in place in the existing house style. Preserve the YAML frontmatter, resolve attendees to
   ${peopleTag}\`people/<slug>\` values, keep title and call_link, add tags and related_projects, and set
   \`processed: true\`. Add a title, summary blockquote, Key points, Decisions, Action items with owners, and
   Connections with people/project wikilinks. Preserve the raw transcript under a collapsed Transcript section.
4. Before creating anything, use brain_search to dedupe and merge against existing tickets and brain context.
   Create a ticket only for action items ${owner} committed to. Use ticket_upsert with dedupeKey
   "meeting:<filename>:<n>", a short imperative title, priority from urgency, the matching project slug,
   suitable needs, requester, and one concrete next action. Use source "manual". Do not invent tasks.
5. Update the relevant project pages under ${brainDir} with durable meeting signals, then trigger the local reindex shim.
6. Call reprioritize once. Summarize which meetings were processed and how many tickets were created, or return
   DONT_NOTIFY when there was nothing to process.`;
}

export function defaultTimelineScribePrompt(identity: Identity): string {
  const brainDir = resolveBrainDir();
  const teamRef = identity.orgName ? `the ${identity.orgName} team` : "the team";
  const noopLine = identity.demoMode
    ? "4. After any edit, run scripts/gbrain-noop import fake-brain. It is intentionally a local no-op for this demo."
    : "";
  return `Keep project timelines under ${brainDir} current from Boucle ticket activity so the Projects page reflects what
${teamRef} actually shipped.

Do exactly this each run:
1. Call ticket_list with status "done", then status "dropped". Keep only tickets updated in the last 24 hours
   that have a project slug. If none qualify, return DONT_NOTIFY.
2. Open ${brainDir}/projects/<slug>.md for each affected project and read its "## Timeline" section. For each
   meaningful completion — something shipped, decided, fixed, or unblocked — append one entry in the format
   \`- **YYYY-MM-DD** | <past-tense one-liner>\`. Skip dropped noise, snooze churn, and trivia. Include workRef
   when useful and combine related same-day completions naturally.
3. Before writing, use brain_search to dedupe and merge against existing tickets and brain context, then check
   the full page for the event. Append only, never rewrite or delete existing entries,
   keep oldest-first order, and create "## Timeline" only when missing.
${noopLine ? `${noopLine}\n` : ""}${identity.demoMode ? "5" : "4"}. Summarize which pages changed, or return DONT_NOTIFY if none did.`;
}

interface SeedTicket extends UpsertTicketInput {
  status: TicketStatus;
  snoozeDays?: number;
  workRef?: string;
  /** Backdate: days ago the ticket reached its status (drives the "done" history + activity heatmap). */
  doneDaysAgo?: number;
  /** Backdate: days ago the ticket was captured. Defaults to a few days before doneDaysAgo. */
  createdDaysAgo?: number;
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
    workRef: "https://example.com/runbooks/helium-rollback",
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

/**
 * Completed work from the last few weeks, so the board has history on first boot: the Done
 * view, project timelines, and the activity heatmap all read from these. Every entry is
 * `status: "done"` with `doneDaysAgo` so the seed backdates it; titles align with the
 * demo project pages and meeting notes under fake-brain/.
 */
const HISTORICAL_TICKETS: SeedTicket[] = [
  {
    dedupeKey: "seed:hist:helium-inventory",
    title: "Inventory the workspaces and data volumes to migrate",
    body: "Full inventory of historical customer workspaces headed to Hélium, with per-workspace data volumes.",
    status: "done",
    priority: "high",
    project: "helium-migration",
    source: "manual",
    requester: "people/bastien-leroux",
    needs: "human",
    effort: "l",
    nextAction: "Shared the inventory sheet with Émile and Maëlle.",
    createdDaysAgo: 30,
    doneDaysAgo: 23,
  },
  {
    dedupeKey: "seed:hist:renewal-scoring-v1",
    title: "Ship the at-risk account scoring v1",
    body: "First scoring pass over renewal signals, reviewed before the pilot.",
    status: "done",
    priority: "high",
    project: "renewal-signal",
    source: "manual",
    requester: "people/maelle-courtois",
    needs: "claude",
    effort: "l",
    nextAction: "Signed off in the renewal signal review.",
    createdDaysAgo: 28,
    doneDaysAgo: 24,
  },
  {
    dedupeKey: "seed:hist:helium-rollback",
    title: "Validate the Hélium rollback procedure",
    body: "Rollback rehearsed end to end; confirmed under fifteen minutes.",
    status: "done",
    priority: "urgent",
    project: "helium-migration",
    source: "manual",
    requester: "people/emile-rousset",
    needs: "human",
    effort: "m",
    nextAction: "Recorded the rollback runbook on the project page.",
    createdDaysAgo: 24,
    doneDaysAgo: 21,
  },
  {
    dedupeKey: "seed:hist:partner-scoping",
    title: "Draft the partner portal scoping brief",
    body: "Scope, non-goals, and open questions captured for the partner portal.",
    status: "done",
    priority: "normal",
    project: "partner-portal",
    source: "manual",
    requester: "people/ines-marceau",
    needs: "human",
    effort: "m",
    nextAction: "Circulated ahead of the scoping meeting.",
    createdDaysAgo: 22,
    doneDaysAgo: 18,
  },
  {
    dedupeKey: "seed:hist:renewal-crm-wiring",
    title: "Wire the renewal signal into the CRM",
    body: "At-risk scores now surface on the account record for account managers.",
    status: "done",
    priority: "normal",
    project: "renewal-signal",
    source: "manual",
    requester: "people/bastien-leroux",
    needs: "codex",
    effort: "m",
    nextAction: "Verified the sync on ten sample accounts.",
    createdDaysAgo: 18,
    doneDaysAgo: 13,
  },
  {
    dedupeKey: "seed:hist:copilot-demo",
    title: "Run the onboarding copilot demo",
    body: "Walked the team through the copilot on five real onboarding journeys.",
    status: "done",
    priority: "normal",
    project: "onboarding-copilot",
    source: "manual",
    requester: "people/emile-rousset",
    needs: "human",
    effort: "s",
    nextAction: "Collected feedback in the demo notes.",
    createdDaysAgo: 19,
    doneDaysAgo: 15,
  },
  {
    dedupeKey: "seed:hist:permissions-workshop",
    title: "Hold the roles and permissions workshop",
    body: "Aligned on the role model and the revocation requirements.",
    status: "done",
    priority: "normal",
    project: "permissions-core",
    source: "manual",
    requester: "people/emile-rousset",
    needs: "human",
    effort: "m",
    nextAction: "Wrote up decisions on the permissions core page.",
    createdDaysAgo: 13,
    doneDaysAgo: 8,
  },
  {
    dedupeKey: "seed:hist:usage-backfill",
    title: "Backfill ninety days of usage events",
    body: "Historical usage events reprocessed so the observatory dashboards have depth.",
    status: "done",
    priority: "normal",
    project: "usage-observatory",
    source: "manual",
    requester: "people/theo-valmont",
    needs: "codex",
    effort: "l",
    nextAction: "Confirmed row counts against the source.",
    createdDaysAgo: 14,
    doneDaysAgo: 9,
  },
  {
    dedupeKey: "seed:hist:partner-permission-model",
    title: "Pick the file-sharing permission model",
    body: "Chose per-folder sharing over per-file for the partner portal.",
    status: "done",
    priority: "high",
    project: "partner-portal",
    source: "manual",
    requester: "people/theo-valmont",
    needs: "human",
    effort: "m",
    nextAction: "Documented the decision and its trade-offs.",
    createdDaysAgo: 11,
    doneDaysAgo: 6,
  },
  {
    dedupeKey: "seed:hist:copilot-instrumentation",
    title: "Instrument copilot suggestion acceptance",
    body: "Acceptance and dismissal of copilot suggestions now tracked per journey.",
    status: "done",
    priority: "normal",
    project: "onboarding-copilot",
    source: "manual",
    requester: "people/ines-marceau",
    needs: "codex",
    effort: "m",
    nextAction: "Dashboards live for the next demo.",
    createdDaysAgo: 9,
    doneDaysAgo: 5,
  },
  {
    dedupeKey: "seed:hist:usage-dashboard-review",
    title: "Review the usage observatory dashboards",
    body: "Walked the dashboards with Bastien and Théo and trimmed the noisy tiles.",
    status: "done",
    priority: "normal",
    project: "usage-observatory",
    source: "manual",
    requester: "people/bastien-leroux",
    needs: "human",
    effort: "s",
    nextAction: "Logged the cohort-naming follow-up as its own ticket.",
    createdDaysAgo: 10,
    doneDaysAgo: 5,
  },
  {
    dedupeKey: "seed:hist:permissions-base-matrix",
    title: "Define the base role matrix",
    body: "Baseline permissions per role agreed for Permissions Core.",
    status: "done",
    priority: "high",
    project: "permissions-core",
    source: "manual",
    requester: "people/emile-rousset",
    needs: "human",
    effort: "m",
    nextAction: "Manager-role edge cases moved to an open ticket.",
    createdDaysAgo: 9,
    doneDaysAgo: 4,
  },
  {
    dedupeKey: "seed:hist:helium-first-wave",
    title: "Migrate the first four workspaces to Hélium",
    body: "First wave completed with no customer incident.",
    status: "done",
    priority: "urgent",
    project: "helium-migration",
    source: "manual",
    requester: "people/emile-rousset",
    needs: "human",
    effort: "l",
    nextAction: "Second-wave list drafted as a follow-up.",
    createdDaysAgo: 10,
    doneDaysAgo: 3,
  },
  {
    dedupeKey: "seed:hist:permissions-security-review",
    title: "Complete the permissions security review",
    body: "Security walked the role model and audit logging; no blockers raised.",
    status: "done",
    priority: "high",
    project: "permissions-core",
    source: "manual",
    requester: "people/camille-dervaux",
    needs: "human",
    effort: "m",
    nextAction: "Audit-log revocation events tracked as an open ticket.",
    createdDaysAgo: 6,
    doneDaysAgo: 1,
  },
];

export class BoucleStore {
  private readonly db: DatabaseSync;
  private searchIndexer: SearchIndexer | null = null;

  constructor(dbPath: string, identity?: Identity) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.initSchema(identity);
  }

  private initSchema(identity?: Identity): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tickets (
        ticket_id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL, priority TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'task',
        bucket TEXT, score REAL NOT NULL DEFAULT 0,
        project TEXT, source TEXT NOT NULL, source_ref TEXT, permalink TEXT, requester TEXT,
        needs TEXT NOT NULL DEFAULT 'human', effort TEXT, due_at TEXT, snoozed_until TEXT,
        next_action TEXT, thread_id TEXT, t3code_thread_id TEXT, t3code_open_url TEXT,
        work_ref TEXT, dedupe_key TEXT NOT NULL UNIQUE,
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
        runner TEXT,
        thread_id TEXT, thread_project TEXT, thread_open_url TEXT,
        last_run_at TEXT, last_status TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS loop_runs (
        run_id TEXT PRIMARY KEY, loop_id TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
        status TEXT NOT NULL, exit_code INTEGER, summary TEXT NOT NULL DEFAULT '',
        trigger TEXT NOT NULL DEFAULT 'schedule', cost_usd REAL, session_id TEXT, runner TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_loop_runs_loop ON loop_runs(loop_id, started_at DESC);
      CREATE TABLE IF NOT EXISTS project_meta (
        project_id TEXT PRIMARY KEY, status_override TEXT, sort_order REAL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversations (
        conversation_id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('chat', 'brain')),
        title TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
        instructions TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversation_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL,
        message_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_conversation_messages_conversation
        ON conversation_messages(conversation_id, id);
    `);
    const resolvedIdentity = identity ?? getIdentity(this);
    this.migrate();
    this.closeAbandonedRuns();
    this.seedLoops(resolvedIdentity);
    if (resolvedIdentity.demoMode) this.seedTickets();
  }

  /** Additive column migrations for DBs created before a column existed. */
  private migrate(): void {
    const cols = this.db.prepare(`PRAGMA table_info(tickets)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "work_ref")) {
      this.db.exec(`ALTER TABLE tickets ADD COLUMN work_ref TEXT`);
    }
    if (!cols.some((c) => c.name === "t3code_thread_id")) {
      this.db.exec(`ALTER TABLE tickets ADD COLUMN t3code_thread_id TEXT`);
    }
    if (!cols.some((c) => c.name === "t3code_open_url")) {
      this.db.exec(`ALTER TABLE tickets ADD COLUMN t3code_open_url TEXT`);
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
    if (!loopCols.some((c) => c.name === "runner")) {
      this.db.exec(`ALTER TABLE loops ADD COLUMN runner TEXT`);
    }
    const runCols = this.db.prepare(`PRAGMA table_info(loop_runs)`).all() as Array<{ name: string }>;
    if (!runCols.some((c) => c.name === "cost_usd")) {
      this.db.exec(`ALTER TABLE loop_runs ADD COLUMN cost_usd REAL`);
    }
    if (!runCols.some((c) => c.name === "session_id")) {
      this.db.exec(`ALTER TABLE loop_runs ADD COLUMN session_id TEXT`);
    }
    if (!runCols.some((c) => c.name === "runner")) {
      this.db.exec(`ALTER TABLE loop_runs ADD COLUMN runner TEXT`);
      // Every run recorded before multi-runner support came from Vibe.
      this.db.exec(`UPDATE loop_runs SET runner = 'vibe' WHERE runner IS NULL`);
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

  createConversation(input: CreateConversationInput): ConversationRecord {
    const conversationId = `local-${randomUUID()}`;
    const createdAt = new Date().toISOString();
    this.db.prepare(`INSERT INTO conversations
      (conversation_id,kind,title,provider,model,instructions,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(conversationId, input.kind, input.title, input.provider, input.model, input.instructions, createdAt);
    return { conversationId, createdAt, ...input };
  }

  getConversation(conversationId: string): ConversationRecord | null {
    return (this.db.prepare(`SELECT conversation_id AS conversationId,kind,title,provider,model,instructions,
      created_at AS createdAt FROM conversations WHERE conversation_id = ?`).get(conversationId) as
      | ConversationRecord
      | undefined) ?? null;
  }

  appendConversationMessage(conversationId: string, message: unknown): void {
    this.db.prepare(`INSERT INTO conversation_messages (conversation_id,message_json,created_at) VALUES (?,?,?)`)
      .run(conversationId, JSON.stringify(message), new Date().toISOString());
  }

  listConversationMessages(conversationId: string): unknown[] {
    const rows = this.db.prepare(`SELECT message_json AS messageJson FROM conversation_messages
      WHERE conversation_id = ? ORDER BY id`).all(conversationId) as Array<{ messageJson: string }>;
    return rows.map((row) => JSON.parse(row.messageJson) as unknown);
  }

  /** Insert the default loops, so a fresh install has working loops. Idempotent per loop name. */
  private seedLoops(identity: Identity): void {
    const count = this.db.prepare(`SELECT COUNT(*) AS n FROM loops`).get() as { n: number };
    if (count.n === 0) {
      this.createLoop({
        name: "Chief of staff",
        description: identity.orgName
          ? `Capture and rank materially new asks from ${identity.orgName}'s activity.`
          : "Capture and rank materially new asks from recent activity.",
        prompt: defaultChiefPrompt(identity),
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
      description: `Summarize ${identity.demoMode ? "synthetic " : ""}meeting transcripts and file ${identity.ownerName || "the owner"}'s action items as tickets.`,
      prompt: defaultMeetingsPrompt(identity),
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
      description: "Write done-ticket outcomes into the brain's project pages' ## Timeline sections.",
      prompt: defaultTimelineScribePrompt(identity),
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

  /** Give a brand-new demo database a representative board plus recent completed history. */
  private seedTickets(): void {
    const count = this.db.prepare(`SELECT COUNT(*) AS n FROM tickets`).get() as { n: number };
    if (count.n !== 0) return;
    for (const seed of [...DEFAULT_TICKETS, ...HISTORICAL_TICKETS]) {
      const ticket = this.upsert(seed);
      if (seed.status !== "inbox") {
        const snoozedUntil =
          seed.status === "snoozed"
            ? new Date(Date.now() + (seed.snoozeDays ?? 1) * DAY_MS).toISOString()
            : null;
        this.transition(ticket.ticketId, seed.status, snoozedUntil, "Demo first-boot seed", seed.workRef);
      }
      if (seed.doneDaysAgo != null) {
        const doneIso = new Date(Date.now() - seed.doneDaysAgo * DAY_MS).toISOString();
        const createdIso = new Date(Date.now() - (seed.createdDaysAgo ?? seed.doneDaysAgo + 4) * DAY_MS).toISOString();
        this.backdateSeededTicket(ticket.ticketId, createdIso, doneIso);
      }
    }
  }

  /**
   * Rewrite a freshly-seeded ticket's timestamps into the past so the board looks lived-in:
   * the row's created/updated dates and its events (creation vs. the status→done change) move
   * to the given instants. Only ever called from the first-boot seed.
   */
  private backdateSeededTicket(ticketId: string, createdIso: string, doneIso: string): void {
    this.db.prepare(`UPDATE tickets SET created_at = ?, updated_at = ? WHERE ticket_id = ?`).run(createdIso, doneIso, ticketId);
    this.db.prepare(`UPDATE ticket_events SET created_at = ? WHERE ticket_id = ? AND kind = 'created'`).run(createdIso, ticketId);
    this.db.prepare(`UPDATE ticket_events SET created_at = ? WHERE ticket_id = ? AND kind <> 'created'`).run(doneIso, ticketId);
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
    this.searchIndexer?.reindexTicket(ticketId);
  }

  setSearchIndexer(indexer: SearchIndexer): void {
    this.searchIndexer = indexer;
  }

  search(query: string, limit?: number): Promise<unknown> {
    if (!this.searchIndexer) throw new Error("Brain search is not initialized");
    return this.searchIndexer.search(query, limit);
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
      t3codeThreadId: existing?.t3codeThreadId ?? input.t3codeThreadId ?? null,
      t3codeOpenUrl: existing?.t3codeOpenUrl ?? input.t3codeOpenUrl ?? null,
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
      this.searchIndexer?.reindexTicket(ticket.ticketId);
      const updated = this.getByDedupeKey(input.dedupeKey)!;
      const changed = (["body", "permalink", "sourceRef", "nextAction"] as const).filter(
        (key) => existing[key] !== updated[key],
      );
      emit("ticket.updated", { ticket: updated, changed: [...changed] });
      return updated;
    }
    ticket.score = computeScore(ticket, nowMs);
    this.db
      .prepare(
        `INSERT INTO tickets (ticket_id,title,body,status,priority,kind,bucket,score,project,source,source_ref,permalink,requester,needs,effort,due_at,snoozed_until,next_action,thread_id,t3code_thread_id,t3code_open_url,work_ref,dedupe_key,created_at,updated_at,created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        ticket.ticketId, ticket.title, ticket.body, ticket.status, ticket.priority, ticket.kind, ticket.bucket, ticket.score,
        ticket.project, ticket.source, ticket.sourceRef, ticket.permalink, ticket.requester, ticket.needs,
        ticket.effort, ticket.dueAt, ticket.snoozedUntil, ticket.nextAction, ticket.threadId,
        ticket.t3codeThreadId, ticket.t3codeOpenUrl,
        ticket.workRef, ticket.dedupeKey, ticket.createdAt,
        ticket.updatedAt, ticket.createdBy,
      );
    this.recordEvent(ticket.ticketId, "created", `Captured from ${ticket.source}`, nowIso);
    emit("ticket.created", { ticket });
    return ticket;
  }

  private writeTicket(t: Ticket): void {
    this.db
      .prepare(
        `UPDATE tickets SET title=?,body=?,status=?,priority=?,kind=?,bucket=?,score=?,project=?,source=?,source_ref=?,permalink=?,requester=?,needs=?,effort=?,due_at=?,snoozed_until=?,next_action=?,thread_id=?,t3code_thread_id=?,t3code_open_url=?,work_ref=?,created_by=?,updated_at=? WHERE ticket_id=?`,
      )
      .run(
        t.title, t.body, t.status, t.priority, t.kind, t.bucket, t.score, t.project, t.source, t.sourceRef, t.permalink,
        t.requester, t.needs, t.effort, t.dueAt, t.snoozedUntil, t.nextAction, t.threadId,
        t.t3codeThreadId, t.t3codeOpenUrl,
        t.workRef, t.createdBy, t.updatedAt, t.ticketId,
      );
    this.searchIndexer?.reindexTicket(t.ticketId);
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
    emit("ticket.transitioned", { ticket: updated, from: prev.status, to: toStatus });
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
      t3codeThreadId: input.t3codeThreadId !== undefined ? input.t3codeThreadId : prev.t3codeThreadId,
      t3codeOpenUrl: input.t3codeOpenUrl !== undefined ? input.t3codeOpenUrl : prev.t3codeOpenUrl,
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
      model: input.model === undefined ? "devstral-2512" : input.model,
      runner: validatedRunner(input.runner ?? null),
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
        `INSERT INTO loops (loop_id,name,description,prompt,enabled,interval_minutes,active_days,active_start_hour,active_end_hour,timezone,codex_home,profile,model,runner,thread_id,thread_project,thread_open_url,last_run_at,last_status,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        loop.loopId, loop.name, loop.description, loop.prompt, loop.enabled ? 1 : 0,
        loop.intervalMinutes, loop.activeDays, loop.activeStartHour, loop.activeEndHour,
        loop.timezone, loop.codexHome, loop.profile, loop.model, loop.runner, loop.threadId, loop.threadProject,
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
      runner: input.runner !== undefined ? validatedRunner(input.runner) : prev.runner,
      threadId: input.threadId !== undefined ? input.threadId : prev.threadId,
      threadProject: input.threadProject !== undefined ? input.threadProject : prev.threadProject,
      threadOpenUrl: input.threadOpenUrl !== undefined ? input.threadOpenUrl : prev.threadOpenUrl,
      updatedAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `UPDATE loops SET name=?,description=?,prompt=?,enabled=?,interval_minutes=?,active_days=?,active_start_hour=?,active_end_hour=?,timezone=?,codex_home=?,profile=?,model=?,runner=?,thread_id=?,thread_project=?,thread_open_url=?,updated_at=? WHERE loop_id=?`,
      )
      .run(
        next.name, next.description, next.prompt, next.enabled ? 1 : 0, next.intervalMinutes,
        next.activeDays, next.activeStartHour, next.activeEndHour, next.timezone, next.codexHome,
        next.profile, next.model, next.runner, next.threadId, next.threadProject, next.threadOpenUrl, next.updatedAt,
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
  recordRunStart(loopId: string, trigger: LoopRunTrigger, runner: RunnerName | null = null): LoopRun {
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
      runner,
    };
    this.db
      .prepare(
        `INSERT INTO loop_runs (run_id,loop_id,started_at,finished_at,status,exit_code,summary,trigger,cost_usd,session_id,runner) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(run.runId, run.loopId, run.startedAt, null, run.status, null, "", run.trigger, null, null, run.runner);
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
                cost_usd AS costUsd, session_id AS sessionId, runner
         FROM loop_runs WHERE loop_id = ? ORDER BY started_at DESC LIMIT ?`,
      )
      .all(loopId, limit) as unknown as LoopRun[];
    return rows;
  }

  getLoopCostSummary(warnThreshold = 10, stopThreshold = 30): LoopCostSummary {
    // Vibe reports per-invocation cost, so loop, capture, and enrich rows are totaled here.
    // Conversations API responses do not expose billed cost; estimating browser chat,
    // describe, or brief spend would invent numbers, so those calls are excluded.
    const row = this.db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS total FROM loop_runs`).get() as { total: number };
    const totalCostUsd = row.total;
    return {
      totalCostUsd,
      warning: totalCostUsd >= stopThreshold
        ? `Agent budget exhausted ($${totalCostUsd.toFixed(2)} recorded; hard stop at $${stopThreshold.toFixed(2)}).`
        : totalCostUsd >= warnThreshold
          ? `Agent spend has crossed the $${warnThreshold.toFixed(2)} warning threshold ($${totalCostUsd.toFixed(2)} recorded).`
          : null,
      blocked: totalCostUsd >= stopThreshold,
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

  /** The raw sqlite handle, exposed to extensions (ctx.db) for their own `ext_<name>_` tables. */
  get rawDb(): DatabaseSync {
    return this.db;
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

  setMetaValues(entries: ReadonlyArray<readonly [string, string | null]>): void {
    if (entries.length === 0) return;
    const upsert = this.db.prepare(
      `INSERT INTO boucle_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
    const clear = this.db.prepare(`DELETE FROM boucle_meta WHERE key = ?`);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const [key, value] of entries) {
        if (value === null) clear.run(key);
        else upsert.run(key, value);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
