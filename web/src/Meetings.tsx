/**
 * Meetings — read-only view of the gbrain meetings/ notes the native recorder
 * produces and the Meetings loop curates. No start/stop here: recording lives in
 * the menu bar. This just lists what got recorded, newest first, expandable to the
 * full note. Raw (not-yet-processed) drops are flagged so you know the loop is pending.
 */
import {
  ArrowUpRightIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  MicIcon,
  UsersIcon,
} from "lucide-react";
import { useState } from "react";

import type { Meeting } from "./api.ts";
import { useMeetings } from "./hooks.ts";
import { Status, Tag } from "./ui.tsx";

/** "Sat, Jul 5 · 10:15" from an ISO datetime, or the plain date if that's all we have. */
function formatMeetingDate(date: string | null): string {
  if (!date) return "—";
  const ms = Date.parse(date);
  if (Number.isNaN(ms)) return date;
  const hasTime = /T\d/.test(date);
  return new Date(ms).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(hasTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  });
}

function MeetingCard({ meeting }: { meeting: Meeting }) {
  const [open, setOpen] = useState(false);
  const attendees = meeting.attendees.slice(0, 6);
  const extra = meeting.attendees.length - attendees.length;

  return (
    <div className="rounded-lg border border-border bg-surface px-4 py-3">
      <div className="flex items-start gap-3">
        <button
          onClick={() => setOpen((o) => !o)}
          className="min-w-0 flex-1 text-left"
          title={open ? "Collapse" : "Expand"}
        >
          <div className="flex items-center gap-2.5">
            <span className="truncate text-sm font-medium text-fg">{meeting.title}</span>
            {meeting.processed ? null : (
              <Status tone="warn" pulse>
                unprocessed
              </Status>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-dim">
            <span>{formatMeetingDate(meeting.date)}</span>
            {meeting.attendees.length > 0 ? (
              <span className="inline-flex items-center gap-1">
                <UsersIcon className="size-3" />
                {attendees.join(", ")}
                {extra > 0 ? ` +${extra}` : ""}
              </span>
            ) : null}
            {meeting.actionItems.length > 0 ? (
              <span>
                {meeting.actionItems.length} action{meeting.actionItems.length === 1 ? "" : "s"}
              </span>
            ) : null}
          </div>
          {meeting.summary && !open ? (
            <p className="mt-1.5 line-clamp-2 text-xs text-muted">{meeting.summary}</p>
          ) : null}
        </button>
        <div className="flex shrink-0 items-center gap-1.5">
          {meeting.callLink ? (
            <a
              href={meeting.callLink}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] font-medium text-fg hover:border-border-hover hover:bg-bg"
              title="Open the call link"
            >
              Call <ArrowUpRightIcon className="size-3" />
            </a>
          ) : null}
          <button
            onClick={() => setOpen((o) => !o)}
            className="inline-flex size-7 items-center justify-center rounded-md text-muted hover:bg-bg hover:text-fg"
          >
            {open ? <ChevronUpIcon className="size-4" /> : <ChevronDownIcon className="size-4" />}
          </button>
        </div>
      </div>

      {meeting.tags.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {meeting.tags.map((t) => (
            <Tag key={t}>{t}</Tag>
          ))}
        </div>
      ) : null}

      {open ? (
        <div className="mt-3 border-t border-border pt-3">
          {meeting.summary ? <p className="mb-3 text-sm leading-relaxed text-fg">{meeting.summary}</p> : null}
          {meeting.actionItems.length > 0 ? (
            <div className="mb-3">
              <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">Action items</h3>
              <ul className="flex flex-col gap-1">
                {meeting.actionItems.map((item, i) => (
                  <li key={i} className="flex gap-2 text-sm text-fg">
                    <span className="text-dim">·</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <details className="group">
            <summary className="cursor-pointer text-xs font-medium text-muted hover:text-fg">
              Full note ({meeting.file})
            </summary>
            <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-bg px-3 py-2 font-mono text-[11px] leading-relaxed text-muted">
              {meeting.body}
            </pre>
          </details>
        </div>
      ) : null}
    </div>
  );
}

export function Meetings() {
  const { meetings, status } = useMeetings();
  const unprocessed = meetings.filter((m) => !m.processed).length;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-8">
      <header className="mb-6 flex items-center gap-3">
        <h1 className="text-[22px] font-bold tracking-tight text-fg">Meetings</h1>
        <div className="ml-auto flex items-center gap-3">
          {unprocessed > 0 ? (
            <span className="text-xs text-amber-600 dark:text-amber-400">
              {unprocessed} awaiting the loop
            </span>
          ) : null}
        </div>
      </header>

      <p className="mb-4 flex items-center gap-2 text-xs text-dim">
        <MicIcon className="size-3.5" />
        Recorded from the menu bar. Notes are auto-mapped to your calendar event, then the Meetings
        loop files action items as tickets.
      </p>

      {status === "error" ? (
        <div className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm text-danger">
          Could not load meetings.
        </div>
      ) : null}

      {status === "ready" && meetings.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-border bg-surface px-8 py-16 text-center">
          <MicIcon className="size-6 text-dim" />
          <p className="text-sm text-muted">No meetings recorded yet.</p>
          <p className="text-xs text-dim">Hit “Enregistrer un meeting” in the menu bar to capture one.</p>
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        {meetings.map((m) => (
          <MeetingCard key={m.file} meeting={m} />
        ))}
      </div>
    </div>
  );
}
