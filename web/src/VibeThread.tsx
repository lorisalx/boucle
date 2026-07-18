import { ArrowLeftIcon, BotIcon, Loader2Icon, SendIcon, WrenchIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { api, type VibeTranscript } from "./api.ts";
import { BrainMarkdown, type WikiLinkProps } from "./Markdown.tsx";
import { Button, ThemeToggle, cx } from "./ui.tsx";

const EMPTY_WIKI: WikiLinkProps = {
  knownProjects: new Set<string>(),
  onOpenProject: () => {},
};

export function VibeThread({ scope, sessionId }: { scope: string; sessionId: string }) {
  const [thread, setThread] = useState<VibeTranscript | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    setError(null);
    api.vibe.get(scope, sessionId).then(setThread).catch((e) => setError(String(e.message ?? e)));
  }, [scope, sessionId]);

  useEffect(load, [load]);
  useEffect(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), [thread?.entries.length]);
  useEffect(() => {
    if (!thread?.running) return;
    const id = setInterval(load, 2000);
    return () => clearInterval(id);
  }, [load, thread?.running]);

  const send = () => {
    const message = text.trim();
    if (!message || sending || thread?.running) return;
    setSending(true);
    setError(null);
    api.vibe
      .send(scope, thread?.meta.sessionId ?? sessionId, message)
      .then(() => {
        setText("");
        setThread((current) => current ? { ...current, running: true } : current);
      })
      .catch((e) => setError(String(e.message ?? e)))
      .finally(() => setSending(false));
  };

  const running = sending || thread?.running === true;
  const loopId = scope.startsWith("loops_") ? scope.slice("loops_".length) : null;

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col px-4 py-5 sm:px-6">
      <header className="flex items-center gap-3 border-b border-border pb-4">
        <a href={loopId ? `/#/loops/${loopId}` : "/"} className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
          <ArrowLeftIcon className="size-4" /> Back
        </a>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold text-fg">{thread?.meta.title ?? "Vibe thread"}</h1>
          <p className="truncate font-mono text-[10px] text-dim">
            {thread?.meta.sessionId ?? sessionId}
            {thread?.meta.costUsd !== null && thread?.meta.costUsd !== undefined
              ? ` · $${thread.meta.costUsd.toFixed(4)}`
              : ""}
          </p>
        </div>
        <ThemeToggle />
      </header>

      <main className="flex-1 space-y-4 py-6">
        {!thread && !error ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
            <Loader2Icon className="size-4 animate-spin" /> Loading Vibe thread…
          </div>
        ) : null}
        {thread?.entries.map((entry, index) => {
          if (entry.role === "tool") {
            return (
              <details key={index} className="mx-auto max-w-full text-[11px] text-dim">
                <summary className="cursor-pointer list-none rounded-md border border-border px-2 py-1 hover:text-muted">
                  <span className="inline-flex items-center gap-1.5">
                    <WrenchIcon className="size-3" /> {entry.toolName ?? "Tool call"}
                  </span>
                </summary>
                <pre className="mt-1 max-h-48 max-w-2xl overflow-auto whitespace-pre-wrap rounded bg-side p-2 font-mono text-[10px]">
                  {entry.content}
                </pre>
              </details>
            );
          }
          const user = entry.role === "user";
          return (
            <div key={index} className={cx("flex", user ? "justify-end" : "justify-start")}>
              <div
                className={cx(
                  "text-sm leading-relaxed text-fg",
                  user ? "max-w-[85%] rounded-2xl bg-side px-3.5 py-2.5" : "max-w-[92%] py-1",
                )}
              >
                {!user ? <BotIcon className="mb-1.5 size-3.5 text-accent" /> : null}
                <BrainMarkdown text={entry.content} wiki={EMPTY_WIKI} skipTitle={false} />
              </div>
            </div>
          );
        })}
        {thread?.running ? (
          <div className="flex items-center gap-2 text-xs text-muted">
            <Loader2Icon className="size-3.5 animate-spin" /> Vibe running…
          </div>
        ) : null}
        <div ref={bottomRef} />
      </main>

      <footer className="sticky bottom-0 border-t border-border bg-bg py-4">
        {error ? <p className="mb-2 text-xs text-danger">{error}</p> : null}
        <div className="flex items-end gap-2 rounded-2xl border border-border bg-surface p-2 shadow-[var(--float)] focus-within:border-focus">
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") send();
            }}
            rows={2}
            disabled={running}
            placeholder={running ? "Vibe running…" : "Reply… (⌘↵ to send)"}
            className="min-h-10 flex-1 resize-none bg-transparent px-1 text-sm text-fg outline-none placeholder:text-dim"
          />
          <Button variant="primary" onClick={send} disabled={running || text.trim().length === 0}>
            {running ? <Loader2Icon className="size-3.5 animate-spin" /> : <SendIcon className="size-3.5" />}
            {running ? "Vibe running…" : "Send"}
          </Button>
        </div>
      </footer>
    </div>
  );
}
