import { ArrowLeftIcon, FolderIcon, Loader2Icon, MessageSquareTextIcon, PlayIcon, SearchIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { api, type SessionEngine, type SessionSummary, type SessionTranscript } from "./api.ts";
import { navigate } from "./hooks.ts";
import { TranscriptEntries } from "./TranscriptEntries.tsx";
import { Seg, Tag, formatWhen } from "./ui.tsx";

type EngineFilter = "all" | SessionEngine;

const ENGINE_OPTIONS: ReadonlyArray<{ id: EngineFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
];

function EngineBadge({ engine }: { engine: SessionEngine }) {
  return <Tag tone={engine === "claude" ? "accent" : "info"}>{engine}</Tag>;
}

export function Sessions() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [engine, setEngine] = useState<EngineFilter>("all");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      setStatus("loading");
      api.sessions.list({
        engine: engine === "all" ? undefined : engine,
        q: query,
      }).then(({ sessions: next }) => {
        if (!alive) return;
        setSessions(next);
        setStatus("ready");
      }).catch(() => {
        if (alive) setStatus("error");
      });
    }, 150);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [engine, query]);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-8">
      <header className="mb-5 flex items-center gap-3">
        <h1 className="text-[22px] font-bold tracking-tight text-fg">Sessions</h1>
        <span className="text-xs text-dim">Claude and Codex history</span>
      </header>

      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center">
        <label className="flex min-w-0 flex-1 items-center gap-2 rounded-full border border-border bg-surface px-3 py-1.5 focus-within:border-focus">
          <SearchIcon className="size-3.5 shrink-0 text-dim" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search title, project, or path…"
            className="min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-dim"
          />
        </label>
        <Seg value={engine} options={ENGINE_OPTIONS} onChange={setEngine} />
      </div>

      {status === "loading" ? (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
          <Loader2Icon className="size-4 animate-spin" /> Loading sessions…
        </div>
      ) : null}
      {status === "error" ? (
        <p className="rounded-md border border-border px-3 py-2 text-sm text-danger">Could not load sessions.</p>
      ) : null}
      {status === "ready" && sessions.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-border bg-surface px-8 py-16 text-center">
          <MessageSquareTextIcon className="size-6 text-dim" />
          <p className="text-sm text-muted">No matching sessions.</p>
        </div>
      ) : null}

      {status === "ready" ? <div className="flex flex-col gap-2">
        {sessions.map((session) => (
          <button
            key={`${session.engine}:${session.sessionId}`}
            onClick={() => navigate(`#/sessions/${session.engine}/${encodeURIComponent(session.sessionId)}`)}
            className="flex items-start gap-3 rounded-lg border border-border bg-surface px-4 py-3 text-left transition-colors hover:border-border-hover hover:bg-bg"
          >
            <EngineBadge engine={session.engine} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-fg">
                {session.title ?? `${session.engine} session`}
              </span>
              <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-dim">
                {session.project ? <span className="inline-flex items-center gap-1"><FolderIcon className="size-3" /> {session.project}</span> : null}
                <span>{formatWhen(session.updatedAt)}</span>
              </span>
            </span>
          </button>
        ))}
      </div> : null}
    </div>
  );
}

export function SessionDetail({ engine, sessionId }: { engine: SessionEngine; sessionId: string }) {
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const [transcript, setTranscript] = useState<SessionTranscript | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [continuing, setContinuing] = useState(false);

  async function continueInBoucle() {
    if (!summary?.cwd) return;
    setContinuing(true);
    setError(null);
    try {
      const { thread } = await api.threads.create({
        engine,
        cwd: summary.cwd,
        resumeFrom: { engine, sessionId },
      });
      navigate(`#/threads/${thread.threadId}`);
    } catch (cause) {
      setError(String((cause as Error)?.message ?? cause));
      setContinuing(false);
    }
  }

  useEffect(() => {
    let alive = true;
    setError(null);
    api.sessions.get(engine, sessionId).then((result) => {
      if (!alive) return;
      setSummary(result.summary);
      setTranscript(result.transcript);
    }).catch((cause) => {
      if (alive) setError(String(cause?.message ?? cause));
    });
    return () => { alive = false; };
  }, [engine, sessionId]);

  return (
    <div className="mx-auto min-h-full w-full max-w-3xl px-4 py-5 sm:px-6">
      <header className="flex items-center gap-3 border-b border-border pb-4">
        <button onClick={() => navigate("#/sessions")} className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
          <ArrowLeftIcon className="size-4" /> Back
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-sm font-semibold text-fg">{summary?.title ?? `${engine} session`}</h1>
            <EngineBadge engine={engine} />
          </div>
          <p className="truncate font-mono text-[10px] text-dim">
            {summary?.cwd ?? sessionId}
            {summary ? ` · ${formatWhen(summary.updatedAt)}` : ""}
          </p>
        </div>
        <button
          onClick={() => void continueInBoucle()}
          disabled={!summary?.cwd || continuing}
          className="inline-flex items-center gap-1.5 rounded-full bg-btn px-3 py-1.5 text-xs font-semibold text-btn-fg disabled:opacity-40"
        >
          {continuing ? <Loader2Icon className="size-3.5 animate-spin" /> : <PlayIcon className="size-3.5" />}
          Continue in Boucle
        </button>
      </header>

      <main className="space-y-4 py-6">
        {!transcript && !error ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
            <Loader2Icon className="size-4 animate-spin" /> Loading {engine} session…
          </div>
        ) : null}
        {error ? <p className="rounded-md border border-border px-3 py-2 text-sm text-danger">{error}</p> : null}
        {transcript ? <TranscriptEntries entries={transcript.entries} /> : null}
      </main>
    </div>
  );
}
