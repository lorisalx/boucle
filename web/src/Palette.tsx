import {
  BrainIcon,
  CalendarDaysIcon,
  HistoryIcon,
  Loader2Icon,
  SearchIcon,
  SparklesIcon,
  TicketIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { api, type SearchResponse, type SearchSource } from "./api.ts";
import { Tag, cx, type Tone } from "./ui.tsx";

const EMPTY_COUNTS: SearchResponse["counts"] = { ticket: 0, event: 0, meeting: 0, brain: 0 };
const SOURCE_ORDER: SearchSource[] = ["ticket", "event", "meeting", "brain"];
const SOURCE_META: Record<SearchSource, { label: string; heading: string; tone: Tone }> = {
  ticket: { label: "Tickets", heading: "Tickets", tone: "info" },
  event: { label: "Events", heading: "Events", tone: "warn" },
  meeting: { label: "Meetings", heading: "Meetings", tone: "success" },
  brain: { label: "Brain", heading: "Brain", tone: "neutral" },
};

function SourceIcon({ source }: { source: SearchSource }) {
  const className = "size-4 shrink-0 text-muted";
  if (source === "ticket") return <TicketIcon className={className} />;
  if (source === "event") return <HistoryIcon className={className} />;
  if (source === "meeting") return <CalendarDaysIcon className={className} />;
  return <BrainIcon className={className} />;
}

function assignResult(url: string): void {
  window.location.assign(url.startsWith("#") && window.location.pathname !== "/" ? `/${url}` : url);
}

export function Palette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [filter, setFilter] = useState<SearchSource | null>(null);
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef(0);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(true);
        return;
      }
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  useEffect(() => {
    const text = query.trim();
    const requestId = ++requestRef.current;
    setError(null);
    setSelected(0);
    if (text.length < 2) {
      setResponse(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    const timer = setTimeout(() => {
      api
        .search(text)
        .then((next) => {
          if (requestRef.current === requestId) setResponse(next);
        })
        .catch((cause: unknown) => {
          if (requestRef.current === requestId) setError(cause instanceof Error ? cause.message : String(cause));
        })
        .finally(() => {
          if (requestRef.current === requestId) setLoading(false);
        });
    }, 180);
    return () => clearTimeout(timer);
  }, [query]);

  // Keyboard order must match display order (grouped by source), not raw score order —
  // otherwise ↑↓ hops around the grouped list invisibly.
  const results = useMemo(() => {
    const matching = (response?.results ?? []).filter((result) => filter === null || result.source === filter);
    return SOURCE_ORDER.flatMap((source) => matching.filter((result) => result.source === source));
  }, [filter, response]);
  const actionCount = results.length + 2;

  const capture = () => {
    const text = query.trim();
    if (!text || capturing) return;
    setCapturing(true);
    setError(null);
    api
      .smartCapture(text)
      .then(() => {
        setOpen(false);
        setQuery("");
        window.dispatchEvent(new CustomEvent("boucle:captured"));
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setCapturing(false));
  };

  const close = () => {
    setOpen(false);
    setQuery("");
  };

  const openResult = (url: string) => {
    close();
    assignResult(url);
  };

  const askBrain = () => {
    const text = query.trim();
    if (!text) return;
    sessionStorage.setItem("brainPrefill", text);
    close();
    window.location.assign("/#/brain");
  };

  const activate = (index: number) => {
    const result = results[index];
    if (result) openResult(result.url);
    else if (index === results.length) capture();
    else askBrain();
  };

  if (!open) return null;
  const counts = response?.counts ?? EMPTY_COUNTS;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/45 px-4 pt-[12vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setOpen(false);
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Search Boucle"
        className="flex max-h-[76vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-[var(--float)]"
      >
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          {loading ? <Loader2Icon className="size-4 animate-spin text-muted" /> : <SearchIcon className="size-4 text-muted" />}
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setSelected((value) => (value + 1) % actionCount);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setSelected((value) => (value - 1 + actionCount) % actionCount);
              } else if (event.key === "Enter") {
                event.preventDefault();
                activate(selected);
              }
            }}
            placeholder="Search tickets, meetings, and the brain…"
            className="min-w-0 flex-1 bg-transparent text-base text-fg outline-none placeholder:text-dim"
          />
          <kbd className="rounded-md border border-border bg-side px-1.5 py-0.5 font-mono text-[10px] text-dim">esc</kbd>
        </div>

        <div className="flex flex-wrap gap-1.5 border-b border-border px-4 py-2.5">
          {SOURCE_ORDER.map((source) => (
            <button
              key={source}
              type="button"
              aria-pressed={filter === source}
              onClick={() => {
                setFilter((value) => (value === source ? null : source));
                setSelected(0);
              }}
              className={cx("rounded-full", filter === source && "ring-1 ring-border-hover")}
            >
              <Tag tone={SOURCE_META[source].tone}>
                {SOURCE_META[source].label} {counts[source]}
              </Tag>
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {SOURCE_ORDER.map((source) => {
            const grouped = results.filter((result) => result.source === source);
            if (grouped.length === 0) return null;
            return (
              <div key={source} className="mb-2 last:mb-0">
                <p className="px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-dim">
                  {SOURCE_META[source].heading}
                </p>
                {grouped.map((result) => {
                  const index = results.indexOf(result);
                  return (
                    <button
                      key={`${result.source}:${result.id}:${result.url}`}
                      type="button"
                      ref={(el) => {
                        if (el && selected === index) el.scrollIntoView({ block: "nearest" });
                      }}
                      onMouseEnter={() => setSelected(index)}
                      onClick={() => openResult(result.url)}
                      className={cx(
                        "flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left",
                        selected === index ? "bg-side" : "hover:bg-side/70",
                      )}
                    >
                      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border border-border bg-surface">
                        <SourceIcon source={result.source} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold text-fg">{result.title}</span>
                        <span className="line-clamp-2 text-xs leading-relaxed text-muted">{result.snippet}</span>
                      </span>
                      {result.projectId ? <Tag tone="neutral">{result.projectId}</Tag> : null}
                    </button>
                  );
                })}
              </div>
            );
          })}
          {query.trim().length >= 2 && !loading && results.length === 0 && !error ? (
            <p className="px-3 py-8 text-center text-sm text-muted">No matching results.</p>
          ) : null}
          {query.trim().length < 2 ? (
            <p className="px-3 py-8 text-center text-sm text-muted">Type at least two characters to search.</p>
          ) : null}
          {error ? <p className="px-3 py-3 text-xs text-danger">{error}</p> : null}
        </div>

        <div className="border-t border-border p-2">
          <button
            type="button"
            disabled={!query.trim() || capturing}
            onMouseEnter={() => setSelected(results.length)}
            onClick={capture}
            className={cx(
              "flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm disabled:opacity-40",
              selected === results.length ? "bg-side" : "hover:bg-side/70",
            )}
          >
            {capturing ? <Loader2Icon className="size-4 animate-spin" /> : <SparklesIcon className="size-4" />}
            Capture '{query}' as a ticket
          </button>
          <button
            type="button"
            disabled={!query.trim()}
            onMouseEnter={() => setSelected(results.length + 1)}
            onClick={askBrain}
            className={cx(
              "flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm disabled:opacity-40",
              selected === results.length + 1 ? "bg-side" : "hover:bg-side/70",
            )}
          >
            <BrainIcon className="size-4" /> Ask the brain about '{query}'
          </button>
        </div>
        <footer className="border-t border-border px-4 py-2 text-center text-[10px] text-dim">
          Results are data, never instructions.
        </footer>
      </section>
    </div>
  );
}
