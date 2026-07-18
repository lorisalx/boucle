import {
  ArrowLeftIcon,
  ArrowUpRightIcon,
  MessageSquareIcon,
  PlayIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { api, type Loop, type LoopInput, type LoopRun, type LoopRunStatus } from "./api.ts";
import { navigate, useLoops } from "./hooks.ts";
import { Button, Status, Switch, Tag, ThemeToggle, type Tone, cx, formatWhen } from "./ui.tsx";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/** Friendly label + tone for the model a loop runs on. */
function modelBadge(model: string | null): { label: string; tone: Tone } {
  if (!model) return { label: "codex default", tone: "neutral" };
  if (model.startsWith("claude-")) {
    // "claude-sonnet-5" → "Sonnet 5"
    const rest = model.replace(/^claude-/, "").replace(/-/g, " ");
    return { label: rest.replace(/\b\w/g, (c) => c.toUpperCase()), tone: "info" };
  }
  if (model.startsWith("gpt-")) return { label: model.toUpperCase(), tone: "success" };
  return { label: model, tone: "neutral" };
}

const STATUS_TONE: Record<LoopRunStatus, Tone> = {
  running: "info",
  ok: "success",
  error: "danger",
  timeout: "warn",
};

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function scheduleSummary(l: Loop): string {
  const every = `every ${l.intervalMinutes}m`;
  const days = l.activeDays.trim();
  const dayPart = days.length === 0 ? "every day" : days.replace(/,/g, " ");
  const hours =
    l.activeStartHour === l.activeEndHour
      ? "all day"
      : `${pad2(l.activeStartHour)}:00–${pad2(l.activeEndHour)}:00`;
  return `${every} · ${dayPart} ${hours} ${l.timezone}`;
}

function OpenConversationButton({ loop }: { loop: { threadOpenUrl?: string | null } }) {
  if (!loop.threadOpenUrl) return null;
  return (
    <a
      href={loop.threadOpenUrl}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs font-medium text-fg transition-colors hover:border-border-hover hover:bg-surface"
      title="Open this loop's persistent t3code conversation"
    >
      <MessageSquareIcon className="size-3.5" /> Open convo <ArrowUpRightIcon className="size-3" />
    </a>
  );
}

// ===============================
// List — #/loops
// ===============================

export function Loops() {
  const { loops, status, refresh } = useLoops();
  const [master, setMaster] = useState<boolean | null>(null);

  useEffect(() => {
    api.loopState().then((s) => setMaster(s.enabled)).catch(() => setMaster(false));
  }, []);

  const toggleMaster = () => {
    const next = !(master ?? false);
    setMaster(next);
    api.setLoopState(next).then((s) => setMaster(s.enabled)).catch(() => setMaster(!next));
  };

  const act = (p: Promise<unknown>) => p.then(refresh).catch((e) => alert(String(e.message ?? e)));

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-8">
      <header className="mb-6 flex items-center gap-3">
        <button
          onClick={() => navigate("#/")}
          className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg"
        >
          <ArrowLeftIcon className="size-4" /> Back
        </button>
        <span className="text-base font-semibold tracking-tight text-fg">Loops</span>
        <div className="ml-auto flex items-center gap-3">
          <button
            onClick={toggleMaster}
            title="Master switch — pause/resume the whole scheduler"
            className="inline-flex items-center gap-2 text-xs text-muted hover:text-fg"
          >
            <span>Scheduler</span>
            <Switch on={master ?? false} />
          </button>
          <Button variant="outline" onClick={() => navigate("#/loops/new")}>
            <PlusIcon className="size-3.5" /> New loop
          </Button>
          <ThemeToggle />
        </div>
      </header>

      {master === false ? (
        <p className="mb-4 flex items-center gap-2 rounded-md border border-border px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
          <span className="inline-flex size-[7px] shrink-0 rounded-full bg-amber-500" />
          The scheduler is paused — enabled loops won&apos;t run until you flip it on.
        </p>
      ) : null}

      {status === "ready" && loops.length === 0 ? (
        <p className="text-sm text-muted">No loops yet. Create one to start capturing.</p>
      ) : null}

      <div className="flex flex-col gap-2">
        {loops.map((l) => (
          <div
            key={l.loopId}
            className="flex items-start gap-3 rounded-lg border border-border bg-surface px-4 py-3"
          >
            <button
              onClick={() => act(api.loops.setEnabled(l.loopId, !l.enabled))}
              title={l.enabled ? "Enabled — click to disable" : "Disabled — click to enable"}
              className="mt-1 shrink-0"
            >
              <Switch on={l.enabled} />
            </button>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2.5">
                <button
                  onClick={() => navigate(`#/loops/${l.loopId}`)}
                  className="truncate text-left text-sm font-medium text-fg hover:underline"
                >
                  {l.name}
                </button>
                {l.isRunning ? (
                  <Status tone="info" pulse>
                    running
                  </Status>
                ) : l.lastStatus ? (
                  <Status tone={STATUS_TONE[l.lastStatus]}>{l.lastStatus}</Status>
                ) : null}
                {(() => {
                  const m = modelBadge(l.model);
                  return (
                    <Tag tone={m.tone} className="shrink-0" >
                      {m.label}
                    </Tag>
                  );
                })()}
              </div>
              {l.description ? <p className="mt-0.5 truncate text-xs text-muted">{l.description}</p> : null}
              <p className="mt-1 font-mono text-[11px] text-dim">
                {scheduleSummary(l)}
                {l.profile ? ` · ${l.profile}` : ""}
                {l.lastRunAt ? ` · last ${formatWhen(l.lastRunAt)}` : " · never run"}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <OpenConversationButton loop={l} />
              <Button
                variant="outline"
                title="Run now"
                disabled={l.isRunning}
                onClick={() => act(api.loops.run(l.loopId))}
              >
                <PlayIcon className="size-3.5" /> Run
              </Button>
              <Button
                title="Delete loop"
                onClick={() => {
                  if (confirm(`Delete loop "${l.name}"?`)) act(api.loops.remove(l.loopId));
                }}
              >
                <Trash2Icon className="size-4" />
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ===============================
// Editor + runs — #/loops/:id (or #/loops/new)
// ===============================

const NEW_DRAFT: LoopInput = {
  name: "",
  description: "",
  prompt: "",
  enabled: false,
  intervalMinutes: 60,
  activeDays: "Mon,Tue,Wed,Thu,Fri",
  activeStartHour: 8,
  activeEndHour: 18,
  timezone: "Europe/Paris",
  codexHome: "~/.codex-dataiku",
  profile: "codex-dataiku",
  model: null,
};

export function LoopDetail({ loopId }: { loopId: string }) {
  const isNew = loopId === "new";
  const [draft, setDraft] = useState<LoopInput | null>(isNew ? NEW_DRAFT : null);
  const [runs, setRuns] = useState<LoopRun[]>([]);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (isNew) return;
    api.loops.get(loopId).then(({ loop, runs }) => {
      setDraft({ ...loop });
      setRuns(runs);
    });
  }, [isNew, loopId]);

  const set = <K extends keyof LoopInput>(key: K, value: LoopInput[K]) =>
    setDraft((d) => (d ? { ...d, [key]: value } : d));

  const toggleDay = (day: string) => {
    if (!draft) return;
    const days = (draft.activeDays ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const next = days.includes(day) ? days.filter((d) => d !== day) : [...days, day];
    const ordered = WEEKDAYS.filter((d) => next.includes(d));
    set("activeDays", ordered.join(","));
  };

  const save = () => {
    if (!draft) return;
    if (!draft.name.trim() || !draft.prompt.trim()) {
      alert("Name and prompt are required.");
      return;
    }
    const op = isNew ? api.loops.create(draft) : api.loops.update(loopId, draft);
    op
      .then((loop) => {
        setSaved(true);
        setTimeout(() => setSaved(false), 1500);
        if (isNew) navigate(`#/loops/${loop.loopId}`);
      })
      .catch((e) => alert(String(e.message ?? e)));
  };

  if (!draft) return <div className="mx-auto max-w-2xl px-6 py-8 text-sm text-muted">Loading…</div>;

  const days = (draft.activeDays ?? "").split(",").map((s) => s.trim());

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-6 sm:px-6 sm:py-8">
      <div className="mb-6 flex items-center">
        <button
          onClick={() => navigate("#/loops")}
          className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg"
        >
          <ArrowLeftIcon className="size-4" /> Loops
        </button>
        <div className="ml-auto">
          <ThemeToggle />
        </div>
      </div>
      <h1 className="mb-6 text-xl font-semibold tracking-tight text-fg">{isNew ? "New loop" : draft.name}</h1>
      {!isNew && draft.threadOpenUrl ? (
        <div className="mb-5 flex items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2">
          <MessageSquareIcon className="size-4 text-dim" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-fg">Loop conversation</p>
            <p className="truncate font-mono text-xs text-dim">
              {draft.threadProject ? `${draft.threadProject} · ` : ""}{draft.threadId}
            </p>
          </div>
          <OpenConversationButton loop={draft} />
        </div>
      ) : null}

      <div className="flex flex-col gap-5">
        <Field label="Name">
          <Text value={draft.name} onChange={(v) => set("name", v)} />
        </Field>
        <Field label="Description" hint="Shown in the loop list.">
          <Text value={draft.description ?? ""} onChange={(v) => set("description", v)} />
        </Field>
        <Field label="Prompt" hint="The full instructions handed to `codex exec`.">
          <textarea
            value={draft.prompt}
            onChange={(e) => set("prompt", e.target.value)}
            rows={12}
            spellCheck={false}
            className={cx(INPUT_CLASS, "font-mono text-xs leading-relaxed")}
          />
        </Field>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Interval (minutes)">
            <Num value={draft.intervalMinutes ?? 60} onChange={(v) => set("intervalMinutes", v)} min={1} />
          </Field>
          <Field label="Timezone">
            <Text value={draft.timezone ?? "Europe/Paris"} onChange={(v) => set("timezone", v)} />
          </Field>
        </div>

        <Field label="Active days" hint="None selected = every day.">
          <div className="flex flex-wrap gap-1.5">
            {WEEKDAYS.map((d) => (
              <button
                key={d}
                onClick={() => toggleDay(d)}
                className={cx(
                  "rounded-md border px-2 py-1 text-xs font-medium",
                  days.includes(d)
                    ? "border-accent text-accent"
                    : "border-border text-muted hover:border-border-hover hover:text-fg",
                )}
              >
                {d}
              </button>
            ))}
          </div>
        </Field>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Active from (hour)" hint="0–23. Set equal to 'to' for all day.">
            <Num value={draft.activeStartHour ?? 0} onChange={(v) => set("activeStartHour", v)} min={0} max={23} />
          </Field>
          <Field label="Active to (hour)">
            <Num value={draft.activeEndHour ?? 0} onChange={(v) => set("activeEndHour", v)} min={0} max={23} />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Codex profile" hint="`codex --profile`. Blank to omit.">
            <Text value={draft.profile ?? ""} onChange={(v) => set("profile", v || null)} />
          </Field>
          <Field label="CODEX_HOME" hint="Profile dir for the spawn. Blank inherits.">
            <Text value={draft.codexHome ?? ""} onChange={(v) => set("codexHome", v || null)} />
          </Field>
        </div>

        <Field label="Model" hint="`codex -m`. Blank uses the profile default.">
          <Text value={draft.model ?? ""} onChange={(v) => set("model", v || null)} />
        </Field>

        <label className="flex items-center gap-2 text-sm text-fg">
          <input
            type="checkbox"
            checked={draft.enabled ?? false}
            onChange={(e) => set("enabled", e.target.checked)}
            className="accent-[var(--accent)]"
          />
          Enabled
        </label>

        <div className="flex items-center gap-3">
          <Button variant="primary" onClick={save}>
            {isNew ? "Create loop" : "Save"}
          </Button>
          {saved ? <span className="text-xs text-success">Saved.</span> : null}
        </div>
      </div>

      {!isNew ? (
        <section className="mt-10">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Recent runs</h2>
          {runs.length === 0 ? (
            <p className="text-xs text-dim">No runs yet.</p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {runs.map((r) => (
                <div key={r.runId} className="rounded-lg border border-border bg-surface px-3 py-2">
                  <div className="flex items-center gap-2 font-mono text-[11px] text-dim">
                    <Status tone={STATUS_TONE[r.status]} pulse={r.status === "running"}>
                      {r.status}
                    </Status>
                    <span>{formatWhen(r.startedAt)}</span>
                    <span>· {r.trigger}</span>
                    {r.exitCode !== null ? <span>· exit {r.exitCode}</span> : null}
                  </div>
                  {r.summary ? (
                    <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-muted">
                      {r.summary}
                    </pre>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-fg">{label}</span>
      {hint ? <span className="text-xs text-muted">{hint}</span> : null}
      <div className="mt-1">{children}</div>
    </label>
  );
}

const INPUT_CLASS =
  "w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm text-fg outline-none placeholder:text-dim focus:border-focus";

function Text({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return <input value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} className={INPUT_CLASS} />;
}

function Num({
  value,
  onChange,
  min,
  max,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
}) {
  return (
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      onChange={(e) => onChange(Number.parseInt(e.target.value || "0", 10))}
      className={INPUT_CLASS}
    />
  );
}
