/**
 * Projects — the gbrain project pages, live.
 *
 * Three panes: list (with staleness signals), the rendered brain page (full
 * markdown, resolved wikilinks, tabs for Timeline / Meetings / Connections), and
 * the Boucle side (open tickets, recently done, per-project activity strip).
 * Deep-linkable: #/projects/<slug>. Status edits + timeline entries write back
 * into the brain files.
 */
import {
  ArrowUpRightIcon,
  CheckIcon,
  FileTextIcon,
  Link2Icon,
  MessageSquareIcon,
  MessageSquarePlusIcon,
  MicIcon,
  PlusIcon,
  SearchIcon,
  SparklesIcon,
  Loader2Icon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  type Backlink,
  type MeetingLite,
  type ProjectDetail,
  type ProjectSummary,
  type Ticket,
  type TimelineEntry,
  api,
} from "./api.ts";
import { openCapture } from "./Capture.tsx";
import { navigate, useHashRoute, useProjects } from "./hooks.ts";
import { isMistralConversationId, useActions } from "./Home.tsx";
import { BrainMarkdown, renderInline, type WikiLinkProps } from "./Markdown.tsx";
import {
  Button,
  Dot,
  NeedsIcon,
  PRIORITY_TONE,
  PROJECT_STATUS_LABEL,
  PROJECT_STATUS_TONE,
  ProjectStatusSelect,
  SourceIcon,
  Status,
  Tag,
  cx,
  formatWhen,
} from "./ui.tsx";

type ProjectFilter = "active" | "scoping" | "backlog" | "on_hold" | "done" | "all";

const FILTERS: Array<{ id: ProjectFilter; label: string }> = [
  { id: "active", label: "Ongoing" },
  { id: "scoping", label: "Scoping" },
  { id: "backlog", label: "Backlog" },
  { id: "on_hold", label: "On hold" },
  { id: "done", label: "Done" },
  { id: "all", label: "All" },
];

function visibleForFilter(project: ProjectSummary, filter: ProjectFilter): boolean {
  if (filter === "all") return true;
  if (filter === "active") return project.status === "in_progress" || project.status === "scoping" || project.status === "on_hold";
  return project.status === filter;
}

function projectCounts(projects: ProjectSummary[]) {
  return {
    active: projects.filter((p) => visibleForFilter(p, "active")).length,
    scoping: projects.filter((p) => p.status === "scoping").length,
    backlog: projects.filter((p) => p.status === "backlog").length,
    on_hold: projects.filter((p) => p.status === "on_hold").length,
    done: projects.filter((p) => p.status === "done").length,
    all: projects.length,
  };
}

function compactPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  const brainIndex = parts.lastIndexOf("fake-brain");
  return brainIndex >= 0 ? parts.slice(brainIndex).join("/") : (parts.at(-1) ?? path);
}

// ===============================
// Staleness — days since the page (file or timeline) last moved
// ===============================

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso.length === 10 ? `${iso}T12:00:00` : iso);
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.floor((Date.now() - ms) / 86_400_000));
}

function ageLabel(days: number): string {
  if (days === 0) return "today";
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  return `${Math.floor(days / 30)}mo`;
}

/** "In progress but untouched for 2+ weeks" is the signal worth coloring. */
function isStale(project: ProjectSummary, days: number | null): boolean {
  if (days === null) return false;
  return (project.status === "in_progress" || project.status === "scoping") && days >= 14;
}

function AgeBadge({ project }: { project: ProjectSummary }) {
  const days = daysSince(project.lastActivityAt);
  if (days === null) return null;
  const stale = isStale(project, days);
  return (
    <span
      title={`Last brain activity: ${ageLabel(days)} ago${stale ? " — stale for an active project" : ""}`}
      className={cx(
        "shrink-0 font-mono text-[10px] tabular-nums",
        stale ? "text-amber-600 dark:text-amber-400" : "text-dim",
      )}
    >
      {ageLabel(days)}
    </span>
  );
}

// ===============================
// Per-project activity strip (resolved tickets per day)
// ===============================

const STRIP_DAYS = 42;
const RAMP = [
  "color-mix(in oklab, var(--fg) 6%, transparent)",
  "color-mix(in oklab, var(--accent) 28%, transparent)",
  "color-mix(in oklab, var(--accent) 50%, transparent)",
  "color-mix(in oklab, var(--accent) 72%, transparent)",
  "var(--accent)",
];

type ActivityRow = { day: string; project: string | null; count: number };

function ActivityStrip({ projectId, activity }: { projectId: string; activity: ActivityRow[] }) {
  const days = useMemo(() => {
    const out: string[] = [];
    const now = Date.now();
    for (let i = STRIP_DAYS - 1; i >= 0; i--) out.push(new Date(now - i * 86_400_000).toISOString().slice(0, 10));
    return out;
  }, []);
  const byDay = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of activity) if (a.project === projectId) m.set(a.day, (m.get(a.day) ?? 0) + a.count);
    return m;
  }, [activity, projectId]);
  const total = useMemo(() => days.reduce((n, d) => n + (byDay.get(d) ?? 0), 0), [days, byDay]);

  return (
    <div className="flex items-center gap-2">
      <span className="grid flex-1 gap-[2px]" style={{ gridTemplateColumns: `repeat(${STRIP_DAYS}, minmax(0, 1fr))` }}>
        {days.map((d) => {
          const v = byDay.get(d) ?? 0;
          return (
            <i
              key={d}
              title={`${d}: ${v} resolved`}
              className="aspect-square rounded-[2px]"
              style={{ background: RAMP[Math.min(v, RAMP.length - 1)] }}
            />
          );
        })}
      </span>
      <span className="shrink-0 font-mono text-[10px] tabular-nums text-dim" title={`${total} items resolved in ${STRIP_DAYS} days`}>
        {total}
      </span>
    </div>
  );
}

// ===============================
// List pane
// ===============================

function ProjectListItem({
  project,
  selected,
  onSelect,
}: {
  project: ProjectSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={cx(
        "w-full rounded-md border px-3 py-2 text-left transition-colors",
        selected ? "border-border-hover bg-bg" : "border-transparent hover:border-border hover:bg-bg",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-sm font-medium text-fg">{project.title}</span>
        <span className="ml-auto inline-flex shrink-0 items-center gap-1.5">
          <AgeBadge project={project} />
          {project.openTicketCount > 0 ? (
            <span className="rounded-md border border-border px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-muted">
              {project.openTicketCount}
            </span>
          ) : null}
        </span>
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <Status tone={PROJECT_STATUS_TONE[project.status]}>{PROJECT_STATUS_LABEL[project.status]}</Status>
        <span className="truncate text-[11px] text-dim">{project.rawStatus}</span>
      </div>
    </button>
  );
}

// ===============================
// Right pane — Boucle tickets
// ===============================

function TicketTask({ ticket, actions }: { ticket: Ticket; actions: ReturnType<typeof useActions> }) {
  return (
    <div className="rounded-lg border border-border bg-bg px-3 py-2">
      <div className="flex items-start gap-2">
        <Tag tone={PRIORITY_TONE[ticket.priority]} className="mt-0.5 shrink-0">
          {ticket.priority}
        </Tag>
        <div className="min-w-0 flex-1">
          <button
            onClick={() => actions.openDetail(ticket.ticketId)}
            className="block w-full truncate text-left text-sm font-medium text-fg hover:underline"
          >
            {ticket.title}
          </button>
          {ticket.nextAction ? <p className="mt-1 line-clamp-2 text-xs text-muted">{ticket.nextAction}</p> : null}
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-dim">
            <SourceIcon source={ticket.source} />
            <span className="inline-flex items-center gap-1">
              <NeedsIcon needs={ticket.needs} /> {ticket.needs}
            </span>
            <span>{formatWhen(ticket.updatedAt)}</span>
          </div>
        </div>
      </div>
      <div className="mt-2 flex items-center justify-end gap-1 border-t border-border pt-2">
        {isMistralConversationId(ticket.threadId) ? (
          <Button title="Open chat" onClick={() => actions.openChat(ticket.threadId)}>
            <MessageSquareIcon className="size-3.5" /> chat
          </Button>
        ) : (
          <Button variant="outline" title="Start chat" onClick={() => actions.startChat(ticket.ticketId)}>
            <MessageSquarePlusIcon className="size-3.5" /> Start
          </Button>
        )}
        <Button title="Mark done" onClick={() => actions.done(ticket.ticketId)}>
          <CheckIcon className="size-3.5" /> Done
        </Button>
      </div>
    </div>
  );
}

// ===============================
// Detail tabs
// ===============================

type DetailTab = "overview" | "timeline" | "meetings" | "connections";

function TimelineView({
  projectId,
  timeline,
  wiki,
  onAdded,
}: {
  projectId: string;
  timeline: TimelineEntry[];
  wiki: WikiLinkProps;
  onAdded: (timeline: TimelineEntry[]) => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    api
      .addTimelineEntry(projectId, t)
      .then((r) => {
        setText("");
        onAdded(r.timeline);
      })
      .catch((e) => alert(String(e.message ?? e)))
      .finally(() => setBusy(false));
  };

  return (
    <div>
      <div className="mb-4 flex items-center gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder="Log something that happened… (written into the gbrain page)"
          className="w-full rounded-md border border-border bg-transparent px-3 py-1.5 text-sm text-fg outline-none placeholder:text-dim focus:border-focus"
        />
        <Button variant="outline" disabled={busy || text.trim().length === 0} onClick={submit}>
          {busy ? <Loader2Icon className="size-3.5 animate-spin" /> : <PlusIcon className="size-3.5" />} Log
        </Button>
      </div>
      {timeline.length === 0 ? <p className="text-sm text-muted">No timeline entries yet.</p> : null}
      <ol className="relative flex flex-col gap-4 border-l border-border pl-4">
        {timeline.map((entry, i) => (
          <li key={i} className="relative">
            <span className="absolute -left-[21.5px] top-1.5 size-[9px] rounded-full border-2 border-surface bg-dim" />
            {entry.dateLabel ? (
              <div className="font-mono text-[11px] tabular-nums text-dim">{entry.dateLabel}</div>
            ) : null}
            <div className="text-[13px] leading-relaxed text-fg">{renderInline(entry.text, wiki)}</div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function MeetingsView({ meetings }: { meetings: MeetingLite[] }) {
  if (meetings.length === 0) {
    return <p className="text-sm text-muted">No recorded meetings reference this project yet.</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      {meetings.map((m) => (
        <button
          key={m.file}
          onClick={() => navigate("#/meetings")}
          className="rounded-lg border border-border bg-bg px-3 py-2.5 text-left hover:border-border-hover"
        >
          <div className="flex items-center gap-2">
            <MicIcon className="size-3.5 shrink-0 text-dim" />
            <span className="truncate text-sm font-medium text-fg">{m.title}</span>
            {m.date ? (
              <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-dim">{m.date.slice(0, 10)}</span>
            ) : null}
          </div>
          {m.summary ? <p className="mt-1 line-clamp-2 text-xs text-muted">{m.summary}</p> : null}
          {m.actionItems.length > 0 ? (
            <p className="mt-1 text-[11px] text-dim">{m.actionItems.length} action item{m.actionItems.length > 1 ? "s" : ""}</p>
          ) : null}
        </button>
      ))}
    </div>
  );
}

const BACKLINK_GROUPS = ["people", "meetings", "projects", "companies", "concepts", "ideas"] as const;

function ConnectionsView({ backlinks, wiki }: { backlinks: Backlink[]; wiki: WikiLinkProps }) {
  const grouped = useMemo(() => {
    const m = new Map<string, Backlink[]>();
    for (const link of backlinks) {
      const prefix = link.fromSlug.split("/")[0] ?? "other";
      const key = (BACKLINK_GROUPS as readonly string[]).includes(prefix) ? prefix : "other";
      m.set(key, [...(m.get(key) ?? []), link]);
    }
    return m;
  }, [backlinks]);

  if (backlinks.length === 0) {
    return <p className="text-sm text-muted">Nothing in the brain points here yet (or gbrain is unreachable).</p>;
  }
  return (
    <div className="flex flex-col gap-5">
      {[...BACKLINK_GROUPS, "other"].map((group) => {
        const links = grouped.get(group);
        if (!links || links.length === 0) return null;
        return (
          <section key={group}>
            <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
              {group} <span className="font-mono text-dim">{links.length}</span>
            </h4>
            <div className="flex flex-col gap-2">
              {links.map((link, i) => (
                <div key={`${link.fromSlug}:${i}`} className="rounded-md border border-border bg-bg px-3 py-2">
                  <div className="flex items-center gap-2">
                    {renderInline(`[[${link.fromSlug}]]`, wiki)}
                    <span className="ml-auto text-[10px] text-dim">{link.linkType}</span>
                  </div>
                  {link.context ? <p className="mt-1 line-clamp-2 text-xs text-dim">…{link.context}…</p> : null}
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

// ===============================
// Page
// ===============================

export function Projects() {
  const { projects, status, refresh } = useProjects();
  const hash = useHashRoute();
  const routeId = useMemo(() => {
    const m = /^#\/projects\/([^/?]+)/.exec(hash);
    return m?.[1] ? decodeURIComponent(m[1]) : null;
  }, [hash]);

  const [filter, setFilter] = useState<ProjectFilter>("active");
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<DetailTab>("overview");
  const [activity, setActivity] = useState<ActivityRow[]>([]);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [detailFor, setDetailFor] = useState<string | null>(null);
  const [briefBusy, setBriefBusy] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  const detailCache = useRef(new Map<string, ProjectDetail>());
  const actions = useActions(refresh);

  useEffect(() => {
    api.activity(STRIP_DAYS).then(setActivity).catch(() => {});
  }, []);

  const counts = useMemo(() => projectCounts(projects), [projects]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return projects.filter((project) => {
      if (!visibleForFilter(project, filter)) return false;
      if (!needle) return true;
      return [project.title, project.projectId, project.summary, project.currentState, project.nextMilestone]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(needle));
    });
  }, [filter, projects, query]);

  const selected = useMemo(() => {
    if (routeId) {
      const explicit = projects.find((project) => project.projectId === routeId);
      if (explicit) return explicit;
    }
    return filtered[0] ?? projects[0] ?? null;
  }, [filtered, projects, routeId]);

  // A wikilink/deep-link may select a project the current filter hides — widen so the list shows it.
  useEffect(() => {
    if (selected && !visibleForFilter(selected, filter) && routeId === selected.projectId) setFilter("all");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeId]);

  const select = (id: string) => {
    setTab("overview");
    setShowResolved(false);
    navigate(`#/projects/${encodeURIComponent(id)}`);
  };

  // Fetch the heavy payload on selection (cached per slug for this visit).
  useEffect(() => {
    const id = selected?.projectId ?? null;
    setDetailFor(id);
    if (!id) {
      setDetail(null);
      return;
    }
    const cached = detailCache.current.get(id);
    if (cached) {
      setDetail(cached);
      return;
    }
    setDetail(null);
    let alive = true;
    api
      .projectDetail(id)
      .then((d) => {
        detailCache.current.set(id, d);
        if (alive) setDetail(d);
      })
      .catch(() => {
        if (alive) setDetail({ page: null, backlinks: [], meetings: [], resolvedTickets: [] });
      });
    return () => {
      alive = false;
    };
  }, [selected?.projectId]);

  const knownProjects = useMemo(() => new Set(projects.map((p) => p.projectId)), [projects]);
  const wiki: WikiLinkProps = useMemo(
    () => ({ knownProjects, onOpenProject: select }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [knownProjects],
  );

  const setStatus = (id: string, s: ProjectSummary["status"]) => {
    api.setProjectStatus(id, s).then(refresh).catch((e) => alert(String(e.message ?? e)));
  };

  const brief = () => {
    if (!selected || briefBusy) return;
    setBriefBusy(true);
    api
      .briefProject(selected.projectId)
      .then((r) => window.location.assign(r.openUrl))
      .catch((e) => alert(`Brief failed: ${e.message ?? e}`))
      .finally(() => setBriefBusy(false));
  };

  const onTimelineAdded = (timeline: TimelineEntry[]) => {
    if (!detail || !detailFor) return;
    const next: ProjectDetail = { ...detail, page: detail.page ? { ...detail.page, timeline } : detail.page };
    detailCache.current.set(detailFor, next);
    setDetail(next);
    refresh();
  };

  const detailLoading = selected !== null && detail === null;
  const timeline = detail?.page?.timeline ?? [];
  const tabs: Array<{ id: DetailTab; label: string; count: number | null }> = [
    { id: "overview", label: "Overview", count: null },
    { id: "timeline", label: "Timeline", count: timeline.length },
    { id: "meetings", label: "Meetings", count: detail?.meetings.length ?? 0 },
    { id: "connections", label: "Connections", count: detail?.backlinks.length ?? 0 },
  ];

  return (
    <div className="mx-auto flex min-h-full w-full max-w-7xl flex-col px-4 py-6 sm:px-6 sm:py-8">
      <header className="mb-5 flex flex-wrap items-center gap-3">
        <h1 className="text-[22px] font-bold tracking-tight text-fg">Projects</h1>
        <span className="font-mono text-xs tabular-nums text-dim">{counts.active} ongoing</span>
      </header>

      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="inline-flex flex-wrap rounded-full border border-border bg-side p-0.5">
          {FILTERS.map((item) => (
            <button
              key={item.id}
              onClick={() => setFilter(item.id)}
              className={cx(
                "rounded-full px-3 py-1 text-xs transition-colors",
                filter === item.id
                  ? "bg-surface font-semibold text-fg shadow-[var(--shadow)]"
                  : "text-muted hover:text-fg",
              )}
            >
              {item.label} <span className="ml-1 tabular-nums text-dim">{counts[item.id]}</span>
            </button>
          ))}
        </div>
        <label className="relative lg:ml-auto">
          <SearchIcon className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-dim" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search projects"
            className="w-full rounded-md border border-border bg-transparent py-1.5 pl-7 pr-2 text-sm text-fg outline-none placeholder:text-dim focus:border-focus lg:w-72"
          />
        </label>
      </div>

      {status === "error" ? (
        <div className="mb-4 flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm text-danger">
          <Dot tone="danger" />
          Could not load gbrain projects.
        </div>
      ) : null}

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[240px_minmax(0,1fr)_280px] xl:grid-cols-[260px_minmax(0,1fr)_320px]">
        <aside className="min-h-0 rounded-lg border border-border bg-surface p-2">
          <div className="flex max-h-[75vh] flex-col gap-1 overflow-auto pr-1">
            {filtered.map((project) => (
              <ProjectListItem
                key={project.projectId}
                project={project}
                selected={selected?.projectId === project.projectId}
                onSelect={() => select(project.projectId)}
              />
            ))}
            {filtered.length === 0 ? (
              <p className="px-3 py-8 text-center text-sm text-muted">No projects in this view.</p>
            ) : null}
          </div>
        </aside>

        <main className="min-w-0 rounded-lg border border-border bg-surface p-5">
          {selected ? (
            <>
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-60 flex-1">
                  <div className="mb-2 flex flex-wrap items-center gap-2.5">
                    <ProjectStatusSelect value={selected.status} onChange={(s) => setStatus(selected.projectId, s)} />
                    <span className="text-xs text-dim" title="Raw status in the gbrain frontmatter">
                      gbrain: {selected.rawStatus}
                    </span>
                    {selected.blockedBy ? (
                      <span className="text-xs text-danger" title={selected.blockedBy}>
                        ⛔ {selected.blockedBy}
                      </span>
                    ) : null}
                  </div>
                  <h2 className="text-xl font-semibold tracking-tight text-fg">{selected.title}</h2>
                  <p className="mt-1 text-sm text-muted">{selected.summary ?? "No project summary yet."}</p>
                  {selected.owners.length > 0 ? (
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {selected.owners.map((owner) => (
                        <Tag key={owner}>{owner}</Tag>
                      ))}
                    </div>
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-col items-end gap-2">
                  <div className="flex items-center gap-1.5">
                    <Button variant="outline" title="Capture an item in this project" onClick={() => openCapture(selected.projectId)}>
                      <PlusIcon className="size-3.5" /> Item
                    </Button>
                    <Button
                      variant="outline"
                      title="Spawn a chat that reads the brain + tickets and briefs you on this project"
                      disabled={briefBusy}
                      onClick={brief}
                    >
                      {briefBusy ? <Loader2Icon className="size-3.5 animate-spin" /> : <SparklesIcon className="size-3.5" />} Brief me
                    </Button>
                  </div>
                  {selected.brainPath ? (
                    <span className="rounded-md border border-border px-2 py-1 font-mono text-[10px] text-dim">
                      {compactPath(selected.brainPath)}
                    </span>
                  ) : null}
                  {selected.links.length > 0 ? (
                    <div className="flex flex-col items-end gap-1">
                      {selected.links.map((link) => (
                        <a
                          key={`${link.label}:${link.value}`}
                          href={link.value.startsWith("http") ? link.value : undefined}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex max-w-64 items-center gap-1 text-xs text-link hover:underline"
                        >
                          <Link2Icon className="size-3 shrink-0" />
                          <span className="truncate">{link.label}: {link.value}</span>
                          {link.value.startsWith("http") ? <ArrowUpRightIcon className="size-3 shrink-0" /> : null}
                        </a>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>

              <nav className="mt-5 flex items-center gap-1 border-b border-border">
                {tabs.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setTab(t.id)}
                    className={cx(
                      "-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] font-medium",
                      tab === t.id
                        ? "border-fg text-fg"
                        : "border-transparent text-muted hover:text-fg",
                    )}
                  >
                    {t.label}
                    {t.count !== null && t.count > 0 ? (
                      <span className="font-mono text-[10px] tabular-nums text-dim">{t.count}</span>
                    ) : null}
                  </button>
                ))}
              </nav>

              <div className="max-h-[62vh] overflow-auto pr-1 pt-4">
                {detailLoading ? (
                  <p className="flex items-center gap-2 py-8 text-sm text-muted">
                    <Loader2Icon className="size-4 animate-spin" /> Reading the brain…
                  </p>
                ) : null}
                {!detailLoading && tab === "overview" ? (
                  detail?.page ? (
                    <BrainMarkdown text={detail.page.body} wiki={wiki} skipSections={["Timeline"]} />
                  ) : (
                    <p className="py-6 text-sm text-muted">
                      No gbrain page for this project yet — it only exists as Boucle tickets. Create
                      <code className="mx-1 rounded-sm bg-fg/[0.07] px-1 font-mono text-xs">brain/projects/{selected.projectId}.md</code>
                      to give it one.
                    </p>
                  )
                ) : null}
                {!detailLoading && tab === "timeline" && detail?.page ? (
                  <TimelineView projectId={selected.projectId} timeline={timeline} wiki={wiki} onAdded={onTimelineAdded} />
                ) : null}
                {!detailLoading && tab === "timeline" && detail && !detail.page ? (
                  <p className="py-6 text-sm text-muted">No gbrain page — no timeline to write to.</p>
                ) : null}
                {!detailLoading && tab === "meetings" && detail ? <MeetingsView meetings={detail.meetings} /> : null}
                {!detailLoading && tab === "connections" && detail ? (
                  <ConnectionsView backlinks={detail.backlinks} wiki={wiki} />
                ) : null}
              </div>
            </>
          ) : (
            <p className="text-sm text-muted">Loading projects…</p>
          )}
        </main>

        <aside className="min-w-0 rounded-lg border border-border bg-surface p-4">
          {selected ? (
            <div className="mb-4 border-b border-border pb-3">
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
                What moved · {STRIP_DAYS}d
              </div>
              <ActivityStrip projectId={selected.projectId} activity={activity} />
            </div>
          ) : null}
          <div className="mb-3 flex items-center gap-2">
            <FileTextIcon className="size-4 text-dim" />
            <h3 className="text-sm font-semibold text-fg">Open items</h3>
            <span className="ml-auto font-mono text-xs tabular-nums text-dim">{selected?.openTicketCount ?? 0}</span>
          </div>
          <div className="flex max-h-[46vh] flex-col gap-2 overflow-auto pr-1">
            {selected?.openTickets.map((ticket) => (
              <TicketTask key={ticket.ticketId} ticket={ticket} actions={actions} />
            ))}
            {selected && selected.openTickets.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted">
                No open Boucle tickets for this project.
              </p>
            ) : null}
          </div>
          {detail && detail.resolvedTickets.length > 0 ? (
            <div className="mt-4 border-t border-border pt-3">
              <button
                onClick={() => setShowResolved((v) => !v)}
                className="text-xs font-semibold uppercase tracking-wide text-muted hover:text-fg"
              >
                {showResolved ? "▾" : "▸"} Recently resolved ({detail.resolvedTickets.length})
              </button>
              {showResolved ? (
                <div className="mt-2 flex flex-col gap-1">
                  {detail.resolvedTickets.map((t) => (
                    <div key={t.ticketId} className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-fg/[0.04]">
                      <Tag tone={t.status === "done" ? "success" : "neutral"}>{t.status}</Tag>
                      <button
                        onClick={() => actions.openDetail(t.ticketId)}
                        className="min-w-0 truncate text-left text-xs text-muted hover:text-fg hover:underline"
                        title={t.title}
                      >
                        {t.title}
                      </button>
                      <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-dim">
                        {t.updatedAt.slice(0, 10)}
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
