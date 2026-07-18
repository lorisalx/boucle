import {
  ArrowLeftIcon,
  ArrowUpRightIcon,
  BotIcon,
  CheckIcon,
  CheckSquareIcon,
  ClockIcon,
  CopyIcon,
  FlagIcon,
  FolderIcon,
  Link2Icon,
  Loader2Icon,
  MessageSquareIcon,
  PencilIcon,
  SparklesIcon,
  XIcon,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";

import { api, type Ticket, type TicketEvent, type TicketPriority } from "./api.ts";
import { navigate } from "./hooks.ts";
import { isMistralConversationId, useActions } from "./Home.tsx";
import {
  Button,
  KindIcon,
  KindSelect,
  NeedsIcon,
  PRIORITY_TONE,
  SourceIcon,
  Tag,
  ThemeToggle,
  formatWhen,
} from "./ui.tsx";

function eventIcon(kind: TicketEvent["kind"]): ReactNode {
  const c = "size-3.5";
  switch (kind) {
    case "created":
      return <SparklesIcon className={c} />;
    case "status":
      return <CheckIcon className={c} />;
    case "priority":
      return <FlagIcon className={c} />;
    case "project":
      return <FolderIcon className={c} />;
    case "chat":
      return <MessageSquareIcon className={c} />;
    case "clickup":
      return <CheckSquareIcon className={c} />;
    default:
      return <PencilIcon className={c} />;
  }
}

const PRIORITIES: TicketPriority[] = ["urgent", "high", "normal", "low"];

/** Show whatever resolved a ticket: a Claude resume command (copyable), a URL (link), or plain text. */
function LinkedWork({ workRef }: { workRef: string }) {
  const [copied, setCopied] = useState(false);
  const isResume = /claude\s+(--resume|-r)\b/.test(workRef);
  const isUrl = /^https?:\/\//.test(workRef.trim());
  const copy = () => {
    navigator.clipboard?.writeText(workRef).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  };
  return (
    <div className="mt-4 rounded-lg border border-border bg-bg px-3 py-2">
      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">
        <Link2Icon className="size-3" /> Resolved by
      </div>
      {isUrl ? (
        <a
          href={workRef.trim()}
          target="_blank"
          rel="noreferrer"
          className="text-sm text-link underline decoration-dotted hover:no-underline"
        >
          {workRef.trim()}
        </a>
      ) : (
        <div className="flex items-start gap-2">
          <code className="min-w-0 flex-1 whitespace-pre-wrap break-all rounded bg-surface px-2 py-1 font-mono text-xs text-muted">
            {workRef}
          </code>
          {isResume ? (
            <Button variant="outline" title="Copy resume command" onClick={copy}>
              {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
              {copied ? "Copied" : "Copy"}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}

export function TicketDetail({ ticketId }: { ticketId: string }) {
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [events, setEvents] = useState<TicketEvent[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "missing">("loading");
  const [note, setNote] = useState("");
  const [enriching, setEnriching] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const refetch = useCallback(() => {
    api
      .get(ticketId)
      .then((r) => {
        setTicket(r.ticket);
        setEvents(r.events);
        setEnriching(r.enriching);
        setState(r.ticket ? "ready" : "missing");
      })
      .catch(() => setState("missing"));
  }, [ticketId]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  // While a codex re-run is in flight, poll so the timeline + updated fields appear live.
  useEffect(() => {
    if (!enriching) return;
    const id = setInterval(refetch, 5000);
    return () => clearInterval(id);
  }, [enriching, refetch]);

  const submitEnrich = useCallback(() => {
    const text = note.trim();
    if (text.length === 0 || submitting || enriching) return;
    setSubmitting(true);
    api
      .enrich(ticketId, text)
      .then(() => {
        setNote("");
        setEnriching(true);
        refetch();
      })
      .catch((e) => alert(`Re-run failed: ${e.message ?? e}`))
      .finally(() => setSubmitting(false));
  }, [note, submitting, enriching, ticketId, refetch]);

  const actions = useActions(refetch);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-8">
      <div className="mb-4 flex items-center">
        <button
          onClick={() => navigate("#/")}
          className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg"
        >
          <ArrowLeftIcon className="size-4" /> Back
        </button>
        <div className="ml-auto">
          <ThemeToggle />
        </div>
      </div>

      {state === "missing" ? (
        <div className="rounded-lg border border-border bg-surface px-8 py-12 text-center text-sm text-muted">
          This ticket could not be found.
        </div>
      ) : null}

      {ticket ? (
        <>
          <div className="rounded-lg border border-border bg-surface p-5">
            <div className="flex items-start gap-3">
              <Tag tone={PRIORITY_TONE[ticket.priority]} className="mt-0.5 shrink-0">
                {ticket.priority}
              </Tag>
              <div className="min-w-0 flex-1">
                <h1 className="text-xl font-semibold tracking-tight text-fg">{ticket.title}</h1>
                <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted">
                  <Tag>{ticket.status}</Tag>
                  <span className="inline-flex items-center gap-1">
                    <KindIcon kind={ticket.kind} /> {ticket.kind}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <SourceIcon source={ticket.source} /> {ticket.source}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <NeedsIcon needs={ticket.needs} /> {ticket.needs}
                  </span>
                  {ticket.project ? (
                    <span className="inline-flex items-center gap-1">
                      <FolderIcon className="size-3" /> {ticket.project}
                    </span>
                  ) : null}
                  {ticket.requester ? <span>· from {ticket.requester}</span> : null}
                  {ticket.permalink ? (
                    <a
                      href={ticket.permalink}
                      target="_blank"
                      rel="noreferrer"
                      className="text-link underline decoration-dotted hover:no-underline"
                    >
                      open source
                    </a>
                  ) : null}
                </div>
                {ticket.nextAction ? (
                  <p className="mt-3 text-sm text-fg">
                    <span className="text-muted">Next action:</span> {ticket.nextAction}
                  </p>
                ) : null}
                {ticket.body.trim().length > 0 ? (
                  <p className="mt-3 whitespace-pre-wrap text-sm text-muted">{ticket.body}</p>
                ) : null}
              </div>
            </div>

            {ticket.workRef ? <LinkedWork workRef={ticket.workRef} /> : null}

            <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-4">
              {isMistralConversationId(ticket.threadId) ? (
                <Button variant="outline" onClick={() => actions.openChat(ticket.threadId)}>
                  <MessageSquareIcon className="size-3.5" /> Open chat
                </Button>
              ) : (
                <Button variant="outline" onClick={() => actions.startChat(ticket.ticketId)}>
                  <MessageSquareIcon className="size-3.5" /> Start chat
                </Button>
              )}
              {ticket.clickupTaskId ? (
                <a
                  href={`https://app.clickup.com/t/${ticket.clickupTaskId}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium text-link hover:border-border-hover hover:bg-bg"
                >
                  ClickUp <ArrowUpRightIcon className="size-3" />
                </a>
              ) : ticket.wantsClickup ? (
                <Button variant="outline" onClick={() => actions.cancelClickup(ticket.ticketId)}>
                  ClickUp queued — cancel
                </Button>
              ) : (
                <Button variant="outline" onClick={() => actions.promoteClickup(ticket.ticketId)}>
                  <CheckSquareIcon className="size-3.5" /> Create ClickUp task
                </Button>
              )}

              <div className="ml-auto flex items-center gap-1">
                <KindSelect
                  value={ticket.kind}
                  onChange={(kind) => api.setFields(ticket.ticketId, { kind }).then(refetch).catch((e) => alert(String(e.message ?? e)))}
                />
                <select
                  value={ticket.priority}
                  onChange={(e) => actions.setPriority(ticket.ticketId, e.target.value as TicketPriority)}
                  className="rounded-md border border-border bg-transparent px-1.5 py-1 text-xs text-muted outline-none"
                  title="Set priority"
                >
                  {PRIORITIES.map((p) => (
                    <option key={p} value={p} className="bg-surface text-fg">
                      {p}
                    </option>
                  ))}
                </select>
                <Button onClick={() => actions.done(ticket.ticketId)}>
                  <CheckIcon className="size-4" /> Done
                </Button>
                <Button title="Snooze 1 day" onClick={() => actions.snooze(ticket.ticketId)}>
                  <ClockIcon className="size-4" />
                </Button>
                <Button title="Drop" onClick={() => actions.drop(ticket.ticketId)}>
                  <XIcon className="size-4" />
                </Button>
              </div>
            </div>

            <div className="mt-4 border-t border-border pt-4">
              <label className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted">
                <SparklesIcon className="size-3.5" /> Add context &amp; re-run codex
              </label>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submitEnrich();
                }}
                rows={2}
                placeholder="What did the capture get wrong or miss? e.g. the linked project is slack-salesforce-updater; “Louis” is actually me (Loris). ⌘↵ to send."
                className="w-full resize-y rounded-md border border-border bg-transparent px-2.5 py-2 text-sm text-fg placeholder:text-dim focus:border-focus focus:outline-none"
              />
              <div className="mt-2 flex items-center gap-3">
                <Button
                  variant="outline"
                  onClick={submitEnrich}
                  disabled={submitting || enriching || note.trim().length === 0}
                >
                  {enriching ? (
                    <>
                      <Loader2Icon className="size-3.5 animate-spin" /> Codex running…
                    </>
                  ) : (
                    <>
                      <BotIcon className="size-3.5" /> Re-run codex
                    </>
                  )}
                </Button>
                <span className="text-xs text-muted">
                  {enriching
                    ? "Re-investigating across Slack, Drive, ClickUp… this can take a few minutes."
                    : "Codex searches for more context and updates this ticket in place."}
                </span>
              </div>
            </div>
          </div>

          <section className="mt-8">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">Timeline</h2>
            <ol className="relative ml-1 border-l border-border">
              {events.toReversed().map((e) => (
                <li key={e.eventId} className="relative pb-4 pl-5 last:pb-0">
                  <span className="absolute -left-[7px] top-0.5 flex size-3.5 items-center justify-center rounded-full bg-bg text-muted ring-1 ring-border">
                    {eventIcon(e.kind)}
                  </span>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-sm text-fg">{e.summary}</span>
                    <span className="shrink-0 font-mono text-[11px] tabular-nums text-dim">{formatWhen(e.at)}</span>
                  </div>
                </li>
              ))}
              {events.length === 0 ? <li className="pl-5 text-xs text-dim">No activity yet.</li> : null}
            </ol>
          </section>
        </>
      ) : null}
    </div>
  );
}
