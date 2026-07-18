import { ArrowLeftIcon, BotIcon, Loader2Icon, SendIcon, WrenchIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { api, type ChatTranscript } from "./api.ts";
import { Button, ThemeToggle, cx } from "./ui.tsx";

export function Chat({ conversationId }: { conversationId: string }) {
  const [chat, setChat] = useState<ChatTranscript | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    setError(null);
    api.chat.get(conversationId).then(setChat).catch((e) => setError(String(e.message ?? e)));
  }, [conversationId]);

  useEffect(load, [load]);
  useEffect(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), [chat?.entries.length]);

  const send = () => {
    const message = text.trim();
    if (message.length === 0 || sending) return;
    setSending(true);
    setError(null);
    api.chat
      .send(conversationId, message)
      .then((next) => {
        setChat(next);
        setText("");
      })
      .catch((e) => setError(String(e.message ?? e)))
      .finally(() => setSending(false));
  };

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col px-4 py-5 sm:px-6">
      <header className="flex items-center gap-3 border-b border-border pb-4">
        <a href="/" className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
          <ArrowLeftIcon className="size-4" /> Back
        </a>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold text-fg">{chat?.ticket?.title ?? "Mistral chat"}</h1>
          <p className="truncate font-mono text-[10px] text-dim">{conversationId}</p>
        </div>
        {chat?.ticket ? (
          <a href={`/#/ticket/${chat.ticket.ticketId}`} className="text-xs text-link hover:underline">
            Open ticket
          </a>
        ) : null}
        <ThemeToggle />
      </header>

      <main className="flex-1 space-y-4 py-6">
        {!chat && !error ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
            <Loader2Icon className="size-4 animate-spin" /> Loading conversation…
          </div>
        ) : null}
        {chat?.entries.map((entry, index) => {
          if (entry.role === "tool") {
            return (
              <details key={`${entry.toolName}-${index}`} className="mx-auto w-fit text-[11px] text-dim">
                <summary className="cursor-pointer list-none rounded-md border border-border px-2 py-1 hover:text-muted">
                  <span className="inline-flex items-center gap-1.5">
                    <WrenchIcon className="size-3" /> {entry.text}
                  </span>
                </summary>
                <p className="mt-1 text-center">Mistral Boucle executed this call locally.</p>
              </details>
            );
          }
          const user = entry.role === "user";
          return (
            <div key={index} className={cx("flex", user ? "justify-end" : "justify-start")}>
              <div
                className={cx(
                  "whitespace-pre-wrap text-sm leading-relaxed text-fg",
                  user ? "max-w-[85%] rounded-2xl bg-side px-3.5 py-2.5" : "max-w-[92%] py-1",
                )}
              >
                {!user ? <BotIcon className="mb-1.5 size-3.5 text-accent" /> : null}
                {entry.text}
              </div>
            </div>
          );
        })}
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
            disabled={sending}
            placeholder="Reply… (⌘↵ to send)"
            className="min-h-10 flex-1 resize-none bg-transparent px-1 text-sm text-fg outline-none placeholder:text-dim"
          />
          <Button variant="primary" onClick={send} disabled={sending || text.trim().length === 0}>
            {sending ? <Loader2Icon className="size-3.5 animate-spin" /> : <SendIcon className="size-3.5" />}
            Send
          </Button>
        </div>
      </footer>
    </div>
  );
}
