import {
  Loader2Icon,
  RefreshCcwIcon,
  SearchIcon,
  SendIcon,
  SparklesIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { api, type ChatEntry } from "./api.ts";
import { Bubble, BubbleContent } from "./components/ui/bubble.tsx";
import {
  Message,
  MessageContent,
  MessageGroup,
  MessageHeader,
} from "./components/ui/message.tsx";
import {
  Marker,
  MarkerContent,
  MarkerIcon,
} from "./components/ui/marker.tsx";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "./components/ui/message-scroller.tsx";
import { BrainMarkdown, type WikiLinkProps } from "./Markdown.tsx";
import { useIdentity } from "./hooks.ts";
import { Button, Mark, Tag, cx } from "./ui.tsx";

const STORAGE_KEY = "brainChatId";
const PREFILL_KEY = "brainPrefill";
const EXAMPLES = [
  "Where does the partner portal beta stand, and who is waiting on what?",
  "Which meetings discussed the renewal alert thresholds?",
  "What are the riskiest open items on the Helium migration?",
] as const;

const EMPTY_WIKI: WikiLinkProps = {
  knownProjects: new Set<string>(),
  onOpenProject: () => {},
};

function readHashPrefill(): string {
  const hash = window.location.hash;
  const query = hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : "";
  const value = new URLSearchParams(query).get("q") ?? "";
  return value.trim();
}

function clearBrainHashQuery(): void {
  const cleanHash = "#/brain";
  if (window.location.hash !== cleanHash) window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${cleanHash}`);
}

function consumePrefill(): string {
  const stored = (sessionStorage.getItem(PREFILL_KEY) ?? "").trim();
  if (stored) {
    sessionStorage.removeItem(PREFILL_KEY);
    return stored;
  }
  const fromHash = readHashPrefill();
  if (fromHash) clearBrainHashQuery();
  return fromHash;
}

function ToolMarker({ entry }: { entry: ChatEntry }) {
  return (
    <details className="group rounded-xl border border-border bg-side/55 px-3 py-2">
      <summary className="cursor-pointer list-none">
        <Marker>
          <MarkerIcon>{entry.toolName === "brain_search" ? <SearchIcon className="size-3.5" /> : <SparklesIcon className="size-3.5" />}</MarkerIcon>
          <MarkerContent>{entry.text}</MarkerContent>
        </Marker>
      </summary>
      <p className="pt-2 text-xs leading-relaxed text-muted">Read-only tool step recorded from the brain relay.</p>
    </details>
  );
}

export function Brain() {
  const identity = useIdentity();
  const [conversationId, setConversationId] = useState<string | null>(() => localStorage.getItem(STORAGE_KEY));
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const bootRef = useRef(false);

  const loadTranscript = async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      const transcript = await api.brainChat.get(id);
      setConversationId(transcript.conversationId);
      localStorage.setItem(STORAGE_KEY, transcript.conversationId);
      setEntries(transcript.entries);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };

  const send = async (raw: string) => {
    const text = raw.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    try {
      const transcript = await api.brainChat.send(text, conversationId ?? undefined);
      setConversationId(transcript.conversationId);
      localStorage.setItem(STORAGE_KEY, transcript.conversationId);
      setEntries(transcript.entries);
      setDraft("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  };

  useEffect(() => {
    if (bootRef.current) return;
    bootRef.current = true;
    const storedId = localStorage.getItem(STORAGE_KEY);
    const prefill = consumePrefill();
    if (storedId) {
      setConversationId(storedId);
      if (!prefill) void loadTranscript(storedId);
    }
    if (prefill) {
      setDraft(prefill);
      void api.brainChat
        .send(prefill, storedId ?? undefined)
        .then((transcript) => {
          setConversationId(transcript.conversationId);
          localStorage.setItem(STORAGE_KEY, transcript.conversationId);
          setEntries(transcript.entries);
          setDraft("");
        })
        .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
        .finally(() => setSending(false));
      setSending(true);
    }
  }, []);

  useEffect(() => {
    if (!loading && !sending) setTimeout(() => textareaRef.current?.focus(), 0);
  }, [loading, sending]);

  const startNewThread = () => {
    localStorage.removeItem(STORAGE_KEY);
    sessionStorage.removeItem(PREFILL_KEY);
    clearBrainHashQuery();
    setConversationId(null);
    setEntries([]);
    setDraft("");
    setError(null);
  };

  const hasMessages = entries.some((entry) => entry.role !== "tool");

  return (
    <div className="flex h-full flex-col bg-bg">
      <header className="border-b border-border px-5 py-3">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3">
          <div>
            <h1 className="text-sm font-semibold text-fg">Talk to your brain</h1>
            <p className="text-[11px] text-muted">Projects, meetings, tickets, and synthetic brain notes in one read-only thread.</p>
          </div>
          <Button variant="ghost" onClick={startNewThread} className="text-xs">
            <RefreshCcwIcon className="size-3.5" />
            New thread
          </Button>
        </div>
      </header>

      <MessageScrollerProvider>
        <MessageScroller className="min-h-0 flex-1">
          <MessageScrollerViewport>
            <MessageScrollerContent className="mx-auto w-full max-w-3xl px-5 py-6">
              {!hasMessages && !loading ? (
                <div className="flex min-h-[46vh] flex-col items-center justify-center gap-4 text-center">
                  <Mark className="size-14 text-fg" />
                  <div className="space-y-1">
                    <h2 className="text-lg font-semibold text-fg">
                      Ask anything about {identity.orgName ? `${identity.orgName}'s` : "your"} projects, meetings, and tickets.
                    </h2>
                    <p className="text-sm text-muted">The brain only answers from search and read-only Boucle tools.</p>
                  </div>
                  <div className="flex flex-wrap justify-center gap-2">
                    {EXAMPLES.map((example) => (
                      <button
                        key={example}
                        type="button"
                        onClick={() => setDraft(example)}
                        className="rounded-full"
                      >
                        <Tag tone="neutral">{example}</Tag>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              {entries.length > 0 ? (
                <MessageGroup>
                  {entries.map((entry, index) => (
                    <MessageScrollerItem key={`${entry.role}:${index}`} scrollAnchor={index === entries.length - 1}>
                      {entry.role === "tool" ? (
                        <ToolMarker entry={entry} />
                      ) : (
                        <Message align={entry.role === "user" ? "end" : "start"}>
                          <MessageContent className={entry.role === "assistant" ? "gap-1.5" : undefined}>
                            {entry.role === "assistant" ? <MessageHeader>Brain</MessageHeader> : null}
                            <Bubble variant={entry.role === "user" ? "muted" : "ghost"} align={entry.role === "user" ? "end" : "start"}>
                              <BubbleContent className={entry.role === "user" ? "rounded-2xl px-4 py-2.5 text-[14px]" : "px-0 py-0 text-[14px] leading-7 text-fg"}>
                                {entry.role === "assistant" ? (
                                  <BrainMarkdown text={entry.text} wiki={EMPTY_WIKI} skipTitle={false} />
                                ) : (
                                  <div className="whitespace-pre-wrap">{entry.text}</div>
                                )}
                              </BubbleContent>
                            </Bubble>
                          </MessageContent>
                        </Message>
                      )}
                    </MessageScrollerItem>
                  ))}
                </MessageGroup>
              ) : null}

              {sending ? (
                <MessageScrollerItem scrollAnchor>
                  <Marker variant="separator">
                    <MarkerIcon>
                      <Loader2Icon className="size-3.5 animate-spin" />
                    </MarkerIcon>
                    <MarkerContent>searching the brain…</MarkerContent>
                  </Marker>
                </MessageScrollerItem>
              ) : null}

              {error ? (
                <MessageScrollerItem>
                  <div className="rounded-2xl border border-danger/25 bg-danger/8 px-4 py-3 text-sm text-danger">{error}</div>
                </MessageScrollerItem>
              ) : null}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>

      <div className="border-t border-border bg-[color-mix(in_srgb,var(--bg)_78%,transparent)] px-5 py-4 backdrop-blur-sm">
        <div className="mx-auto w-full max-w-3xl">
          <div className="rounded-2xl border border-border bg-surface p-3 shadow-[var(--float)]">
            <textarea
              ref={textareaRef}
              rows={1}
              value={draft}
              disabled={sending || loading}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send(draft);
                }
              }}
              placeholder="Ask the brain about a project, meeting, or ticket…"
              className="min-h-[72px] w-full resize-none bg-transparent text-[15px] leading-6 text-fg outline-none placeholder:text-dim disabled:opacity-60"
            />
            <div className="mt-3 flex items-center justify-between gap-3">
              <p className="text-[11px] text-muted">Read-only. Every answer should cite the page, ticket, or meeting it used.</p>
              <button
                type="button"
                onClick={() => void send(draft)}
                disabled={!draft.trim() || sending || loading}
                className={cx(
                  "inline-flex items-center gap-1.5 rounded-full bg-btn px-3.5 py-1.5 text-xs font-semibold text-btn-fg transition-colors disabled:pointer-events-none disabled:opacity-50",
                  "hover:bg-btn-hover",
                )}
              >
                {sending ? <Loader2Icon className="size-3.5 animate-spin" /> : <SendIcon className="size-3.5" />}
                Send
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
