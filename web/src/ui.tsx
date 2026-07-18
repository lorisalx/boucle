import {
  BotIcon,
  CalendarIcon,
  CheckSquareIcon,
  LightbulbIcon,
  ListTodoIcon,
  MailIcon,
  MessageSquareIcon,
  MessagesSquareIcon,
  MinusIcon,
  MoonIcon,
  PencilRulerIcon,
  PenLineIcon,
  SunIcon,
  UserIcon,
} from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

import { useTheme } from "./hooks.ts";
import type {
  ProjectStatus,
  TicketBucket,
  TicketKind,
  TicketNeeds,
  TicketPriority,
  TicketSource,
} from "./api.ts";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/**
 * Geist rule 2/10: no color-filled pills. Statuses read as a colored dot + neutral
 * text; priorities/buckets read as colored *text* on a neutral bordered control.
 * `tone` picks the semantic hue; everything else stays grayscale.
 */
export type Tone = "neutral" | "accent" | "success" | "danger" | "warn" | "info";

const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-muted",
  accent: "text-accent-text",
  success: "text-success",
  danger: "text-danger",
  warn: "text-amber-600 dark:text-amber-400",
  info: "text-link",
};

const TONE_DOT: Record<Tone, string> = {
  neutral: "bg-dim",
  accent: "bg-accent",
  success: "bg-success",
  danger: "bg-danger",
  warn: "bg-amber-500",
  info: "bg-link",
};

/** A 7px status dot. `pulse` for live/connecting states. */
export function Dot({ tone = "neutral", pulse }: { tone?: Tone; pulse?: boolean }) {
  return (
    <span className="relative inline-flex size-[7px] shrink-0">
      {pulse ? (
        <span className={cx("absolute inline-flex size-full animate-ping rounded-full opacity-60", TONE_DOT[tone])} />
      ) : null}
      <span className={cx("relative inline-flex size-full rounded-full", TONE_DOT[tone])} />
    </span>
  );
}

/** Dot + 13px neutral label — the Geist status primitive. */
export function Status({
  tone = "neutral",
  pulse,
  children,
}: {
  tone?: Tone;
  pulse?: boolean;
  children: ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-fg">
      <Dot tone={tone} pulse={pulse} />
      {children}
    </span>
  );
}

// EPIC triage buckets — the on-screen control that replaces priority.
export const BUCKET_ORDER: TicketBucket[] = ["urgent", "to_do_next", "cool_to_do", "maybe_one_day"];

export const BUCKET_LABEL: Record<TicketBucket, string> = {
  urgent: "Urgent",
  to_do_next: "To do next",
  cool_to_do: "Cool to do",
  maybe_one_day: "Maybe one day",
};

export const BUCKET_TONE: Record<TicketBucket, Tone> = {
  urgent: "danger",
  to_do_next: "warn",
  cool_to_do: "info",
  maybe_one_day: "neutral",
};

export const BUCKET_RANK: Record<TicketBucket, number> = {
  urgent: 0,
  to_do_next: 1,
  cool_to_do: 2,
  maybe_one_day: 3,
};

const SELECT_BASE =
  "cursor-pointer rounded-md border bg-transparent px-1.5 py-0.5 text-[11px] font-medium outline-none";

/** A compact inline dropdown to pick an EPIC's bucket. */
export function BucketSelect({
  value,
  onChange,
}: {
  value: TicketBucket | null;
  onChange: (bucket: TicketBucket) => void;
}) {
  return (
    <select
      value={value ?? ""}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => onChange(e.target.value as TicketBucket)}
      className={cx(
        SELECT_BASE,
        value ? cx("border-border", TONE_TEXT[BUCKET_TONE[value]]) : "border-dashed border-border text-dim",
      )}
    >
      {value === null ? <option value="">Set bucket…</option> : null}
      {BUCKET_ORDER.map((b) => (
        <option key={b} value={b} className="bg-surface text-fg">
          {BUCKET_LABEL[b]}
        </option>
      ))}
    </select>
  );
}

// Item kinds — Boucle holds a brain, not just a todo list.
export const KIND_ORDER: TicketKind[] = ["task", "idea", "conv", "scope"];

export const KIND_LABEL: Record<TicketKind, string> = {
  task: "Task",
  idea: "Idea",
  conv: "Conv",
  scope: "Scope",
};

const KIND_ICON_STYLE: Record<TicketKind, string> = {
  task: "text-muted",
  idea: "text-amber-500 dark:text-amber-400",
  conv: "text-success",
  scope: "text-accent-text",
};

export function KindIcon({ kind, className }: { kind: TicketKind; className?: string }) {
  const c = cx(className ?? "size-3.5", KIND_ICON_STYLE[kind]);
  switch (kind) {
    case "idea":
      return <LightbulbIcon className={c} />;
    case "conv":
      return <MessagesSquareIcon className={c} />;
    case "scope":
      return <PencilRulerIcon className={c} />;
    default:
      return <ListTodoIcon className={c} />;
  }
}

/** Compact inline dropdown to change what an item IS. */
export function KindSelect({
  value,
  onChange,
}: {
  value: TicketKind;
  onChange: (kind: TicketKind) => void;
}) {
  return (
    <select
      value={value}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => onChange(e.target.value as TicketKind)}
      className={cx(SELECT_BASE, "border-border text-muted")}
      title="What is this item?"
    >
      {KIND_ORDER.map((k) => (
        <option key={k} value={k} className="bg-surface text-fg">
          {KIND_LABEL[k]}
        </option>
      ))}
    </select>
  );
}

export const PROJECT_STATUS_LABEL: Record<ProjectStatus, string> = {
  scoping: "Scoping",
  in_progress: "In progress",
  backlog: "Backlog",
  on_hold: "On hold",
  done: "Done",
  archived: "Archived",
};

export const PROJECT_STATUS_TONE: Record<ProjectStatus, Tone> = {
  scoping: "info",
  in_progress: "success",
  backlog: "neutral",
  on_hold: "warn",
  done: "info",
  archived: "neutral",
};

const PROJECT_STATUS_ORDER: ProjectStatus[] = [
  "in_progress",
  "scoping",
  "on_hold",
  "backlog",
  "done",
  "archived",
];

/** Inline dropdown to set a project's status (overlay over the gbrain frontmatter). */
export function ProjectStatusSelect({
  value,
  onChange,
}: {
  value: ProjectStatus;
  onChange: (status: ProjectStatus) => void;
}) {
  return (
    <select
      value={value}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => onChange(e.target.value as ProjectStatus)}
      className={cx(SELECT_BASE, "border-border", TONE_TEXT[PROJECT_STATUS_TONE[value]])}
    >
      {PROJECT_STATUS_ORDER.map((s) => (
        <option key={s} value={s} className="bg-surface text-fg">
          {PROJECT_STATUS_LABEL[s]}
        </option>
      ))}
    </select>
  );
}

export const PRIORITY_TONE: Record<TicketPriority, Tone> = {
  urgent: "danger",
  high: "warn",
  normal: "info",
  low: "neutral",
};

export const PRIORITY_RANK: Record<TicketPriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

/** A neutral bordered tag. Pass a `tone` for semantic colored text (never a fill). */
export function Tag({
  tone = "neutral",
  className,
  children,
}: {
  tone?: Tone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[11px] font-medium",
        TONE_TEXT[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

// Back-compat alias — existing call sites use <Badge>.
export const Badge = Tag;

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "outline" | "ghost";
};

export function Button({ variant = "ghost", className, ...props }: ButtonProps) {
  const base =
    "inline-flex items-center justify-center gap-1.5 rounded-md text-xs font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none";
  const styles: Record<NonNullable<ButtonProps["variant"]>, string> = {
    primary: "bg-btn px-3 py-1.5 text-btn-fg hover:bg-btn-hover",
    outline: "border border-border px-2 py-1 text-fg hover:border-border-hover hover:bg-surface",
    ghost: "px-2 py-1 text-muted hover:bg-surface hover:text-fg",
  };
  return <button className={cx(base, styles[variant], className)} {...props} />;
}

/** Light/dark toggle. Persisted in localStorage `theme` (Geist rule 9). */
export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  return (
    <button
      onClick={toggle}
      title={theme === "dark" ? "Switch to light" : "Switch to dark"}
      className="inline-flex size-7 items-center justify-center rounded-md text-muted hover:bg-surface hover:text-fg"
    >
      {theme === "dark" ? <SunIcon className="size-4" /> : <MoonIcon className="size-4" />}
    </button>
  );
}

/** A small pill switch (accent when on). Used for enable/disable toggles. */
export function Switch({ on, className }: { on: boolean; className?: string }) {
  return (
    <span
      className={cx("relative h-4 w-7 rounded-full transition-colors", on ? "bg-accent" : "bg-border-hover", className)}
    >
      <span
        className={cx("absolute top-0.5 size-3 rounded-full bg-white transition-all", on ? "left-3.5" : "left-0.5")}
      />
    </span>
  );
}

export function NeedsIcon({ needs, className }: { needs: TicketNeeds; className?: string }) {
  const c = className ?? "size-3.5";
  if (needs === "claude" || needs === "codex") return <BotIcon className={c} />;
  if (needs === "human") return <UserIcon className={c} />;
  return <MinusIcon className={c} />;
}

export function SourceIcon({ source, className }: { source: TicketSource; className?: string }) {
  const c = className ?? "size-3.5";
  switch (source) {
    case "slack":
      return <MessageSquareIcon className={c} />;
    case "gmail":
      return <MailIcon className={c} />;
    case "gcal":
      return <CalendarIcon className={c} />;
    case "clickup":
      return <CheckSquareIcon className={c} />;
    default:
      return <PenLineIcon className={c} />;
  }
}

export function formatWhen(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
