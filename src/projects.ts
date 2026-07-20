/**
 * Projects — read/write bridge between Boucle and the gbrain `projects/` pages.
 *
 * The markdown files stay the single source of truth: list/detail parse them off
 * disk, and the mutations (status, timeline entries) edit the files in place then
 * schedule a `gbrain import` + `embed --stale` so the brain DB catches up.
 * Backlinks come from the gbrain CLI (link graph lives in the DB, not the files)
 * and are cached in-process.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";

import { resolveBrainDir } from "./config.ts";
import { isValidProjectId } from "./project-id.ts";
import type { ProjectMeta, Ticket } from "./store.ts";

const BRAIN_DIR = resolveBrainDir();
const BRAIN_PROJECTS_DIR = join(BRAIN_DIR, "projects");
const GBRAIN_NOOP = join(import.meta.dirname, "..", "scripts", "gbrain-noop");

export type ProjectStatus = "scoping" | "in_progress" | "backlog" | "on_hold" | "done" | "archived";

export interface TimelineEntry {
  /** Sortable ISO date extracted from the entry, when the bullet is dated. */
  date: string | null;
  /** The bold date label verbatim (may be a range like "2025-11-21 – 12-03"). */
  dateLabel: string | null;
  text: string;
}

export interface ProjectSummary {
  projectId: string;
  title: string;
  status: ProjectStatus;
  rawStatus: string;
  /** Manual position in the overlay; null when it has never been reordered. */
  sortOrder: number | null;
  summary: string | null;
  currentState: string | null;
  nextMilestone: string | null;
  blockedBy: string | null;
  owners: string[];
  links: Array<{ label: string; value: string }>;
  brainPath: string;
  /** Date of the newest dated `## Timeline` entry. */
  lastTimelineAt: string | null;
  /** The page file's mtime — any edit (chief loop, Boucle, hand) counts as brain activity. */
  fileUpdatedAt: string | null;
  /** max(lastTimelineAt, fileUpdatedAt) — the staleness signal. */
  lastActivityAt: string | null;
  timelineCount: number;
  openTickets: Ticket[];
  openTicketCount: number;
}

/** The heavy per-project payload — fetched on selection, not in the polled list. */
export interface ProjectPage {
  projectId: string;
  /** Full markdown body (frontmatter stripped). */
  body: string;
  /** All `## Timeline` entries, newest first. */
  timeline: TimelineEntry[];
}

export interface Backlink {
  fromSlug: string;
  linkType: string;
  context: string;
}

const STATUS_ALIASES: Record<string, ProjectStatus> = {
  active: "in_progress",
  "active-experiment": "in_progress",
  demo: "in_progress",
  "demo-ready": "in_progress",
  hiring: "in_progress",
  in_progress: "in_progress",
  kickoff: "in_progress",
  live: "in_progress",
  "pre-launch": "in_progress",
  production: "in_progress",
  upcoming: "in_progress",
  scoping: "scoping",
  discovery: "scoping",
  backlog: "backlog",
  proposed: "backlog",
  on_hold: "on_hold",
  dormant: "on_hold",
  blocked: "on_hold",
  wrapped: "done",
  decided: "done",
  done: "done",
  archived: "archived",
};

function normalizeStatus(raw: string | null): ProjectStatus {
  if (!raw) return "backlog";
  return STATUS_ALIASES[raw.trim().toLowerCase()] ?? "backlog";
}

function stripWikiLinks(text: string): string {
  return text.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, page: string, label?: string) => label ?? page);
}

function parseFrontmatter(markdown: string): Record<string, string> {
  if (!markdown.startsWith("---\n")) return {};
  const end = markdown.indexOf("\n---", 4);
  if (end === -1) return {};
  const fm = markdown.slice(4, end).split("\n");
  const out: Record<string, string> = {};
  for (const line of fm) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (match?.[1] && match[2] !== undefined) out[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

/** Body below the frontmatter block (the whole file when there is none). */
function stripFrontmatter(markdown: string): string {
  if (!markdown.startsWith("---\n")) return markdown;
  const end = markdown.indexOf("\n---", 4);
  if (end === -1) return markdown;
  return markdown.slice(markdown.indexOf("\n", end + 1) + 1).replace(/^\n+/, "");
}

function parseOwners(raw: string | undefined): string[] {
  if (!raw) return [];
  const inline = /^\[(.*)\]$/.exec(raw.trim());
  const body = inline?.[1] ?? raw;
  return body
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

function extractSection(markdown: string, heading: string): string | null {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) return null;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    body.push(line);
  }
  const text = body.join("\n").trim();
  return text.length > 0 ? text : null;
}

/** The `- **Label:** value` bullet matching one of `labels`; no fallback. */
function labeledBullet(section: string | null, labels: string[]): string | null {
  if (!section) return null;
  const labelPart = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const re = new RegExp(`^- \\*\\*(?:${labelPart})(?::)?\\*\\*:?\\s*(.+)$`, "im");
  const labeled = re.exec(section);
  return labeled?.[1] ? stripWikiLinks(labeled[1].trim()) : null;
}

/** Like labeledBullet, but falls back to the section's first bullet (for "current state"). */
function firstBullet(section: string | null, labels: string[]): string | null {
  const labeled = labeledBullet(section, labels);
  if (labeled) return labeled;
  if (!section) return null;
  const bullet = /^- (.+)$/m.exec(section);
  return bullet?.[1] ? stripWikiLinks(bullet[1].replace(/\*\*/g, "").trim()) : null;
}

function extractSummary(markdown: string): string | null {
  const quote = /^>\s*(.+)$/m.exec(markdown);
  if (quote?.[1]) return stripWikiLinks(quote[1].trim());
  const afterTitle = markdown.split(/^# .+$/m)[1];
  if (!afterTitle) return null;
  const paragraph = afterTitle
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("##") && !line.startsWith("---"))[0];
  return paragraph ? stripWikiLinks(paragraph.replace(/^>\s*/, "")) : null;
}

function extractTitle(markdown: string, fallback: string): string {
  const match = /^#\s+(.+)$/m.exec(markdown);
  return match?.[1] ? stripWikiLinks(match[1].trim()) : fallback;
}

/**
 * Parse the `## Timeline` section into entries, newest first. House format is one
 * bullet per event, oldest first: `- **YYYY-MM-DD** | text` (continuation lines
 * indent under their bullet). Undated bullets are kept, sorted last.
 */
function parseTimeline(markdown: string): TimelineEntry[] {
  const section = extractSection(markdown, "Timeline");
  if (!section) return [];
  const entries: TimelineEntry[] = [];
  for (const line of section.split("\n")) {
    const bullet = /^- (.+)$/.exec(line);
    if (!bullet?.[1]) {
      // Continuation line — glue onto the previous entry.
      const last = entries[entries.length - 1];
      if (last && line.trim().length > 0) last.text += ` ${line.trim()}`;
      continue;
    }
    const dated = /^\*\*([^*]+)\*\*\s*\|\s*(.+)$/.exec(bullet[1]);
    if (dated?.[1] && dated[2]) {
      const label = dated[1].trim();
      const iso = /\d{4}-\d{2}-\d{2}/.exec(label)?.[0] ?? null;
      entries.push({ date: iso, dateLabel: label, text: dated[2].trim() });
    } else {
      entries.push({ date: null, dateLabel: null, text: bullet[1].replace(/\*\*/g, "").trim() });
    }
  }
  // Newest first. Loops append out of chronological order sometimes, so sort by
  // date (not file position); ties/undated fall back to later-in-file-first.
  return entries
    .map((entry, i) => ({ entry, i }))
    .sort((a, b) => {
      if (a.entry.date && b.entry.date && a.entry.date !== b.entry.date) {
        return b.entry.date.localeCompare(a.entry.date);
      }
      if (a.entry.date !== null && b.entry.date === null) return -1;
      if (a.entry.date === null && b.entry.date !== null) return 1;
      return b.i - a.i;
    })
    .map(({ entry }) => entry);
}

function extractLinks(frontmatter: Record<string, string>): Array<{ label: string; value: string }> {
  const links: Array<{ label: string; value: string }> = [];
  for (const key of ["repo", "url", "source_doc", "launch_deck_doc", "deployment_playbook_doc"]) {
    const value = frontmatter[key];
    if (value) links.push({ label: key.replace(/_/g, " "), value });
  }
  return links;
}

// Slug rules live in project-id.ts so the store and HTTP layers can share them
// without pulling in this module's filesystem and shell dependencies.
export { normalizeProjectId } from "./project-id.ts";
export { isValidProjectId };

function projectFilePath(projectId: string): string {
  return join(BRAIN_PROJECTS_DIR, `${projectId}.md`);
}

export function listProjects(
  openTickets: Ticket[],
  overlay: Map<string, ProjectMeta> = new Map(),
): ProjectSummary[] {
  const ticketsByProject = new Map<string, Ticket[]>();
  for (const ticket of openTickets) {
    if (!ticket.project) continue;
    ticketsByProject.set(ticket.project, [...(ticketsByProject.get(ticket.project) ?? []), ticket]);
  }

  const projects = readdirSync(BRAIN_PROJECTS_DIR)
    .filter((file) => file.endsWith(".md") && file !== "README.md")
    .map((file) => {
      const projectId = basename(file, ".md");
      const absPath = join(BRAIN_PROJECTS_DIR, file);
      // Expose the path relative to the brain root's parent ("fake-brain/projects/x.md"):
      // absolute paths would leak the machine's home directory into API responses.
      const brainPath = relative(dirname(BRAIN_DIR), absPath);
      const markdown = readFileSync(absPath, "utf8");
      const frontmatter = parseFrontmatter(markdown);
      const rawStatus = frontmatter.status ?? "backlog";
      const state = extractSection(markdown, "State");
      const open = ticketsByProject.get(projectId) ?? [];
      const meta = overlay.get(projectId);
      const timeline = parseTimeline(markdown);
      const lastTimelineAt = timeline.find((e) => e.date !== null)?.date ?? null;
      let fileUpdatedAt: string | null = null;
      try {
        fileUpdatedAt = statSync(absPath).mtime.toISOString();
      } catch {
        /* stat raced a rename — leave null */
      }
      // ISO strings compare lexicographically, date-only vs datetime included.
      const lastActivityAt =
        lastTimelineAt && fileUpdatedAt
          ? (lastTimelineAt > fileUpdatedAt ? lastTimelineAt : fileUpdatedAt)
          : (lastTimelineAt ?? fileUpdatedAt);
      return {
        projectId,
        title: extractTitle(markdown, projectId),
        // The file is the source of truth — overrides only exist for ticket-only projects.
        status: normalizeStatus(rawStatus),
        rawStatus,
        sortOrder: meta?.sortOrder ?? null,
        summary: extractSummary(markdown),
        currentState: firstBullet(state, ["Stage", "State", "Current state", "Status"]),
        nextMilestone: labeledBullet(state, ["Expected output", "Next", "Next milestone", "Target"]),
        blockedBy: labeledBullet(state, ["Blocked by", "Blocker", "Blocked"]),
        owners: parseOwners(frontmatter.owners),
        links: extractLinks(frontmatter),
        brainPath,
        lastTimelineAt,
        fileUpdatedAt,
        lastActivityAt,
        timelineCount: timeline.length,
        openTickets: open,
        openTicketCount: open.length,
      } satisfies ProjectSummary;
    });

  for (const [projectId, openTicketsForProject] of ticketsByProject) {
    if (projects.some((p) => p.projectId === projectId)) continue;
    const meta = overlay.get(projectId);
    const statusOverride = meta?.statusOverride ?? null;
    projects.push({
      projectId,
      title: projectId,
      status: normalizeStatus(statusOverride) ?? "backlog",
      rawStatus: "ticket-only",
      sortOrder: meta?.sortOrder ?? null,
      summary: "No gbrain project page found yet.",
      currentState: null,
      nextMilestone: openTicketsForProject[0]?.nextAction ?? null,
      blockedBy: null,
      owners: [],
      links: [],
      brainPath: "",
      lastTimelineAt: null,
      fileUpdatedAt: null,
      lastActivityAt: null,
      timelineCount: 0,
      openTickets: openTicketsForProject,
      openTicketCount: openTicketsForProject.length,
    });
  }

  const statusRank: Record<ProjectStatus, number> = {
    in_progress: 0,
    scoping: 1,
    on_hold: 2,
    backlog: 3,
    done: 4,
    archived: 5,
  };
  return projects.sort((a, b) => {
    // Manual order (overlay) wins whenever both sides have been placed; unplaced projects fall to the end.
    if (a.sortOrder !== null || b.sortOrder !== null) {
      if (a.sortOrder === null) return 1;
      if (b.sortOrder === null) return -1;
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    }
    if (a.openTicketCount !== b.openTicketCount) return b.openTicketCount - a.openTicketCount;
    if (statusRank[a.status] !== statusRank[b.status]) return statusRank[a.status] - statusRank[b.status];
    return a.title.localeCompare(b.title);
  });
}

/** Full markdown body + parsed timeline for one project, or null when no page exists. */
export function getProjectPage(projectId: string): ProjectPage | null {
  if (!isValidProjectId(projectId)) return null;
  const path = projectFilePath(projectId);
  if (!existsSync(path)) return null;
  const markdown = readFileSync(path, "utf8");
  return {
    projectId,
    body: stripFrontmatter(markdown),
    timeline: parseTimeline(markdown),
  };
}

// ===============================
// Write-back — Boucle edits the brain files, then reindexes gbrain
// ===============================

/**
 * The server may run under launchd, whose PATH lacks the interactive-shell
 * additions (~/.zshrc) — and gbrain is a bun script, so bun must be on PATH too.
 * Prefix commands with ~/.bun/bin; ~/.zshenv (read by `zsh -c`) still provides
 * the embedding API key.
 */
function gbrainCmd(args: string): string {
  return `export PATH="${join(homedir(), ".bun", "bin")}:$PATH"; gbrain ${args}`;
}

let reindexTimer: ReturnType<typeof setTimeout> | null = null;
let searchReindexer: (() => void) | null = null;

export function setBrainSearchReindexer(reindex: () => void): void {
  searchReindexer = reindex;
}

/** Fire-and-forget local reindex hook, debounced to follow project edits. */
export function scheduleBrainReindex(): void {
  searchReindexer?.();
  if (reindexTimer) clearTimeout(reindexTimer);
  reindexTimer = setTimeout(() => {
    reindexTimer = null;
    const child = spawn(GBRAIN_NOOP, ["import", BRAIN_DIR, "embed", "--stale"], {
      stdio: "ignore",
      detached: true,
    });
    child.unref();
  }, 3_000);
  if (typeof reindexTimer.unref === "function") reindexTimer.unref();
}

/**
 * Write a status change into the page frontmatter. Rich raw statuses ("production",
 * "live"…) are preserved as long as they normalize to the requested status — the
 * file only changes when the pick actually moves the project to another bucket.
 */
export function writeProjectStatus(projectId: string, status: ProjectStatus): "written" | "noop" | "no_page" {
  if (!isValidProjectId(projectId)) return "no_page";
  const path = projectFilePath(projectId);
  if (!existsSync(path)) return "no_page";
  const markdown = readFileSync(path, "utf8");
  const frontmatter = parseFrontmatter(markdown);
  if (normalizeStatus(frontmatter.status ?? null) === status) return "noop";

  let next: string;
  if (!markdown.startsWith("---\n")) {
    next = `---\nstatus: ${status}\n---\n\n${markdown}`;
  } else if (/^status:.*$/m.test(markdown.slice(4, markdown.indexOf("\n---", 4)))) {
    const end = markdown.indexOf("\n---", 4);
    const fm = markdown.slice(4, end).replace(/^status:.*$/m, `status: ${status}`);
    next = `---\n${fm}${markdown.slice(end)}`;
  } else {
    next = `---\nstatus: ${status}\n${markdown.slice(4)}`;
  }
  writeFileSync(path, next, "utf8");
  scheduleBrainReindex();
  return "written";
}

/**
 * Append a dated entry to the page's `## Timeline` (created at the end of the file
 * when missing), keeping the house oldest-first order. Returns the new timeline.
 */
export function addTimelineEntry(projectId: string, text: string, date?: string): TimelineEntry[] | null {
  if (!isValidProjectId(projectId)) return null;
  const path = projectFilePath(projectId);
  if (!existsSync(path)) return null;
  const day = date ?? new Date().toISOString().slice(0, 10);
  const entry = `- **${day}** | ${text.trim()}`;

  const markdown = readFileSync(path, "utf8");
  const lines = markdown.split("\n");
  const headingIdx = lines.findIndex((line) => line.trim() === "## Timeline");
  let next: string;
  if (headingIdx === -1) {
    next = `${markdown.replace(/\n+$/, "")}\n\n## Timeline\n${entry}\n`;
  } else {
    // Insert after the section's last non-empty line (before the next `## `).
    let end = lines.length;
    for (let i = headingIdx + 1; i < lines.length; i++) {
      if (lines[i]!.startsWith("## ")) {
        end = i;
        break;
      }
    }
    let insertAt = end;
    while (insertAt > headingIdx + 1 && (lines[insertAt - 1] ?? "").trim().length === 0) insertAt -= 1;
    lines.splice(insertAt, 0, entry);
    next = lines.join("\n");
  }
  writeFileSync(path, next, "utf8");
  scheduleBrainReindex();
  return parseTimeline(next);
}

// ===============================
// Backlinks — the gbrain link graph, via the CLI, cached in-process
// ===============================

const BACKLINK_TTL_MS = 10 * 60_000;
const backlinkCache = new Map<string, { at: number; links: Backlink[] }>();

export function getBacklinks(projectId: string): Promise<Backlink[]> {
  if (!isValidProjectId(projectId)) return Promise.resolve([]);
  const cached = backlinkCache.get(projectId);
  if (cached && Date.now() - cached.at < BACKLINK_TTL_MS) return Promise.resolve(cached.links);
  return new Promise((resolve) => {
    execFile(
      "zsh",
      ["-c", gbrainCmd(`backlinks 'projects/${projectId}' --json`)],
      { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve(cached?.links ?? []);
          return;
        }
        try {
          const rows = JSON.parse(stdout) as Array<{ from_slug: string; link_type: string; context: string | null }>;
          const links = rows
            .filter((r) => r.from_slug !== `projects/${projectId}`)
            .map((r) => ({ fromSlug: r.from_slug, linkType: r.link_type, context: r.context ?? "" }));
          backlinkCache.set(projectId, { at: Date.now(), links });
          resolve(links);
        } catch {
          resolve(cached?.links ?? []);
        }
      },
    );
  });
}
