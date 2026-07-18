/**
 * Home — "mon cerveau" : one card per active project (its direction + everything
 * attached to it: tasks, ideas, convs, scopes), a quick-capture bar, an activity
 * grid of what actually moved, and a sleeping backlog that stays out of sight.
 */
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ClipboardListIcon,
  ClockIcon,
  CopyIcon,
  InboxIcon,
  LightbulbIcon,
  MicIcon,
  MessageSquareIcon,
  MessageSquarePlusIcon,
  PlusIcon,
  RotateCcwIcon,
  SunriseIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  api,
  type ProjectStatus,
  type ProjectSummary,
  type Ticket,
  type TicketBucket,
  type TicketPriority,
} from "./api.ts";
import { openCapture } from "./Capture.tsx";
import { navigate, useOpenTickets, useProjects } from "./hooks.ts";
import {
  BUCKET_RANK,
  BucketSelect,
  Button,
  Dot,
  KindIcon,
  ProjectStatusSelect,
  Switch,
  Tag,
  cx,
} from "./ui.tsx";

/**
 * Mistral conversation IDs are UUIDs. Gate the chat affordance so old foreign
 * values that may have landed in threadId do not become broken internal links.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isMistralConversationId(id?: string | null): id is string {
  return typeof id === "string" && UUID_RE.test(id);
}

/** Rank items inside a project: by bucket (urgent first), untriaged last, then score. */
function byBucket(a: Ticket, b: Ticket): number {
  const ra = a.bucket ? BUCKET_RANK[a.bucket] : 99;
  const rb = b.bucket ? BUCKET_RANK[b.bucket] : 99;
  if (ra !== rb) return ra - rb;
  return b.score - a.score;
}

/** Sleeping = out of sight by default: snoozed, or parked in "maybe one day". */
function isDormant(t: Ticket): boolean {
  return t.status === "snoozed" || t.bucket === "maybe_one_day";
}

export function useActions(refresh: () => void) {
  return useMemo(() => {
    const after = (p: Promise<unknown>) => p.then(refresh).catch((e) => alert(String(e.message ?? e)));
    return {
      done: (id: string) => after(api.transition(id, "done")),
      drop: (id: string) => after(api.transition(id, "dropped")),
      snooze: (id: string, days = 1) =>
        after(api.transition(id, "snoozed", new Date(Date.now() + days * 86_400_000).toISOString())),
      wake: (id: string) => after(api.transition(id, "next")),
      setPriority: (id: string, priority: TicketPriority) => after(api.setFields(id, { priority })),
      setBucket: (id: string, bucket: TicketBucket) => after(api.setFields(id, { bucket })),
      openChat: (threadId?: string | null) => {
        if (isMistralConversationId(threadId)) window.location.assign(`/chats/${threadId}`);
      },
      startChat: (id: string) =>
        api
          .spawnChat(id)
          .then((r) => {
            window.location.assign(r.openUrl);
            refresh();
          })
          .catch((e) => alert(`Start chat failed: ${e.message ?? e}`)),
      openDetail: (id: string) => navigate(`#/ticket/${id}`),
    };
  }, [refresh]);
}

type Actions = ReturnType<typeof useActions>;

function AutoCaptureToggle() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    api.loopState().then((s) => setEnabled(s.enabled)).catch(() => setEnabled(false));
  }, []);
  const toggle = () => {
    const next = !(enabled ?? false);
    setEnabled(next);
    api.setLoopState(next).then((s) => setEnabled(s.enabled)).catch(() => setEnabled(!next));
  };
  return (
    <button
      onClick={toggle}
      title="Scheduler master switch — pause/resume all loops"
      className="inline-flex items-center gap-2 text-xs text-muted hover:text-fg"
    >
      <span>Auto-capture</span>
      <Switch on={enabled ?? false} />
    </button>
  );
}

// ===============================
// Activity grid — "ce qui avance"
// ===============================

const ACTIVITY_DAYS = 26;
/** Sequential accent ramp (0 → 4+ items resolved that day). */
const RAMP = [
  "color-mix(in oklab, var(--fg) 6%, transparent)",
  "color-mix(in oklab, var(--accent) 28%, transparent)",
  "color-mix(in oklab, var(--accent) 50%, transparent)",
  "color-mix(in oklab, var(--accent) 72%, transparent)",
  "var(--accent)",
];

type ActivityRow = { day: string; project: string | null; count: number };

function lastDays(n: number): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    out.push(new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

function fmtDay(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function ActivityGrid({
  rows,
  activity,
}: {
  rows: Array<{ id: string | null; label: string }>;
  activity: ActivityRow[];
}) {
  const days = useMemo(() => lastDays(ACTIVITY_DAYS), []);
  const byKey = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of activity) {
      const key = `${a.project ?? ""}|${a.day}`;
      m.set(key, (m.get(key) ?? 0) + a.count);
    }
    return m;
  }, [activity]);
  const totals = useMemo(() => {
    const m = new Map<string | null, number>();
    for (const r of rows) {
      m.set(r.id, days.reduce((n, d) => n + (byKey.get(`${r.id ?? ""}|${d}`) ?? 0), 0));
    }
    return m;
  }, [rows, days, byKey]);

  return (
    <div className="rounded-lg border border-border bg-surface px-4 py-3">
      <div className="flex items-baseline gap-2.5">
        <h3 className="text-xs font-semibold text-fg">What's moving</h3>
        <span className="text-[11px] text-dim">items resolved per project · last {ACTIVITY_DAYS} days</span>
        <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-dim">
          less
          {RAMP.map((c, i) => (
            <i key={i} className="inline-block size-2 rounded-[2px]" style={{ background: c }} />
          ))}
          more
        </span>
      </div>
      <div className="mt-2.5 grid items-center gap-x-3 gap-y-1" style={{ gridTemplateColumns: "max-content 1fr max-content" }}>
        {rows.map((r) => (
          <div key={r.id ?? "__misc"} className="contents">
            <span className="truncate text-[11px] text-muted" style={{ maxWidth: 180 }}>
              {r.label}
            </span>
            <span className="grid gap-[2px]" style={{ gridTemplateColumns: `repeat(${ACTIVITY_DAYS}, minmax(0, 11px))` }}>
              {days.map((d) => {
                const v = byKey.get(`${r.id ?? ""}|${d}`) ?? 0;
                return (
                  <i
                    key={d}
                    title={`${r.label} — ${fmtDay(d)}: ${v} resolved`}
                    className="aspect-square rounded-[2px]"
                    style={{ background: RAMP[Math.min(v, RAMP.length - 1)] }}
                  />
                );
              })}
            </span>
            <span className="text-right text-[11px] tabular-nums text-dim">{totals.get(r.id) ?? 0}</span>
          </div>
        ))}
        <span />
        <span className="flex justify-between text-[10px] text-dim" style={{ maxWidth: ACTIVITY_DAYS * 13 }}>
          <span>{fmtDay(days[0])}</span>
          <span>{fmtDay(days[Math.floor(days.length / 2)])}</span>
          <span>{fmtDay(days[days.length - 1])}</span>
        </span>
        <span />
      </div>
    </div>
  );
}

// ===============================
// Item row
// ===============================

function dueLabel(dueAt: string | null): string | null {
  if (!dueAt) return null;
  const ms = Date.parse(dueAt);
  if (Number.isNaN(ms)) return null;
  const days = (ms - Date.now()) / 86_400_000;
  if (days > 14) return null;
  return new Date(ms).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

function ItemRow({ item, actions, dormant }: { item: Ticket; actions: Actions; dormant?: boolean }) {
  const due = dueLabel(item.dueAt);
  const sleepsUntil =
    item.status === "snoozed" && item.snoozedUntil
      ? new Date(item.snoozedUntil).toLocaleDateString(undefined, { day: "numeric", month: "short" })
      : null;
  return (
    <div className="group/item flex min-h-[34px] items-center gap-2 rounded-md px-2 py-1.5 hover:bg-fg/[0.04]">
      <KindIcon kind={item.kind} className="size-3.5 shrink-0" />
      <button
        onClick={() => actions.openDetail(item.ticketId)}
        className={cx(
          "min-w-0 flex-1 truncate text-left text-[13px] hover:underline",
          dormant ? "text-dim" : item.kind === "idea" ? "text-muted" : "text-fg",
        )}
        title={item.title}
      >
        {item.title}
      </button>
      {due && !dormant ? <span className="shrink-0 text-[11px] font-medium text-danger">{due}</span> : null}
      {sleepsUntil ? <span className="shrink-0 text-[11px] text-dim">💤 {sleepsUntil}</span> : null}
      <span className="hidden shrink-0 group-hover/item:inline-flex">
        <BucketSelect value={item.bucket} onChange={(b) => actions.setBucket(item.ticketId, b)} />
      </span>
      <div className="hidden shrink-0 items-center gap-0.5 group-hover/item:flex">
        {dormant ? (
          <Button title="Wake up — back in the active queue" onClick={() => actions.wake(item.ticketId)}>
            <SunriseIcon className="size-3.5 text-amber-500 dark:text-amber-400" />
          </Button>
        ) : (
          <>
            {isMistralConversationId(item.threadId) ? (
              <Button title="Open Mistral chat" onClick={() => actions.openChat(item.threadId)}>
                <MessageSquareIcon className="size-3.5 text-success" />
              </Button>
            ) : (
              <Button title="Start a describe/work chat" onClick={() => actions.startChat(item.ticketId)}>
                <MessageSquarePlusIcon className="size-3.5" />
              </Button>
            )}
            <Button title="Mark done" onClick={() => actions.done(item.ticketId)}>
              <CheckIcon className="size-3.5" />
            </Button>
            <Button title="Snooze 1 day" onClick={() => actions.snooze(item.ticketId)}>
              <ClockIcon className="size-3.5" />
            </Button>
            <Button title="Snooze 1 week" onClick={() => actions.snooze(item.ticketId, 7)}>
              <ClockIcon className="size-3.5 text-dim" />
              <span className="text-[9px]">7</span>
            </Button>
          </>
        )}
        <Button title="Drop" onClick={() => actions.drop(item.ticketId)}>
          <XIcon className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

// ===============================
// Project card
// ===============================

function ProjectCard({
  title,
  projectId,
  direction,
  status,
  items,
  actions,
  refresh,
  canUp,
  canDown,
  onMove,
  synthetic,
}: {
  title: string;
  projectId: string | null;
  direction: string | null;
  status: ProjectStatus | null;
  items: Ticket[];
  actions: Actions;
  refresh: () => void;
  canUp?: boolean;
  canDown?: boolean;
  onMove?: (dir: -1 | 1) => void;
  synthetic?: boolean;
}) {
  const [showDormant, setShowDormant] = useState(false);
  const active = useMemo(() => items.filter((t) => !isDormant(t)).sort(byBucket), [items]);
  const dormant = useMemo(() => items.filter(isDormant).sort(byBucket), [items]);

  const setStatus = (s: ProjectStatus) => {
    if (!projectId) return;
    api.setProjectStatus(projectId, s).then(refresh).catch((e) => alert(String(e.message ?? e)));
  };

  return (
    <div className={cx("group flex flex-col rounded-lg border bg-surface p-4", synthetic ? "border-dashed border-border" : "border-border")}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <button
              onClick={() => (synthetic ? openCapture() : navigate("#/projects"))}
              className="block max-w-full truncate text-left text-sm font-semibold text-fg hover:underline"
              title={title}
            >
              {title}
            </button>
            <span
              className="ml-auto shrink-0 rounded-md border border-border px-1.5 py-0.5 font-mono text-[10px] text-dim"
              title="Active items in this project"
            >
              {synthetic ? "private" : `${active.length} active`}
            </span>
          </div>
          {status ? (
            <div className="mt-1.5">
              <ProjectStatusSelect value={status} onChange={setStatus} />
            </div>
          ) : null}
          {direction ? (
            <p className="mt-2 flex gap-1.5 text-xs leading-relaxed text-muted" title={direction}>
              <span className="shrink-0">🧭</span>
              <span className="line-clamp-2">{direction.replace(/\*\*|`/g, "")}</span>
            </p>
          ) : null}
        </div>
        {onMove ? (
          <div className="flex shrink-0 flex-col opacity-0 transition-opacity group-hover:opacity-100">
            <button disabled={!canUp} onClick={() => onMove(-1)} className="text-dim hover:text-fg disabled:opacity-20" title="Move up">
              <ChevronUpIcon className="size-4" />
            </button>
            <button disabled={!canDown} onClick={() => onMove(1)} className="text-dim hover:text-fg disabled:opacity-20" title="Move down">
              <ChevronDownIcon className="size-4" />
            </button>
          </div>
        ) : null}
      </div>

      <div className="mt-3 flex flex-col gap-0.5">
        {active.map((item) => (
          <ItemRow key={item.ticketId} item={item} actions={actions} />
        ))}
        {active.length === 0 ? <p className="px-2 py-1.5 text-xs text-dim">Nothing active.</p> : null}
        {showDormant
          ? dormant.map((item) => <ItemRow key={item.ticketId} item={item} actions={actions} dormant />)
          : null}
      </div>

      <div className="mt-3 flex items-center gap-3 border-t border-border pt-2.5">
        <button
          onClick={() => openCapture(projectId)}
          className="inline-flex items-center gap-1 text-xs text-dim hover:text-fg"
        >
          <PlusIcon className="size-3.5" /> item
        </button>
        {dormant.length > 0 ? (
          <button
            onClick={() => setShowDormant((v) => !v)}
            className="ml-auto text-[11px] text-dim hover:text-muted"
          >
            {showDormant ? "▾" : "▸"} {dormant.length} sleeping
          </button>
        ) : null}
      </div>
    </div>
  );
}

// ===============================
// "Tu fais quoi ?" — status report generator
// ===============================

function buildStatus(cards: Array<{ title: string; direction: string | null; items: Ticket[] }>): string {
  const today = new Date().toLocaleDateString(undefined, { day: "numeric", month: "long" });
  const lines: string[] = [`*What I'm on — ${today}*`, ""];
  for (const c of cards) {
    const active = c.items.filter((t) => !isDormant(t)).sort(byBucket);
    if (active.length === 0 && !c.direction) continue;
    lines.push(`*${c.title}*`);
    if (c.direction) lines.push(`> ${c.direction}`);
    for (const t of active) {
      const kind = t.kind === "task" ? "" : ` _(${t.kind})_`;
      lines.push(`• ${t.title}${kind}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

function StatusModal({ text, onClose }: { text: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/50 px-4 pt-[12vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-xl rounded-lg border border-border bg-bg p-4 shadow-lg">
        <div className="mb-2 flex items-center gap-2">
          <h3 className="text-sm font-semibold text-fg">“What are you working on?”</h3>
          <span className="text-xs text-dim">paste-ready for Slack</span>
          <Button variant="outline" className="ml-auto" onClick={copy}>
            {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
            {copied ? "Copied" : "Copy"}
          </Button>
          <Button onClick={onClose}>
            <XIcon className="size-3.5" />
          </Button>
        </div>
        <textarea
          readOnly
          value={text}
          rows={16}
          className="w-full resize-y rounded-md border border-border bg-surface px-3 py-2 font-mono text-xs leading-relaxed text-muted focus:outline-none"
        />
      </div>
    </div>
  );
}

// ===============================
// Home
// ===============================

/** Projects worth surfacing on the board: active, or anything with open items. */
function isOnBoard(p: ProjectSummary): boolean {
  if (p.openTicketCount > 0) return true;
  return p.status === "in_progress" || p.status === "scoping" || p.status === "on_hold";
}

export function Home() {
  const { projects, status, refresh } = useProjects();
  const { tickets: openTickets, refresh: refreshOpen } = useOpenTickets();
  const [activity, setActivity] = useState<ActivityRow[]>([]);
  const [resolved, setResolved] = useState<Ticket[] | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [smartRunning, setSmartRunning] = useState(0);
  const [hideIdeas, setHideIdeas] = useState(() => localStorage.getItem("boucle:hideIdeas") === "1");

  const toggleHideIdeas = () =>
    setHideIdeas((v) => {
      const next = !v;
      localStorage.setItem("boucle:hideIdeas", next ? "1" : "0");
      return next;
    });
  const visible = useMemo(
    () => (items: Ticket[]) => (hideIdeas ? items.filter((t) => t.kind !== "idea") : items),
    [hideIdeas],
  );

  const refreshAll = useMemo(
    () => () => {
      refresh();
      refreshOpen();
      api.activity(ACTIVITY_DAYS).then(setActivity).catch(() => {});
    },
    [refresh, refreshOpen],
  );
  const actions = useActions(refreshAll);

  useEffect(() => {
    api.activity(ACTIVITY_DAYS).then(setActivity).catch(() => {});
    const onCaptured = () => refreshAll();
    window.addEventListener("boucle:captured", onCaptured);
    // Watch smart-capture runs so the header shows AI activity and the board
    // refreshes the moment a paste finishes being split into items.
    let prev = 0;
    const smartPoll = setInterval(() => {
      api
        .smartCaptureRuns()
        .then((runs) => {
          const n = runs.filter((r) => r.status === "running").length;
          setSmartRunning(n);
          if (prev > 0 && n === 0) refreshAll();
          prev = n;
        })
        .catch(() => {});
    }, 5000);
    return () => {
      window.removeEventListener("boucle:captured", onCaptured);
      clearInterval(smartPoll);
    };
  }, [refreshAll]);

  const board = useMemo(() => projects.filter(isOnBoard), [projects]);
  // Cards are for projects with something attached; the rest stay quiet below.
  const activeBoard = useMemo(() => board.filter((p) => p.openTicketCount > 0), [board]);
  const quiet = useMemo(() => board.filter((p) => p.openTicketCount === 0), [board]);
  const knownProjects = useMemo(() => new Set(projects.map((p) => p.projectId)), [projects]);
  const misc = useMemo(
    () => openTickets.filter((t) => !t.project || !knownProjects.has(t.project)),
    [openTickets, knownProjects],
  );

  const activeCount = useMemo(
    () => board.reduce((n, p) => n + p.openTickets.filter((t) => !isDormant(t)).length, 0) + misc.filter((t) => !isDormant(t)).length,
    [board, misc],
  );
  const sleepingCount = useMemo(
    () => board.reduce((n, p) => n + p.openTickets.filter(isDormant).length, 0) + misc.filter(isDormant).length,
    [board, misc],
  );

  // The grid only rows out the projects that are truly alive (open items, or
  // something resolved in the window); everything else folds into "Misc & other".
  const activeInWindow = useMemo(() => new Set(activity.map((a) => a.project ?? "")), [activity]);
  const gridProjects = useMemo(
    () => board.filter((p) => p.openTicketCount > 0 || activeInWindow.has(p.projectId)),
    [board, activeInWindow],
  );
  const activityRows = useMemo(
    () => [
      ...gridProjects.map((p) => ({ id: p.projectId as string | null, label: p.title })),
      { id: null as string | null, label: "Misc & other" },
    ],
    [gridProjects],
  );
  const gridIds = useMemo(() => new Set(gridProjects.map((p) => p.projectId)), [gridProjects]);
  const gridActivity = useMemo(
    () =>
      activity.map((a) => ({
        ...a,
        project: a.project && gridIds.has(a.project) ? a.project : null,
      })),
    [activity, gridIds],
  );

  const move = (index: number, dir: -1 | 1) => {
    const next = [...activeBoard];
    const target = index + dir;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    api
      .reorderProjects([...next, ...quiet].map((p) => p.projectId))
      .then(refresh)
      .catch((e) => alert(String(e.message ?? e)));
  };

  const toggleResolved = () => {
    setShowResolved((v) => !v);
    if (resolved !== null) return;
    Promise.all([api.list("done"), api.list("dropped")])
      .then(([d, x]) =>
        setResolved([...d, ...x].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 40)),
      )
      .catch(() => setResolved([]));
  };

  const reopen = (id: string) => {
    api
      .transition(id, "next")
      .then(() => {
        setResolved((prev) => (prev ? prev.filter((t) => t.ticketId !== id) : prev));
        refreshAll();
      })
      .catch((e) => alert(String(e.message ?? e)));
  };

  const generateStatus = () => {
    setStatusText(
      buildStatus([
        ...activeBoard.map((p) => ({ title: p.title, direction: p.currentState ?? p.nextMilestone, items: p.openTickets })),
        { title: "Misc", direction: null, items: misc },
      ]),
    );
  };

  return (
    <div className="mx-auto flex min-h-full w-full max-w-6xl flex-col px-4 py-6 sm:px-6 sm:py-8">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-x-3 gap-y-2">
        <div>
          <p className="text-xs text-dim">
            {new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
          </p>
          <h1 className="text-[22px] font-bold tracking-tight text-fg">Bonjour, Nora</h1>
          <p className="mt-0.5 text-xs tabular-nums text-muted">
            {board.length} projects · {activeCount} active · {sleepingCount} sleeping
            {smartRunning > 0 ? (
              <span className="ml-2 inline-flex items-center gap-1.5">
                <Dot tone="accent" pulse />
                AI routing your capture…
              </span>
            ) : null}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={generateStatus}
            title="Generate a paste-ready “what I'm on” status"
            className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-surface px-3 py-1.5 text-xs font-medium text-fg hover:border-border-hover"
          >
            <ClipboardListIcon className="size-3.5" /> What am I on?
          </button>
          <button
            onClick={toggleHideIdeas}
            title={hideIdeas ? "Show ideas on the board" : "Hide ideas from the board"}
            className="inline-flex items-center gap-2 text-xs text-muted hover:text-fg"
          >
            <LightbulbIcon className="size-3.5" />
            <span>Ideas</span>
            <Switch on={!hideIdeas} />
          </button>
          <AutoCaptureToggle />
        </div>
      </header>

      <button
        onClick={() => openCapture()}
        className="mb-5 flex w-full items-center gap-3 rounded-2xl border border-border bg-surface px-4 py-3.5 text-left shadow-[var(--float)] transition-colors hover:border-border-hover"
      >
        <PlusIcon className="size-4 text-dim" />
        <span className="flex-1 text-sm text-muted">
          Empty your head… idea, task, conv, scope — Boucle files it in the right project
        </span>
        <MicIcon className="size-4 text-dim" />
        <kbd className="rounded-full border border-border px-2 py-0.5 font-mono text-[10px] text-muted">⌘K</kbd>
      </button>

      {activity.length > 0 ? (
        <div className="mb-4">
          <ActivityGrid rows={activityRows} activity={gridActivity} />
        </div>
      ) : null}

      {status === "error" ? (
        <div className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm text-danger">
          <Dot tone="danger" />
          Could not load projects.
        </div>
      ) : null}

      {status === "ready" && board.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-border bg-surface px-8 py-16 text-center">
          <InboxIcon className="size-6 text-dim" />
          <p className="text-[15px] font-semibold text-fg">No active projects yet</p>
          <p className="max-w-sm text-[13px] text-muted">
            Projects with open items — or marked in-progress/scoping — show up here.
          </p>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {activeBoard.map((project, i) => (
          <ProjectCard
            key={project.projectId}
            title={project.title}
            projectId={project.projectId}
            direction={project.currentState ?? project.nextMilestone}
            status={project.status}
            items={visible(project.openTickets)}
            actions={actions}
            refresh={refreshAll}
            canUp={i > 0}
            canDown={i < activeBoard.length - 1}
            onMove={(dir) => move(i, dir)}
          />
        ))}
        {visible(misc).length > 0 ? (
          <ProjectCard
            title="Ecosystem & misc"
            projectId={null}
            direction="Cross-project ideas that don't have a home yet — captured here instead of a Slack DM."
            status={null}
            items={visible(misc)}
            actions={actions}
            refresh={refreshAll}
            synthetic
          />
        ) : null}
      </div>

      {quiet.length > 0 ? (
        <section className="mt-6">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-dim">
            Quiet — in progress, nothing attached ({quiet.length})
          </p>
          <div className="flex flex-wrap gap-1.5">
            {quiet.map((p) => (
              <button
                key={p.projectId}
                onClick={() => openCapture(p.projectId)}
                title={`${p.currentState ?? ""}\n\nClick to capture an item in ${p.title}`}
                className="rounded-md border border-border px-2.5 py-1 text-xs text-muted hover:border-border-hover hover:text-fg"
              >
                {p.title}
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <section className="mt-8">
        <button
          onClick={toggleResolved}
          className="text-xs font-semibold uppercase tracking-wide text-muted hover:text-fg"
        >
          {showResolved ? "▾" : "▸"} Recently resolved{resolved ? ` (${resolved.length})` : ""}
        </button>
        {showResolved ? (
          <div className="mt-2 flex flex-col">
            {(resolved ?? []).map((t) => (
              <div key={t.ticketId} className="group flex items-center gap-2 rounded-md px-3 py-1.5 hover:bg-fg/[0.04]">
                <Tag>{t.status}</Tag>
                <button
                  onClick={() => actions.openDetail(t.ticketId)}
                  className="truncate text-left text-[13px] text-muted hover:text-fg hover:underline"
                >
                  {t.title}
                </button>
                {t.project ? <span className="text-[11px] text-dim">{t.project}</span> : null}
                <Button
                  title="Reopen — move back to the active queue"
                  className="ml-auto opacity-0 group-hover:opacity-100"
                  onClick={() => reopen(t.ticketId)}
                >
                  <RotateCcwIcon className="size-3.5" /> Reopen
                </Button>
              </div>
            ))}
            {resolved !== null && resolved.length === 0 ? (
              <p className="px-3 py-2 text-xs text-dim">Nothing resolved yet.</p>
            ) : null}
          </div>
        ) : null}
      </section>

      {statusText !== null ? <StatusModal text={statusText} onClose={() => setStatusText(null)} /> : null}
    </div>
  );
}
