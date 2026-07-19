import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, watch, type FSWatcher } from "node:fs";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { resolveBrainDir, resolveMeetingsDir } from "./config.ts";
import { getEmbeddingModel, getLegacyEmbeddingModel, getProvider } from "./providers/index.ts";
import type { Provider } from "./providers/types.ts";
import type { BoucleStore, SearchIndexer } from "./store.ts";

export type SearchSource = "ticket" | "event" | "meeting" | "brain";

export interface SearchResult {
  source: SearchSource;
  id: string;
  title: string;
  snippet: string;
  projectId?: string;
  url: string;
  score: number;
}

export interface SearchResponse {
  query: string;
  counts: Record<SearchSource, number>;
  results: SearchResult[];
}

interface SearchDocument {
  source: SearchSource;
  docId: string;
  chunkId: string;
  title: string;
  content: string;
  projectId: string | null;
  url: string;
  contentHash: string;
}

interface RankedDocument extends SearchDocument {
  snippet: string;
}

interface StoredEmbedding extends SearchDocument {
  embedding: Uint8Array;
}

const EMPTY_COUNTS = (): Record<SearchSource, number> => ({ ticket: 0, event: 0, meeting: 0, brain: 0 });
const RRF_K = 60;
const EMBED_BATCH_SIZE = 32;
let loggedFtsFallback = false;

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function markdownTitle(markdown: string, fallback: string): string {
  return /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim() ?? fallback;
}

function chunkMarkdown(markdown: string): string[] {
  const sections = markdown.split(/(?=^#{1,3}\s+)/m).filter((part) => part.trim().length > 0);
  const chunks: string[] = [];
  for (const section of sections.length > 0 ? sections : [markdown]) {
    let rest = section.trim();
    while (rest.length > 1_500) {
      let end = rest.lastIndexOf("\n", 1_500);
      if (end < 750) end = rest.lastIndexOf(" ", 1_500);
      if (end < 750) end = 1_500;
      chunks.push(rest.slice(0, end).trim());
      rest = rest.slice(end).trim();
    }
    if (rest.length > 0) chunks.push(rest);
  }
  return chunks.length > 0 ? chunks : [""];
}

function firstMatchingLine(content: string, query: string): string {
  const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const line = content
    .split("\n")
    .map((value) => value.trim())
    .find((value) => terms.some((term) => value.toLocaleLowerCase().includes(term)));
  return (line ?? content.trim()).replace(/^[-#>*\s]+/, "").slice(0, 280);
}

function ftsQuery(query: string): string {
  const terms = query.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ");
}

function vectorBlob(vector: readonly number[]): Buffer {
  const values = Float32Array.from(vector);
  return Buffer.from(values.buffer, values.byteOffset, values.byteLength);
}

function blobVector(blob: Uint8Array): Float32Array {
  const values = new Float32Array(Math.floor(blob.byteLength / Float32Array.BYTES_PER_ELEMENT));
  new Uint8Array(values.buffer).set(blob.subarray(0, values.byteLength));
  return values;
}

function cosine(a: readonly number[], b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return -1;
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    aa += av * av;
    bb += bv * bv;
  }
  return aa > 0 && bb > 0 ? dot / Math.sqrt(aa * bb) : -1;
}

function probeFts5(): boolean {
  const probe = new DatabaseSync(":memory:");
  try {
    probe.exec("CREATE VIRTUAL TABLE fts_probe USING fts5(value)");
    return true;
  } catch {
    return false;
  } finally {
    probe.close();
  }
}

export class BrainSearch implements SearchIndexer {
  private readonly db: DatabaseSync;
  private readonly store: BoucleStore;
  private readonly provider: Provider;
  private readonly embeddingModel: string | null;
  private readonly ftsAvailable: boolean;
  private readonly watchers: FSWatcher[] = [];
  private fileTimer: ReturnType<typeof setTimeout> | null = null;
  private embeddingTimer: ReturnType<typeof setTimeout> | null = null;
  private embeddingInFlight: Promise<void> | null = null;
  private bootstrapping = false;
  private embeddingDisabled = false;

  constructor(dbPath: string, store: BoucleStore) {
    this.db = new DatabaseSync(dbPath);
    this.store = store;
    this.provider = getProvider();
    this.embeddingModel = getEmbeddingModel();
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.ftsAvailable = probeFts5();
    if (!this.ftsAvailable && !loggedFtsFallback) {
      loggedFtsFallback = true;
      process.stderr.write("Boucle search: SQLite FTS5 unavailable; using LIKE fallback.\n");
    }
    this.initSchema();
    this.store.setSearchIndexer(this);
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS search_documents (
        source TEXT NOT NULL, doc_id TEXT NOT NULL, chunk_id TEXT NOT NULL,
        title TEXT NOT NULL, content TEXT NOT NULL, project_id TEXT, url TEXT NOT NULL,
        content_hash TEXT NOT NULL, PRIMARY KEY (source, doc_id, chunk_id)
      );
      CREATE TABLE IF NOT EXISTS search_embeddings (
        source TEXT NOT NULL, doc_id TEXT NOT NULL, chunk_id TEXT NOT NULL,
        content_hash TEXT NOT NULL, model TEXT NOT NULL, embedding BLOB NOT NULL,
        PRIMARY KEY (source, doc_id, chunk_id, content_hash)
      );
    `);
    const embeddingCols = this.db.prepare(`PRAGMA table_info(search_embeddings)`).all() as Array<{ name: string }>;
    if (!embeddingCols.some((column) => column.name === "model")) {
      this.db.exec(`ALTER TABLE search_embeddings ADD COLUMN model TEXT`);
      this.db.prepare(`UPDATE search_embeddings SET model = ? WHERE model IS NULL`).run(getLegacyEmbeddingModel());
    }
    if (this.ftsAvailable) {
      this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
        source UNINDEXED, doc_id UNINDEXED, chunk_id UNINDEXED, title, content,
        project_id UNINDEXED, url UNINDEXED, tokenize = 'unicode61 remove_diacritics 2'
      )`);
    }
  }

  async bootstrap(): Promise<void> {
    this.bootstrapping = true;
    try {
      this.reindexTicketsAndEvents();
      this.reindexFiles();
    } finally {
      this.bootstrapping = false;
    }
    this.watchFiles();
    await this.embedMissing();
  }

  reindexTicket(ticketId: string): void {
    const ticket = this.store.getById(ticketId);
    if (!ticket) return;
    const events = this.store.listEvents(ticketId);
    const latest = events[events.length - 1]?.summary ?? "";
    const content = [ticket.title, ticket.body, ticket.nextAction ?? "", latest].filter(Boolean).join("\n");
    this.replaceDocument({
      source: "ticket",
      docId: ticket.ticketId,
      chunkId: "0",
      title: ticket.title,
      content,
      projectId: ticket.project,
      url: `#/ticket/${encodeURIComponent(ticket.ticketId)}`,
      contentHash: hash(content),
    });
    for (const event of events) {
      const eventContent = `${event.kind}\n${event.summary}`;
      this.replaceDocument({
        source: "event",
        docId: event.eventId,
        chunkId: "0",
        title: `${ticket.title} — ${event.kind}`,
        content: eventContent,
        projectId: ticket.project,
        url: `#/ticket/${encodeURIComponent(ticket.ticketId)}`,
        contentHash: hash(eventContent),
      });
    }
    this.scheduleEmbedding();
  }

  reindexFiles(): void {
    this.replaceFileSource("meeting", resolveMeetingsDir(), (id) => "#/meetings");
    this.replaceFileSource("brain", join(resolveBrainDir(), "projects"), (id) => `#/projects/${encodeURIComponent(id)}`);
    this.scheduleEmbedding();
  }

  private reindexTicketsAndEvents(): void {
    this.deleteSource("ticket");
    this.deleteSource("event");
    for (const ticket of this.store.list({})) this.reindexTicket(ticket.ticketId);
  }

  private replaceFileSource(source: "meeting" | "brain", dir: string, urlFor: (id: string) => string): void {
    this.deleteSource(source);
    if (!existsSync(dir)) return;
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".md") && name.toLowerCase() !== "readme.md")) {
      const id = basename(file, ".md");
      const markdown = readFileSync(join(dir, file), "utf8");
      const title = markdownTitle(markdown, id.replaceAll("-", " "));
      const projectId = source === "brain" ? id : null;
      chunkMarkdown(markdown).forEach((content, index) => {
        this.replaceDocument({
          source,
          docId: source === "meeting" ? file : id,
          chunkId: String(index),
          title,
          content,
          projectId,
          url: urlFor(id),
          contentHash: hash(content),
        });
      });
    }
  }

  private deleteSource(source: SearchSource): void {
    this.db.prepare("DELETE FROM search_documents WHERE source = ?").run(source);
    if (this.ftsAvailable) this.db.prepare("DELETE FROM search_fts WHERE source = ?").run(source);
  }

  private replaceDocument(doc: SearchDocument): void {
    this.db
      .prepare(`INSERT INTO search_documents (source,doc_id,chunk_id,title,content,project_id,url,content_hash)
        VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(source,doc_id,chunk_id) DO UPDATE SET
        title=excluded.title, content=excluded.content, project_id=excluded.project_id,
        url=excluded.url, content_hash=excluded.content_hash`)
      .run(doc.source, doc.docId, doc.chunkId, doc.title, doc.content, doc.projectId, doc.url, doc.contentHash);
    this.db
      .prepare("DELETE FROM search_embeddings WHERE source=? AND doc_id=? AND chunk_id=? AND content_hash != ?")
      .run(doc.source, doc.docId, doc.chunkId, doc.contentHash);
    if (!this.ftsAvailable) return;
    this.db.prepare("DELETE FROM search_fts WHERE source=? AND doc_id=? AND chunk_id=?").run(doc.source, doc.docId, doc.chunkId);
    this.db
      .prepare("INSERT INTO search_fts (source,doc_id,chunk_id,title,content,project_id,url) VALUES (?,?,?,?,?,?,?)")
      .run(doc.source, doc.docId, doc.chunkId, doc.title, doc.content, doc.projectId, doc.url);
  }

  private watchFiles(): void {
    if (this.watchers.length > 0) return;
    for (const dir of [resolveMeetingsDir(), join(resolveBrainDir(), "projects")]) {
      if (!existsSync(dir)) continue;
      const watcher = watch(dir, { persistent: false }, () => {
        if (this.fileTimer) clearTimeout(this.fileTimer);
        this.fileTimer = setTimeout(() => {
          this.fileTimer = null;
          this.reindexFiles();
        }, 250);
      });
      watcher.on("error", () => watcher.close());
      this.watchers.push(watcher);
    }
  }

  private scheduleEmbedding(): void {
    if (this.bootstrapping || this.embeddingDisabled || !this.provider.isConfigured() || !this.provider.supportsEmbeddings()) return;
    if (this.embeddingTimer) clearTimeout(this.embeddingTimer);
    this.embeddingTimer = setTimeout(() => {
      this.embeddingTimer = null;
      void this.embedMissing();
    }, 250);
    if (typeof this.embeddingTimer.unref === "function") this.embeddingTimer.unref();
  }

  private async embedMissing(): Promise<void> {
    if (this.embeddingInFlight) {
      await this.embeddingInFlight;
      return this.embedMissing();
    }
    this.embeddingInFlight = this.embedMissingOnce();
    try {
      await this.embeddingInFlight;
    } finally {
      this.embeddingInFlight = null;
    }
  }

  private async embedMissingOnce(): Promise<void> {
    if (this.embeddingDisabled || !this.embeddingModel || !this.provider.isConfigured() || !this.provider.supportsEmbeddings()) return;
    const rows = this.db
      .prepare(`SELECT d.source,d.doc_id AS docId,d.chunk_id AS chunkId,d.title,d.content,
          d.project_id AS projectId,d.url,d.content_hash AS contentHash
        FROM search_documents d LEFT JOIN search_embeddings e
          ON e.source=d.source AND e.doc_id=d.doc_id AND e.chunk_id=d.chunk_id
            AND e.content_hash=d.content_hash AND e.model=?
        WHERE d.source != 'event' AND e.embedding IS NULL ORDER BY d.source,d.doc_id,d.chunk_id`)
      .all(this.embeddingModel) as unknown as SearchDocument[];
    try {
      for (let offset = 0; offset < rows.length; offset += EMBED_BATCH_SIZE) {
        const batch = rows.slice(offset, offset + EMBED_BATCH_SIZE);
        const vectors = await this.provider.embed(batch.map((row) => `${row.title}\n${row.content}`));
        if (vectors.length !== batch.length) throw new Error(`${this.provider.name} embeddings response length mismatch`);
        batch.forEach((row, index) => {
          this.db
            .prepare("INSERT OR REPLACE INTO search_embeddings (source,doc_id,chunk_id,content_hash,model,embedding) VALUES (?,?,?,?,?,?)")
            .run(row.source, row.docId, row.chunkId, row.contentHash, this.embeddingModel, vectorBlob(vectors[index] ?? []));
        });
      }
    } catch {
      this.embeddingDisabled = true;
    }
  }

  async search(rawQuery: string, limit = 20): Promise<SearchResponse> {
    const query = rawQuery.trim();
    const safeLimit = Math.max(1, Math.min(20, Math.trunc(limit) || 20));
    if (query.length < 2) return { query, counts: EMPTY_COUNTS(), results: [] };
    const lexical = this.lexicalSearch(query);
    const semantic = await this.vectorSearch(query);
    const scores = new Map<string, number>();
    const documents = new Map<string, RankedDocument>();
    // RRF per DOCUMENT, not per chunk: only a doc's best-ranked chunk counts in each
    // method, otherwise long multi-chunk pages stack tiny contributions and drown
    // out exact-match single-chunk tickets.
    const add = (rows: RankedDocument[]) => {
      const seen = new Set<string>();
      let rank = 0;
      for (const row of rows) {
        const key = `${row.source}\0${row.docId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        scores.set(key, (scores.get(key) ?? 0) + 1 / (RRF_K + rank + 1));
        rank += 1;
        if (!documents.has(key)) documents.set(key, row);
      }
    };
    add(lexical);
    add(semantic);
    const results = [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, safeLimit)
      .map(([key, score]) => {
        const doc = documents.get(key)!;
        return {
          source: doc.source,
          id: doc.docId,
          title: doc.title,
          snippet: doc.snippet || firstMatchingLine(doc.content, query),
          ...(doc.projectId ? { projectId: doc.projectId } : {}),
          url: doc.url,
          score,
        } satisfies SearchResult;
      });
    const counts = EMPTY_COUNTS();
    results.forEach((result) => { counts[result.source] += 1; });
    return { query, counts, results };
  }

  private lexicalSearch(query: string): RankedDocument[] {
    const match = ftsQuery(query);
    if (this.ftsAvailable && match) {
      try {
        return this.db
          .prepare(`SELECT source,doc_id AS docId,chunk_id AS chunkId,title,content,
              project_id AS projectId,url,'' AS contentHash,
              snippet(search_fts, 4, '<mark>', '</mark>', ' … ', 24) AS snippet
            FROM search_fts WHERE search_fts MATCH ? ORDER BY bm25(search_fts) LIMIT 100`)
          .all(match) as unknown as RankedDocument[];
      } catch {
        // A malformed user query should still get the LIKE path.
      }
    }
    const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const escapeLike = (term: string) => `%${term.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    const where = terms.map(() => "lower(title || char(10) || content) LIKE ? ESCAPE '\\'").join(" AND ");
    const rows = this.db
      .prepare(`SELECT source,doc_id AS docId,chunk_id AS chunkId,title,content,
          project_id AS projectId,url,content_hash AS contentHash FROM search_documents WHERE ${where}`)
      .all(...terms.map(escapeLike)) as unknown as SearchDocument[];
    return rows
      .map((row) => ({ ...row, snippet: firstMatchingLine(row.content, query) }))
      .slice(0, 100);
  }

  private async vectorSearch(query: string): Promise<RankedDocument[]> {
    if (this.embeddingDisabled || !this.embeddingModel || !this.provider.isConfigured() || !this.provider.supportsEmbeddings()) return [];
    try {
      const [queryVector] = await this.provider.embed([query]);
      if (!queryVector) return [];
      const rows = this.db
        .prepare(`SELECT d.source,d.doc_id AS docId,d.chunk_id AS chunkId,d.title,d.content,
            d.project_id AS projectId,d.url,d.content_hash AS contentHash,e.embedding
          FROM search_documents d JOIN search_embeddings e
            ON e.source=d.source AND e.doc_id=d.doc_id AND e.chunk_id=d.chunk_id
              AND e.content_hash=d.content_hash AND e.model=?`)
        .all(this.embeddingModel) as unknown as StoredEmbedding[];
      return rows
        .map((row) => ({ ...row, snippet: firstMatchingLine(row.content, query), similarity: cosine(queryVector, blobVector(row.embedding)) }))
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, 100);
    } catch {
      this.embeddingDisabled = true;
      return [];
    }
  }
}
