/**
 * Brain — the local brain as an interactive force-directed graph.
 *
 * Projects, meetings, people, and open tickets become nodes; ownership,
 * attendance, project relations, and per-project tickets become edges. All of it
 * is derived client-side from the same `useProjects()` / `useMeetings()` snapshots
 * the list views already poll — no backend change. Layout is a d3-force
 * simulation; rendering, pan/zoom, and node dragging are hand-rolled SVG so the
 * only new dependency is the physics engine.
 */
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import { CircleDotIcon, SquareIcon, UserIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { Meeting, ProjectSummary, Ticket } from "./api.ts";
import { navigate, useMeetings, useProjects } from "./hooks.ts";
import {
  Button,
  PRIORITY_TONE,
  PROJECT_STATUS_LABEL,
  PROJECT_STATUS_TONE,
  Status,
  Tag,
  cx,
  formatWhen,
  type Tone,
} from "./ui.tsx";

type NodeKind = "project" | "meeting" | "person" | "ticket";
type EdgeKind = "owns" | "attends" | "relates" | "ticket";

interface PersonRef {
  slug: string;
  name: string;
}

interface GNode extends SimulationNodeDatum {
  id: string;
  kind: NodeKind;
  label: string;
  ref: ProjectSummary | Meeting | Ticket | PersonRef;
}

interface GEdge extends SimulationLinkDatum<GNode> {
  source: string | GNode;
  target: string | GNode;
  kind: EdgeKind;
}

interface Graph {
  nodes: GNode[];
  edges: GEdge[];
}

// ── People reconciliation ────────────────────────────────────────────────────
// People never have their own brain page: they appear as accented owner names on
// projects ("Émile Rousset") and as `people/<slug>` attendee strings on meetings.
// Slugify the owner names to match the two, preferring the accented form as the
// display label.

function slugify(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
}

/** `people/emile-rousset` | `emile-rousset` → `emile-rousset`. */
function attendeeSlug(attendee: string): string {
  return attendee.replace(/^people\//, "").trim();
}

/** Fallback display name from a bare slug: "camille-dervaux" → "Camille Dervaux". */
function titleCaseSlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

const NODE_ID = {
  project: (id: string) => `project:${id}`,
  meeting: (file: string) => `meeting:${file}`,
  person: (slug: string) => `person:${slug}`,
  ticket: (id: string) => `ticket:${id}`,
};

function buildGraph(projects: ProjectSummary[], meetings: Meeting[]): Graph {
  const nodes: GNode[] = [];
  const edges: GEdge[] = [];
  const projectIds = new Set(projects.map((p) => p.projectId));
  const people = new Map<string, string>(); // slug → best-known display name

  const noteName = (slug: string, name?: string) => {
    const existing = people.get(slug);
    // Prefer a name that carries accents/original casing over a slug-derived one.
    if (name && (!existing || existing === titleCaseSlug(slug))) people.set(slug, name);
    else if (!existing) people.set(slug, titleCaseSlug(slug));
  };

  // Projects + their owners + their open tickets.
  for (const project of projects) {
    nodes.push({
      id: NODE_ID.project(project.projectId),
      kind: "project",
      label: project.title,
      ref: project,
    });
    for (const owner of project.owners) {
      const slug = slugify(owner);
      noteName(slug, owner);
      edges.push({ source: NODE_ID.project(project.projectId), target: NODE_ID.person(slug), kind: "owns" });
    }
    for (const ticket of project.openTickets) {
      nodes.push({
        id: NODE_ID.ticket(ticket.ticketId),
        kind: "ticket",
        label: ticket.title,
        ref: ticket,
      });
      edges.push({ source: NODE_ID.project(project.projectId), target: NODE_ID.ticket(ticket.ticketId), kind: "ticket" });
    }
  }

  // Meetings + their attendees + their related projects.
  for (const meeting of meetings) {
    nodes.push({
      id: NODE_ID.meeting(meeting.file),
      kind: "meeting",
      label: meeting.title,
      ref: meeting,
    });
    for (const attendee of meeting.attendees) {
      const slug = attendeeSlug(attendee);
      if (!slug) continue;
      noteName(slug);
      edges.push({ source: NODE_ID.meeting(meeting.file), target: NODE_ID.person(slug), kind: "attends" });
    }
    for (const related of meeting.relatedProjects) {
      const id = related.replace(/^projects\//, "");
      if (!projectIds.has(id)) continue; // fail-soft: skip dangling relations
      edges.push({ source: NODE_ID.meeting(meeting.file), target: NODE_ID.project(id), kind: "relates" });
    }
  }

  // Person nodes last, once every source has contributed the best display name.
  for (const [slug, name] of people) {
    nodes.push({ id: NODE_ID.person(slug), kind: "person", label: name, ref: { slug, name } });
  }

  return { nodes, edges };
}

// ── Node styling ─────────────────────────────────────────────────────────────

const TONE_FILL: Record<Tone, string> = {
  neutral: "fill-dim",
  accent: "fill-accent",
  success: "fill-success",
  danger: "fill-danger",
  warn: "fill-amber-500",
  info: "fill-link",
};

function nodeRadius(node: GNode): number {
  switch (node.kind) {
    case "project":
      return 11;
    case "person":
      return 8;
    case "meeting":
      return 7;
    default:
      return 5; // ticket
  }
}

function nodeTone(node: GNode): Tone {
  if (node.kind === "project") return PROJECT_STATUS_TONE[(node.ref as ProjectSummary).status];
  if (node.kind === "ticket") return PRIORITY_TONE[(node.ref as Ticket).priority];
  return "neutral";
}

/** The SVG shape for a node, centered at (0,0) — parent <g> handles positioning. */
function NodeShape({ node, active }: { node: GNode; active: boolean }) {
  const r = nodeRadius(node);
  const stroke = active ? "stroke-fg" : "stroke-surface";
  const strokeW = active ? 2 : 1.5;
  if (node.kind === "person") {
    return (
      <circle
        r={r}
        className={cx("fill-surface", active ? "stroke-fg" : "stroke-border-hover")}
        strokeWidth={active ? 2.5 : 2}
      />
    );
  }
  if (node.kind === "meeting") {
    // Diamond — a square rotated 45°.
    const d = r * 1.15;
    return (
      <rect
        x={-d}
        y={-d}
        width={d * 2}
        height={d * 2}
        transform="rotate(45)"
        rx={1.5}
        className={cx(TONE_FILL[nodeTone(node)], stroke)}
        strokeWidth={strokeW}
      />
    );
  }
  // project + ticket → filled circle
  return <circle r={r} className={cx(TONE_FILL[nodeTone(node)], stroke)} strokeWidth={strokeW} />;
}

// ── Detail panel ─────────────────────────────────────────────────────────────

function formatMeetingDate(date: string | null): string {
  if (!date) return "—";
  const ms = Date.parse(date);
  if (Number.isNaN(ms)) return date;
  const hasTime = /T\d/.test(date);
  return new Date(ms).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(hasTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  });
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-dim">{label}</span>
      <div className="text-[13px] text-fg">{children}</div>
    </div>
  );
}

function DetailPanel({
  node,
  graph,
  onClose,
  onSelectId,
}: {
  node: GNode;
  graph: Graph;
  onClose: () => void;
  onSelectId: (id: string) => void;
}) {
  const kindLabel: Record<NodeKind, string> = {
    project: "Project",
    meeting: "Meeting",
    person: "Person",
    ticket: "Ticket",
  };

  return (
    <aside className="flex w-[300px] shrink-0 flex-col gap-4 overflow-y-auto border-l border-border bg-surface p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-dim">{kindLabel[node.kind]}</span>
          <h2 className="mt-0.5 text-base font-semibold leading-snug tracking-tight text-fg">{node.label}</h2>
        </div>
        <button onClick={onClose} className="shrink-0 rounded-md px-1.5 py-0.5 text-muted hover:bg-side hover:text-fg">
          ✕
        </button>
      </div>

      {node.kind === "project" ? <ProjectDetail project={node.ref as ProjectSummary} /> : null}
      {node.kind === "meeting" ? (
        <MeetingDetail meeting={node.ref as Meeting} graph={graph} onSelectId={onSelectId} />
      ) : null}
      {node.kind === "ticket" ? <TicketDetail ticket={node.ref as Ticket} /> : null}
      {node.kind === "person" ? (
        <PersonDetail node={node} graph={graph} onSelectId={onSelectId} />
      ) : null}
    </aside>
  );
}

function ProjectDetail({ project }: { project: ProjectSummary }) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Tag tone={PROJECT_STATUS_TONE[project.status]}>{PROJECT_STATUS_LABEL[project.status]}</Tag>
        {project.openTicketCount > 0 ? (
          <span className="text-[11px] text-muted">
            {project.openTicketCount} open ticket{project.openTicketCount === 1 ? "" : "s"}
          </span>
        ) : null}
      </div>
      {project.summary ? <p className="text-[13px] leading-relaxed text-muted">{project.summary}</p> : null}
      {project.owners.length > 0 ? (
        <DetailRow label="Owners">{project.owners.join(", ")}</DetailRow>
      ) : null}
      {project.nextMilestone ? <DetailRow label="Next milestone">{project.nextMilestone}</DetailRow> : null}
      <Button
        variant="outline"
        className="mt-1 self-start"
        onClick={() => navigate(`#/projects/${encodeURIComponent(project.projectId)}`)}
      >
        Open project
      </Button>
    </>
  );
}

function MeetingDetail({
  meeting,
  graph,
  onSelectId,
}: {
  meeting: Meeting;
  graph: Graph;
  onSelectId: (id: string) => void;
}) {
  return (
    <>
      <Status tone="neutral">{formatMeetingDate(meeting.date)}</Status>
      {meeting.summary ? <p className="text-[13px] leading-relaxed text-muted">{meeting.summary}</p> : null}
      {meeting.attendees.length > 0 ? (
        <DetailRow label="Attendees">
          <div className="flex flex-wrap gap-1.5">
            {meeting.attendees.map((a) => {
              const slug = attendeeSlug(a);
              const person = graph.nodes.find((n) => n.id === NODE_ID.person(slug));
              return (
                <button
                  key={slug}
                  onClick={() => person && onSelectId(person.id)}
                  className="rounded-full bg-side px-2 py-0.5 text-[11px] text-muted hover:text-fg"
                >
                  {person?.label ?? titleCaseSlug(slug)}
                </button>
              );
            })}
          </div>
        </DetailRow>
      ) : null}
      {meeting.relatedProjects.length > 0 ? (
        <DetailRow label="Related projects">
          <div className="flex flex-wrap gap-1.5">
            {meeting.relatedProjects.map((r) => {
              const id = r.replace(/^projects\//, "");
              const project = graph.nodes.find((n) => n.id === NODE_ID.project(id));
              return (
                <button
                  key={id}
                  onClick={() => project && onSelectId(NODE_ID.project(id))}
                  className={cx("rounded-full bg-side px-2 py-0.5 text-[11px]", project ? "text-muted hover:text-fg" : "text-dim")}
                >
                  {project?.label ?? id}
                </button>
              );
            })}
          </div>
        </DetailRow>
      ) : null}
    </>
  );
}

function TicketDetail({ ticket }: { ticket: Ticket }) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Tag tone={PRIORITY_TONE[ticket.priority]}>{ticket.priority}</Tag>
        <span className="text-[11px] text-muted">{ticket.status.replace(/_/g, " ")}</span>
      </div>
      {ticket.body ? <p className="line-clamp-4 text-[13px] leading-relaxed text-muted">{ticket.body}</p> : null}
      {ticket.nextAction ? <DetailRow label="Next action">{ticket.nextAction}</DetailRow> : null}
      <DetailRow label="Updated">{formatWhen(ticket.updatedAt)}</DetailRow>
      <Button
        variant="outline"
        className="mt-1 self-start"
        onClick={() => navigate(`#/ticket/${encodeURIComponent(ticket.ticketId)}`)}
      >
        Open ticket
      </Button>
    </>
  );
}

function PersonDetail({
  node,
  graph,
  onSelectId,
}: {
  node: GNode;
  graph: Graph;
  onSelectId: (id: string) => void;
}) {
  const { owns, attends } = useMemo(() => {
    const owns: GNode[] = [];
    const attends: GNode[] = [];
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const idOf = (end: string | GNode) => (typeof end === "string" ? end : end.id);
    for (const edge of graph.edges) {
      const s = idOf(edge.source);
      const t = idOf(edge.target);
      if (edge.kind === "owns" && t === node.id) {
        const p = byId.get(s);
        if (p) owns.push(p);
      }
      if (edge.kind === "attends" && t === node.id) {
        const m = byId.get(s);
        if (m) attends.push(m);
      }
    }
    return { owns, attends };
  }, [graph, node.id]);

  return (
    <>
      {owns.length > 0 ? (
        <DetailRow label="Owns projects">
          <div className="flex flex-col gap-1">
            {owns.map((p) => (
              <button key={p.id} onClick={() => onSelectId(p.id)} className="text-left text-[13px] text-link hover:underline">
                {p.label}
              </button>
            ))}
          </div>
        </DetailRow>
      ) : null}
      {attends.length > 0 ? (
        <DetailRow label={`In ${attends.length} meeting${attends.length === 1 ? "" : "s"}`}>
          <div className="flex flex-col gap-1">
            {attends.map((m) => (
              <button key={m.id} onClick={() => onSelectId(m.id)} className="text-left text-[13px] text-muted hover:text-fg">
                {m.label}
              </button>
            ))}
          </div>
        </DetailRow>
      ) : null}
    </>
  );
}

// ── Legend ───────────────────────────────────────────────────────────────────

function Legend({ nodeCount, edgeCount }: { nodeCount: number; edgeCount: number }) {
  const items: Array<{ icon: React.ReactNode; label: string }> = [
    { icon: <CircleDotIcon className="size-3.5 text-success" />, label: "Project" },
    { icon: <SquareIcon className="size-3 rotate-45 text-dim" />, label: "Meeting" },
    { icon: <UserIcon className="size-3.5 text-fg" />, label: "Person" },
    { icon: <CircleDotIcon className="size-2.5 text-link" />, label: "Ticket" },
  ];
  return (
    <div className="pointer-events-none absolute bottom-3 left-3 flex flex-col gap-1.5 rounded-lg border border-border bg-surface/90 px-3 py-2 backdrop-blur">
      {items.map((it) => (
        <div key={it.label} className="flex items-center gap-2 text-[11px] text-muted">
          <span className="flex w-4 justify-center">{it.icon}</span>
          {it.label}
        </div>
      ))}
      <div className="mt-0.5 border-t border-border pt-1 text-[10px] tabular-nums text-dim">
        {nodeCount} nodes · {edgeCount} links
      </div>
    </div>
  );
}

// ── Graph canvas ─────────────────────────────────────────────────────────────

interface View {
  x: number;
  y: number;
  k: number;
}

const MIN_K = 0.3;
const MAX_K = 3;

function GraphCanvas({
  graph,
  selectedId,
  onSelect,
}: {
  graph: Graph;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const simRef = useRef<Simulation<GNode, GEdge> | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [, setTick] = useState(0); // bump to re-render on each simulation tick
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });

  // Interaction state kept in refs so handlers don't churn effects.
  const dragRef = useRef<{ node: GNode; moved: boolean } | null>(null);
  const panRef = useRef<{ startX: number; startY: number; ox: number; oy: number; moved: boolean } | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  // Once the user pans/zooms/drags, stop auto-fitting the view on their behalf.
  const userMovedRef = useRef(false);

  /** Frame the whole settled graph in the viewport (pan + zoom to its bounding box). */
  const fitView = () => {
    const nodes = graph.nodes;
    if (nodes.length === 0 || size.w === 0 || size.h === 0) return;
    const xs = nodes.map((n) => n.x ?? 0);
    const ys = nodes.map((n) => n.y ?? 0);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const pad = 56; // room for labels below nodes + breathing space
    const gw = Math.max(1, maxX - minX);
    const gh = Math.max(1, maxY - minY);
    const k = Math.min(MAX_K, Math.max(MIN_K, Math.min((size.w - 2 * pad) / gw, (size.h - 2 * pad) / gh)));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    setView({ k, x: size.w / 2 - cx * k, y: size.h / 2 - cy * k });
  };

  // Track container size.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) setSize({ w: box.width, h: box.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Build/refresh the simulation when the graph structure changes.
  useEffect(() => {
    if (size.w === 0 || size.h === 0) return;
    userMovedRef.current = false;
    const sim = forceSimulation<GNode>(graph.nodes)
      .force(
        "link",
        forceLink<GNode, GEdge>(graph.edges)
          .id((d) => d.id)
          .distance((edge) => (edge.kind === "ticket" ? 34 : 60))
          .strength(0.6),
      )
      .force("charge", forceManyBody<GNode>().strength(-140))
      // forceX/Y (not forceCenter) pull *every* node toward the middle, so the
      // disconnected project+ticket clusters stay in frame instead of drifting.
      .force("x", forceX<GNode>(size.w / 2).strength(0.06))
      .force("y", forceY<GNode>(size.h / 2).strength(0.06))
      .force("collide", forceCollide<GNode>((d) => nodeRadius(d) + 6))
      .on("tick", () => setTick((t) => t + 1))
      .on("end", () => {
        if (!userMovedRef.current) fitView();
      });
    simRef.current = sim;
    return () => {
      sim.stop();
      simRef.current = null;
    };
    // Re-seed only when the node/edge set changes, not on every poll with equal data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, size.w, size.h]);

  // Convert a client pointer position into simulation (pre-transform) coordinates.
  const toSim = (clientX: number, clientY: number) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    const v = viewRef.current;
    const px = clientX - (rect?.left ?? 0);
    const py = clientY - (rect?.top ?? 0);
    return { x: (px - v.x) / v.k, y: (py - v.y) / v.k };
  };

  const onNodePointerDown = (e: React.PointerEvent, node: GNode) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    userMovedRef.current = true;
    dragRef.current = { node, moved: false };
    const sim = simRef.current;
    if (sim) {
      sim.alphaTarget(0.3).restart();
      const p = toSim(e.clientX, e.clientY);
      node.fx = p.x;
      node.fy = p.y;
    }
  };

  const onCanvasPointerDown = (e: React.PointerEvent) => {
    const v = viewRef.current;
    panRef.current = { startX: e.clientX, startY: e.clientY, ox: v.x, oy: v.y, moved: false };
  };

  const markUserMoved = () => {
    userMovedRef.current = true;
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (drag) {
      drag.moved = true;
      const p = toSim(e.clientX, e.clientY);
      drag.node.fx = p.x;
      drag.node.fy = p.y;
      return;
    }
    const pan = panRef.current;
    if (pan) {
      const dx = e.clientX - pan.startX;
      const dy = e.clientY - pan.startY;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
        pan.moved = true;
        markUserMoved();
      }
      setView((v) => ({ ...v, x: pan.ox + dx, y: pan.oy + dy }));
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (drag) {
      const sim = simRef.current;
      sim?.alphaTarget(0);
      drag.node.fx = null;
      drag.node.fy = null;
      if (!drag.moved) onSelect(drag.node.id);
      dragRef.current = null;
      return;
    }
    const pan = panRef.current;
    if (pan) {
      if (!pan.moved) onSelect(null); // click on empty canvas clears selection
      panRef.current = null;
    }
    void e;
  };

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    markUserMoved();
    const rect = wrapRef.current?.getBoundingClientRect();
    const px = e.clientX - (rect?.left ?? 0);
    const py = e.clientY - (rect?.top ?? 0);
    setView((v) => {
      const factor = Math.exp(-e.deltaY * 0.0015);
      const k = Math.min(MAX_K, Math.max(MIN_K, v.k * factor));
      // Zoom anchored at the cursor: keep the sim point under the cursor fixed.
      const sx = (px - v.x) / v.k;
      const sy = (py - v.y) / v.k;
      return { k, x: px - sx * k, y: py - sy * k };
    });
  };

  const idOf = (end: string | GNode) => (typeof end === "string" ? end : end.id);

  return (
    <div
      ref={wrapRef}
      className="relative min-w-0 flex-1 overflow-hidden bg-bg"
      onPointerDown={onCanvasPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onWheel={onWheel}
      style={{ touchAction: "none", cursor: panRef.current ? "grabbing" : "default" }}
    >
      <svg width={size.w} height={size.h} className="block">
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {graph.edges.map((edge, i) => {
            const s = typeof edge.source === "string" ? null : edge.source;
            const t = typeof edge.target === "string" ? null : edge.target;
            if (!s || !t) return null;
            const active = selectedId != null && (s.id === selectedId || t.id === selectedId);
            return (
              <line
                key={i}
                x1={s.x}
                y1={s.y}
                x2={t.x}
                y2={t.y}
                className={active ? "stroke-accent" : "stroke-border-hover"}
                strokeWidth={active ? 1.5 : 1}
                strokeOpacity={active ? 0.9 : 0.5}
              />
            );
          })}
          {graph.nodes.map((node) => {
            const dim = selectedId != null && !isNeighbor(node.id, selectedId, graph, idOf);
            return (
              <g
                key={node.id}
                transform={`translate(${node.x ?? 0},${node.y ?? 0})`}
                className="cursor-pointer"
                opacity={dim ? 0.3 : 1}
                onPointerDown={(e) => onNodePointerDown(e, node)}
              >
                <NodeShape node={node} active={node.id === selectedId} />
                <text
                  x={0}
                  y={nodeRadius(node) + 11}
                  textAnchor="middle"
                  className="pointer-events-none fill-muted text-[9px] font-medium"
                  style={{ userSelect: "none" }}
                >
                  {truncate(node.label, node.kind === "ticket" ? 22 : 28)}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
      <button
        onClick={() => {
          userMovedRef.current = false;
          fitView();
        }}
        className="absolute right-3 top-3 rounded-md border border-border bg-surface/90 px-2.5 py-1 text-[11px] font-medium text-muted backdrop-blur hover:text-fg"
        title="Fit the whole graph in view"
      >
        Fit
      </button>
      <Legend nodeCount={graph.nodes.length} edgeCount={graph.edges.length} />
    </div>
  );
}

function isNeighbor(
  nodeId: string,
  selectedId: string,
  graph: Graph,
  idOf: (end: string | GNode) => string,
): boolean {
  if (nodeId === selectedId) return true;
  for (const edge of graph.edges) {
    const s = idOf(edge.source);
    const t = idOf(edge.target);
    if (s === selectedId && t === nodeId) return true;
    if (t === selectedId && s === nodeId) return true;
  }
  return false;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// ── View ─────────────────────────────────────────────────────────────────────

export function Brain() {
  const { projects, status: pStatus } = useProjects();
  const { meetings, status: mStatus } = useMeetings();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Rebuild only when the underlying identity set changes — not on every poll —
  // so the running simulation isn't reseeded when the data is unchanged.
  const structureKey = useMemo(() => {
    const p = projects
      .map((x) => `${x.projectId}:${x.status}:${x.openTickets.map((t) => t.ticketId).join(",")}:${x.owners.join(",")}`)
      .join("|");
    const m = meetings
      .map((x) => `${x.file}:${x.attendees.join(",")}:${x.relatedProjects.join(",")}`)
      .join("|");
    return `${p}##${m}`;
  }, [projects, meetings]);

  const graph = useMemo(() => buildGraph(projects, meetings), [structureKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const selected = selectedId ? graph.nodes.find((n) => n.id === selectedId) ?? null : null;
  // Drop a stale selection if its node disappeared after a refresh.
  useEffect(() => {
    if (selectedId && !graph.nodes.some((n) => n.id === selectedId)) setSelectedId(null);
  }, [graph, selectedId]);

  const loading = (pStatus === "loading" || mStatus === "loading") && graph.nodes.length === 0;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border px-5 py-3">
        <div>
          <h1 className="text-sm font-semibold text-fg">Brain</h1>
          <p className="text-[11px] text-muted">Projects, meetings, people, and open tickets — how the brain connects.</p>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        {loading ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted">Loading the brain…</div>
        ) : graph.nodes.length === 0 ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted">The brain is empty.</div>
        ) : (
          <GraphCanvas graph={graph} selectedId={selectedId} onSelect={setSelectedId} />
        )}
        {selected ? (
          <DetailPanel node={selected} graph={graph} onClose={() => setSelectedId(null)} onSelectId={setSelectedId} />
        ) : null}
      </div>
    </div>
  );
}
