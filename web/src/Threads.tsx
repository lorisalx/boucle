import {
  ArrowLeftIcon,
  BotIcon,
  FolderIcon,
  Loader2Icon,
  MessageSquarePlusIcon,
  OctagonIcon,
  SendIcon,
  WrenchIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

import {
  api,
  type ProjectSummary,
  type StoredThreadEvent,
  type ThreadActivityPayload,
  type ThreadEngine,
  type ThreadRecord,
  type ThreadSnapshot,
  type ThreadStatus,
  type ThreadWireEvent,
} from "./api.ts";
import { BrainMarkdown, type WikiLinkProps } from "./Markdown.tsx";
import { Bubble, BubbleContent } from "./components/ui/bubble.tsx";
import { Message, MessageContent } from "./components/ui/message.tsx";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "./components/ui/message-scroller.tsx";
import { navigate } from "./hooks.ts";
import { Dot, Seg, Tag, cx, formatWhen } from "./ui.tsx";

const EMPTY_WIKI: WikiLinkProps = { knownProjects: new Set(), onOpenProject: () => {} };
const ENGINE_OPTIONS: ReadonlyArray<{ id: ThreadEngine; label: string }> = [
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
];

function EngineBadge({ engine }: { engine: ThreadEngine }) {
  return <Tag tone={engine === "claude" ? "accent" : "info"}>{engine}</Tag>;
}

function statusTone(status: ThreadStatus): "neutral" | "accent" | "danger" {
  return status === "running" ? "accent" : status === "error" ? "danger" : "neutral";
}

export function Threads() {
  const [threads, setThreads] = useState<ThreadRecord[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [engine, setEngine] = useState<ThreadEngine>("claude");
  const [cwd, setCwd] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([api.threads.list(), api.projects(), api.meta()]).then(([threadResult, projectResult, meta]) => {
      if (!alive) return;
      setThreads(threadResult.threads);
      setProjects(projectResult);
      setCwd(meta.workdir);
    }).catch((cause) => alive && setError(String(cause?.message ?? cause)));
    return () => { alive = false; };
  }, []);

  const projectPaths = useMemo(() => projects.map((project) => ({
    label: project.title,
    path: project.brainPath.replace(/\/[^/]+$/, ""),
  })), [projects]);

  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { thread } = await api.threads.create({ engine, cwd });
      navigate(`#/threads/${thread.threadId}`);
    } catch (cause) {
      setError(String((cause as Error)?.message ?? cause));
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-8">
      <header className="mb-5 flex items-center gap-3">
        <h1 className="text-[22px] font-bold tracking-tight text-fg">Threads</h1>
        <span className="text-xs text-dim">Live Claude and Codex conversations</span>
        <button
          onClick={() => setShowForm((value) => !value)}
          className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-btn px-3 py-1.5 text-xs font-semibold text-btn-fg hover:bg-btn-hover"
        >
          <MessageSquarePlusIcon className="size-3.5" /> New thread
        </button>
      </header>

      {showForm ? (
        <form onSubmit={create} className="mb-5 space-y-3 rounded-lg border border-border bg-surface p-4">
          <div className="flex items-center gap-3">
            <span className="text-xs font-medium text-muted">Engine</span>
            <Seg value={engine} options={ENGINE_OPTIONS} onChange={setEngine} />
          </div>
          <label className="block text-xs font-medium text-muted">
            Working directory
            <input
              list="thread-project-paths"
              value={cwd}
              onChange={(event) => setCwd(event.target.value)}
              className="mt-1.5 w-full rounded-md border border-border bg-bg px-3 py-2 font-mono text-xs text-fg outline-none focus:border-focus"
              placeholder="/path/to/project"
              required
            />
            <datalist id="thread-project-paths">
              {projectPaths.map((project) => <option key={`${project.label}:${project.path}`} value={project.path}>{project.label}</option>)}
            </datalist>
          </label>
          <div className="flex justify-end">
            <button disabled={busy} className="rounded-full bg-btn px-4 py-1.5 text-xs font-semibold text-btn-fg disabled:opacity-50">
              {busy ? "Creating…" : "Create"}
            </button>
          </div>
        </form>
      ) : null}

      {error ? <p className="mb-4 rounded-md border border-border px-3 py-2 text-sm text-danger">{error}</p> : null}
      {!error && threads.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface px-6 py-14 text-center text-sm text-muted">No live threads yet.</div>
      ) : null}
      <div className="flex flex-col gap-2">
        {threads.map((thread) => (
          <button
            key={thread.threadId}
            onClick={() => navigate(`#/threads/${thread.threadId}`)}
            className="flex items-start gap-3 rounded-lg border border-border bg-surface px-4 py-3 text-left hover:border-border-hover hover:bg-bg"
          >
            <Dot tone={statusTone(thread.status)} pulse={thread.status === "running"} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-fg">{thread.title || "New thread"}</span>
              <span className="mt-1 flex items-center gap-2 font-mono text-[10px] text-dim">
                <FolderIcon className="size-3" /> <span className="truncate">{thread.cwd}</span>
                <span className="shrink-0">{formatWhen(thread.updatedAt)}</span>
              </span>
            </span>
            <EngineBadge engine={thread.engine} />
          </button>
        ))}
      </div>
    </div>
  );
}

function isWireEvent(value: unknown): value is ThreadWireEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<ThreadWireEvent>;
  return Number.isSafeInteger(event.sequence) && (event.kind === "message" || event.kind === "activity") && !!event.payload;
}

function statusFromEvent(event: ThreadWireEvent): ThreadStatus | null {
  if (event.kind !== "activity") return null;
  if (event.payload.kind === "turn-status") {
    return event.payload.status === "running" ? "running" : "idle";
  }
  if (event.payload.tone === "error") return "error";
  return null;
}

function useThreadSocket(threadId: string) {
  const [snapshot, setSnapshot] = useState<ThreadSnapshot | null>(null);
  const [events, setEvents] = useState<StoredThreadEvent[]>([]);
  const [connection, setConnection] = useState<"connecting" | "open" | "closed">("connecting");
  const [error, setError] = useState<string | null>(null);
  const highest = useRef(0);

  useEffect(() => {
    let alive = true;
    let socket: WebSocket | null = null;
    let retry: number | undefined;

    const connect = async () => {
      setConnection("connecting");
      try {
        const next = await api.threads.get(threadId);
        if (!alive) return;
        highest.current = next.sequence;
        setSnapshot(next);
        setEvents(next.events);
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        socket = new WebSocket(`${protocol}//${window.location.host}/api/threads/${encodeURIComponent(threadId)}/ws?after=${next.sequence}`);
        socket.onopen = () => alive && setConnection("open");
        socket.onmessage = (message) => {
          let value: unknown;
          try { value = JSON.parse(String(message.data)); } catch { return; }
          if (!isWireEvent(value) || value.sequence <= highest.current) return;
          highest.current = value.sequence;
          const stored = { ...value, id: value.sequence, threadId, turnId: null, createdAt: new Date().toISOString() } as StoredThreadEvent;
          setEvents((current) => [...current, stored]);
          const status = statusFromEvent(value);
          if (status) setSnapshot((current) => current ? { ...current, thread: { ...current.thread, status } } : current);
        };
        socket.onclose = () => {
          if (!alive) return;
          setConnection("closed");
          retry = window.setTimeout(connect, 900);
        };
        socket.onerror = () => socket?.close();
      } catch (cause) {
        if (!alive) return;
        setError(String((cause as Error)?.message ?? cause));
        setConnection("closed");
        retry = window.setTimeout(connect, 1500);
      }
    };
    void connect();
    return () => {
      alive = false;
      if (retry !== undefined) window.clearTimeout(retry);
      socket?.close();
    };
  }, [threadId]);

  const setStatus = (status: ThreadStatus) => setSnapshot((current) => current ? { ...current, thread: { ...current.thread, status } } : current);
  return { snapshot, events, connection, error, setStatus };
}

type TimelineItem =
  | { type: "message"; sequence: number; role: "user" | "assistant"; content: string; streaming: boolean }
  | { type: "activity"; sequence: number; payload: ThreadActivityPayload };

function foldTimeline(events: StoredThreadEvent[]): { items: TimelineItem[]; resolutions: Map<string, string> } {
  const items: TimelineItem[] = [];
  const resolutions = new Map<string, string>();
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    if (event.kind === "activity" && event.payload.kind === "request-resolved" && event.payload.requestId) {
      resolutions.set(event.payload.requestId, event.payload.status ?? "resolved");
      continue;
    }
    if (event.kind === "activity" && event.payload.kind === "turn-status") continue;
    if (event.kind === "message") {
      const previous = items.at(-1);
      if (event.payload.role === "assistant" && previous?.type === "message" && previous.role === "assistant" && previous.streaming) {
        previous.content += event.payload.content;
        previous.streaming = event.payload.streaming === true;
        previous.sequence = event.sequence;
      } else if (event.payload.content || event.payload.role === "user") {
        items.push({
          type: "message",
          sequence: event.sequence,
          role: event.payload.role,
          content: event.payload.content,
          streaming: event.payload.streaming === true,
        });
      }
    } else {
      items.push({ type: "activity", sequence: event.sequence, payload: event.payload });
    }
  }
  return { items, resolutions };
}

function ApprovalCard({ threadId, activity, outcome }: { threadId: string; activity: ThreadActivityPayload; outcome?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = activity.requestId!;
  async function respond(next: "approve" | "deny") {
    setBusy(true);
    setError(null);
    try { await api.threads.respond(threadId, requestId, next); }
    catch (cause) { setError(String((cause as Error)?.message ?? cause)); }
    finally { setBusy(false); }
  }
  return (
    <div className="rounded-lg border border-amber-300/50 bg-amber-50/50 p-3 text-xs dark:bg-amber-950/20">
      <p className="font-semibold text-fg">{activity.summary}</p>
      {activity.payloadJson ? <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-muted">{activity.payloadJson}</pre> : null}
      {outcome ? <p className="mt-2 font-medium text-muted">{outcome === "approve" ? "Approved" : "Denied"}</p> : (
        <div className="mt-3 flex gap-2">
          <button disabled={busy} onClick={() => void respond("approve")} className="rounded-full bg-btn px-3 py-1 font-semibold text-btn-fg disabled:opacity-50">Approve</button>
          <button disabled={busy} onClick={() => void respond("deny")} className="rounded-full border border-border px-3 py-1 font-semibold text-fg disabled:opacity-50">Deny</button>
        </div>
      )}
      {error ? <p className="mt-2 text-danger">{error}</p> : null}
    </div>
  );
}

function ActivityRow({ activity, open }: { activity: ThreadActivityPayload; open: boolean }) {
  const error = activity.tone === "error";
  return (
    <details open={open} className={cx("mx-auto w-full max-w-2xl text-[11px]", error ? "text-danger" : "text-dim")}>
      <summary className="cursor-pointer list-none rounded-md border border-border px-2.5 py-1.5 hover:text-muted">
        <span className="inline-flex items-center gap-1.5"><WrenchIcon className="size-3" /> {activity.summary}</span>
        {activity.status ? <span className="ml-2 opacity-70">{activity.status}</span> : null}
      </summary>
      {activity.payloadJson ? <pre className="mt-1 max-h-52 overflow-auto whitespace-pre-wrap rounded bg-side p-2 font-mono text-[10px]">{activity.payloadJson}</pre> : null}
    </details>
  );
}

export function ThreadView({ threadId }: { threadId: string }) {
  const { snapshot, events, connection, error, setStatus } = useThreadSocket(threadId);
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const timeline = useMemo(() => foldTimeline(events), [events]);
  const thread = snapshot?.thread;
  const lastToolSequence = [...timeline.items].reverse().find((item) => item.type === "activity" && item.payload.tone === "tool")?.sequence;

  async function send() {
    const text = prompt.trim();
    if (!text || !thread || thread.status === "running") return;
    setPrompt("");
    setSending(true);
    setStatus("running");
    setActionError(null);
    try { await api.threads.send(threadId, text); }
    catch (cause) { setActionError(String((cause as Error)?.message ?? cause)); setStatus("error"); setPrompt(text); }
    finally { setSending(false); }
  }

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  }

  async function interrupt() {
    try { await api.threads.interrupt(threadId); }
    catch (cause) { setActionError(String((cause as Error)?.message ?? cause)); }
  }

  if (!thread) {
    return <div className="flex min-h-full items-center justify-center gap-2 text-sm text-muted">
      {error ? <span className="text-danger">{error}</span> : <><Loader2Icon className="size-4 animate-spin" /> Loading thread…</>}
    </div>;
  }

  return (
    <div className="flex h-full min-h-[calc(100vh-52px)] flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-border bg-surface px-4 py-3 sm:px-6">
        <button onClick={() => navigate("#/threads")} className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg"><ArrowLeftIcon className="size-4" /> Threads</button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Dot tone={statusTone(thread.status)} pulse={thread.status === "running"} />
            <h1 className="truncate text-sm font-semibold text-fg">{thread.title || "New thread"}</h1>
            <EngineBadge engine={thread.engine} />
          </div>
          <p className="truncate font-mono text-[10px] text-dim">{thread.cwd} · {connection}</p>
        </div>
        {thread.status === "running" ? (
          <button onClick={() => void interrupt()} className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs font-semibold text-fg hover:bg-side">
            <OctagonIcon className="size-3.5" /> Interrupt
          </button>
        ) : null}
      </header>

      <div className="min-h-0 flex-1">
        <MessageScrollerProvider initialStickTo="smooth">
          <MessageScroller>
            <MessageScrollerViewport>
              <MessageScrollerContent className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
                {timeline.items.length === 0 ? <div className="m-auto text-center text-sm text-muted"><BotIcon className="mx-auto mb-2 size-5 text-accent" />Start the conversation below.</div> : null}
                {timeline.items.map((item) => (
                  <MessageScrollerItem key={`${item.type}:${item.sequence}`}>
                    {item.type === "message" ? (
                      <Message align={item.role === "user" ? "end" : "start"}>
                        <MessageContent>
                          <Bubble align={item.role === "user" ? "end" : "start"} variant={item.role === "user" ? "muted" : "ghost"}>
                            <BubbleContent>
                              <BrainMarkdown text={item.content || (item.streaming ? "…" : "")} wiki={EMPTY_WIKI} skipTitle={false} />
                            </BubbleContent>
                          </Bubble>
                        </MessageContent>
                      </Message>
                    ) : item.payload.tone === "approval" && item.payload.requestId ? (
                      <ApprovalCard threadId={threadId} activity={item.payload} outcome={timeline.resolutions.get(item.payload.requestId)} />
                    ) : (
                      <ActivityRow activity={item.payload} open={thread.status === "running" && item.sequence === lastToolSequence} />
                    )}
                  </MessageScrollerItem>
                ))}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        </MessageScrollerProvider>
      </div>

      <footer className="shrink-0 border-t border-border bg-surface px-4 py-3 sm:px-6">
        <div className="mx-auto max-w-3xl">
          {actionError ? <p className="mb-2 text-xs text-danger">{actionError}</p> : null}
          <div className="flex items-end gap-2 rounded-xl border border-border bg-bg p-2 focus-within:border-focus">
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={keyDown}
              disabled={thread.status === "running" || sending}
              rows={1}
              placeholder={thread.status === "running" ? "Agent is working…" : "Message the agent…"}
              className="max-h-36 min-h-9 flex-1 resize-none bg-transparent px-2 py-2 text-sm text-fg outline-none placeholder:text-dim disabled:opacity-60"
            />
            <button
              onClick={() => void send()}
              disabled={!prompt.trim() || thread.status === "running" || sending}
              className="flex size-9 items-center justify-center rounded-full bg-btn text-btn-fg disabled:opacity-40"
              title="Send"
            >
              {sending ? <Loader2Icon className="size-4 animate-spin" /> : <SendIcon className="size-4" />}
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}
