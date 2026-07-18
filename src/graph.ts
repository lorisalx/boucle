import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

import { resolveBrainDir, resolveMeetingsDir } from "./config.ts";
import type { SearchResponse, SearchResult } from "./search.ts";
import type { BoucleStore } from "./store.ts";

/**
 * GraphRAG over the brain: an entity graph (projects, tickets, meetings,
 * people) built from the same sources the hybrid search indexes. Retrieval
 * seeds come from hybrid search (FTS + mistral-embed, RRF); the graph then
 * expands each seed 1–2 hops so answers draw on the connected neighborhood
 * (a ticket pulls in its project page, the meeting that spawned it, and the
 * people on the hook) instead of isolated chunks. Every expanded node keeps
 * the path that reached it, so answers can cite how context was found.
 */

export type GraphNodeType = "project" | "ticket" | "meeting" | "person";

export interface GraphNode {
  id: string;
  type: GraphNodeType;
  label: string;
  /** In-app link (hash route) or brain path for people. */
  ref: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  rel: "belongs_to" | "requested" | "about" | "attended" | "owns_action";
}

export interface GraphHit extends GraphNode {
  score: number;
  /** 0 = matched the query directly, 1–2 = reached via the graph. */
  hop: number;
  /** Human-readable path from the seed that reached this node. */
  via: string;
}

export interface GraphSearchResponse {
  query: string;
  seeds: SearchResult[];
  nodes: GraphHit[];
  edges: GraphEdge[];
}

interface Searcher {
  search(query: string, limit?: number): Promise<SearchResponse>;
}

const HOP_DECAY = 0.45;
const MAX_NODES = 25;
const REBUILD_MS = 5_000;

const personLabel = (slug: string): string =>
  slug
    .split("-")
    .map((part) => part.charAt(0).toLocaleUpperCase() + part.slice(1))
    .join(" ");

const personSlug = (raw: string): string =>
  raw
    .trim()
    .replace(/^people\//, "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

function frontmatterList(markdown: string, key: string): string[] {
  const match = new RegExp(`^${key}:\\s*\\[([^\\]]*)\\]`, "m").exec(markdown);
  if (!match?.[1]) return [];
  return match[1]
    .split(",")
    .map((value) => value.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

function markdownTitle(markdown: string, fallback: string): string {
  const front = /^title:\s*(.+)$/m.exec(markdown)?.[1]?.trim();
  return front ?? /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim() ?? fallback;
}

export class BrainGraph {
  private nodes = new Map<string, GraphNode>();
  private adjacency = new Map<string, GraphEdge[]>();
  private edges: GraphEdge[] = [];
  private builtAt = 0;

  private readonly store: BoucleStore;
  private readonly searcher: Searcher;

  constructor(store: BoucleStore, searcher: Searcher) {
    this.store = store;
    this.searcher = searcher;
  }

  /** The corpus is small; rebuild whenever the graph could be stale. */
  private build(): void {
    if (Date.now() - this.builtAt < REBUILD_MS) return;
    this.nodes = new Map();
    this.adjacency = new Map();
    this.edges = [];

    const projectsDir = join(resolveBrainDir(), "projects");
    if (existsSync(projectsDir)) {
      for (const file of readdirSync(projectsDir).filter((name) => name.endsWith(".md") && name.toLowerCase() !== "readme.md")) {
        const slug = basename(file, ".md");
        const markdown = readFileSync(join(projectsDir, file), "utf8");
        this.addNode({
          id: `project:${slug}`,
          type: "project",
          label: markdownTitle(markdown, slug.replaceAll("-", " ")),
          ref: `#/projects/${encodeURIComponent(slug)}`,
        });
      }
    }

    for (const ticket of this.store.list({})) {
      const ticketId = `ticket:${ticket.ticketId}`;
      this.addNode({
        id: ticketId,
        type: "ticket",
        label: ticket.title,
        ref: `#/ticket/${encodeURIComponent(ticket.ticketId)}`,
      });
      if (ticket.project) {
        this.ensureProject(ticket.project);
        this.addEdge({ from: ticketId, to: `project:${ticket.project}`, rel: "belongs_to" });
      }
      if (ticket.requester) {
        const person = this.ensurePerson(ticket.requester);
        this.addEdge({ from: person, to: ticketId, rel: "requested" });
      }
    }

    const meetingsDir = resolveMeetingsDir();
    if (existsSync(meetingsDir)) {
      for (const file of readdirSync(meetingsDir).filter((name) => name.endsWith(".md") && name.toLowerCase() !== "readme.md")) {
        const markdown = readFileSync(join(meetingsDir, file), "utf8");
        const meetingId = `meeting:${file}`;
        this.addNode({
          id: meetingId,
          type: "meeting",
          label: markdownTitle(markdown, basename(file, ".md").replaceAll("-", " ")),
          ref: "#/meetings",
        });
        for (const slug of frontmatterList(markdown, "related_projects")) {
          this.ensureProject(slug);
          this.addEdge({ from: meetingId, to: `project:${slug}`, rel: "about" });
        }
        for (const attendee of frontmatterList(markdown, "attendees")) {
          const person = this.ensurePerson(attendee);
          this.addEdge({ from: person, to: meetingId, rel: "attended" });
        }
        for (const owner of markdown.matchAll(/^-\s+\*\*([^:*]+):?\*\*/gm)) {
          const person = this.ensurePerson(owner[1] ?? "");
          if (person) this.addEdge({ from: person, to: meetingId, rel: "owns_action" });
        }
      }
    }

    this.builtAt = Date.now();
  }

  private ensureProject(slug: string): void {
    const id = `project:${slug}`;
    if (!this.nodes.has(id)) {
      this.addNode({ id, type: "project", label: slug.replaceAll("-", " "), ref: `#/projects/${encodeURIComponent(slug)}` });
    }
  }

  private ensurePerson(raw: string): string {
    const slug = personSlug(raw);
    if (!slug) return "";
    const id = `person:${slug}`;
    if (!this.nodes.has(id)) {
      this.addNode({ id, type: "person", label: personLabel(slug), ref: `people/${slug}` });
    }
    return id;
  }

  private addNode(node: GraphNode): void {
    this.nodes.set(node.id, node);
  }

  private addEdge(edge: GraphEdge): void {
    if (!this.nodes.has(edge.from) || !this.nodes.has(edge.to)) return;
    const duplicate = this.adjacency.get(edge.from)?.some((known) => known.to === edge.to && known.rel === edge.rel);
    if (duplicate) return;
    this.edges.push(edge);
    for (const end of [edge.from, edge.to]) {
      const list = this.adjacency.get(end) ?? [];
      list.push(edge);
      this.adjacency.set(end, list);
    }
  }

  /** Map a hybrid-search hit onto a graph node id. */
  private seedNodeId(result: SearchResult): string | null {
    switch (result.source) {
      case "ticket":
        return `ticket:${result.id}`;
      case "event": {
        const match = /#\/ticket\/(.+)$/.exec(result.url);
        return match ? `ticket:${decodeURIComponent(match[1] ?? "")}` : null;
      }
      case "meeting":
        return `meeting:${result.id}`;
      case "brain":
        return `project:${result.id}`;
      default:
        return null;
    }
  }

  async search(query: string, limit = MAX_NODES): Promise<GraphSearchResponse> {
    this.build();
    const seeds = await this.searcher.search(query, 8);
    const best = new Map<string, GraphHit>();

    const visit = (id: string, score: number, hop: number, via: string): void => {
      const node = this.nodes.get(id);
      if (!node) return;
      const known = best.get(id);
      if (known && known.score >= score) return;
      best.set(id, { ...node, score, hop: known ? Math.min(known.hop, hop) : hop, via });
      if (hop >= 2) return;
      for (const edge of this.adjacency.get(id) ?? []) {
        const next = edge.from === id ? edge.to : edge.from;
        const nextLabel = this.nodes.get(next)?.label ?? next;
        visit(next, score * HOP_DECAY, hop + 1, `${via} → ${nextLabel}`);
      }
    };

    for (const seed of seeds.results) {
      const id = this.seedNodeId(seed);
      if (id) visit(id, seed.score, 0, this.nodes.get(id)?.label ?? seed.title);
    }

    const nodes = [...best.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Math.min(MAX_NODES, Math.trunc(limit) || MAX_NODES)));
    const kept = new Set(nodes.map((node) => node.id));
    const edges = this.edges.filter((edge) => kept.has(edge.from) && kept.has(edge.to));
    return { query, seeds: seeds.results.slice(0, 8), nodes, edges };
  }
}

let instance: BrainGraph | null = null;

export function initBrainGraph(store: BoucleStore, searcher: Searcher): BrainGraph {
  instance = new BrainGraph(store, searcher);
  return instance;
}

export function graphSearch(query: string, limit?: number): Promise<GraphSearchResponse> {
  if (!instance) throw new Error("Brain graph is not initialized");
  return instance.search(query, limit);
}
