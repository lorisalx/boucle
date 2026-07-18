/**
 * Quick capture (⌘K) — dump anything from your head into the right project with the
 * right kind, without leaving whatever page you're on. Replaces the Slack DM-to-self.
 *
 * Two paths out:
 *  - one-liner → creates a single item directly (Enter);
 *  - pasted blob (multi-line / long) → "AI split & route": a headless codex run
 *    splits it into typed items, routes them to projects, and merges with existing
 *    open tickets instead of duplicating. Async — items appear as the board polls.
 *
 * Open it from anywhere: press ⌘K, or dispatch
 *   window.dispatchEvent(new CustomEvent("boucle:capture", { detail: { project } }))
 * (project cards use this to preset their project).
 */
import { Loader2Icon, PlusIcon, SparklesIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { api, type ProjectSummary, type TicketKind } from "./api.ts";
import { KIND_LABEL, KIND_ORDER, KindIcon, cx } from "./ui.tsx";

export function openCapture(project?: string | null): void {
  window.dispatchEvent(new CustomEvent("boucle:capture", { detail: { project: project ?? null } }));
}

export function CaptureModal() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [kind, setKind] = useState<TicketKind>("idea");
  const [project, setProject] = useState<string>("");
  const [chat, setChat] = useState(true);
  const [busy, setBusy] = useState(false);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // A paste that reads like a blob (multi-line or long) is AI-split territory.
  const bulk = text.includes("\n") || text.trim().length > 160;

  useEffect(() => {
    const onOpen = (e: Event) => {
      const preset = (e as CustomEvent<{ project: string | null }>).detail?.project ?? null;
      setProject(preset ?? "");
      setKind(preset ? "task" : "idea");
      setChat(true);
      setOpen(true);
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        openCapture();
      }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("boucle:capture", onOpen);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("boucle:capture", onOpen);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    setTimeout(() => inputRef.current?.focus(), 0);
    api.projects().then(setProjects).catch(() => {});
  }, [open]);

  const finish = useCallback(() => {
    setText("");
    setOpen(false);
    window.dispatchEvent(new CustomEvent("boucle:captured"));
  }, []);

  // "" = Auto (AI finds the project), "__misc" = explicitly no project.
  const resolvedProject = project === "" || project === "__misc" ? null : project;

  const submitOne = useCallback(() => {
    const t = text.trim().replace(/\s+/g, " ");
    if (!t || busy) return;
    setBusy(true);
    api
      .createEpic({ title: t, project: resolvedProject, kind, chat, autoRoute: project === "" })
      .then((r) => {
        if (r.openUrl) window.open(r.openUrl, "_blank");
        finish();
      })
      .catch((e) => alert(String(e.message ?? e)))
      .finally(() => setBusy(false));
  }, [text, busy, project, resolvedProject, kind, chat, finish]);

  const submitSmart = useCallback(() => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    api
      .smartCapture(t, resolvedProject)
      .then(finish)
      .catch((e) => alert(String(e.message ?? e)))
      .finally(() => setBusy(false));
  }, [text, busy, resolvedProject, finish]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 px-4 pt-[16vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div className="w-full max-w-xl rounded-lg border border-border bg-bg p-4 shadow-lg">
        <textarea
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !bulk) {
              e.preventDefault();
              submitOne();
            }
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              (bulk ? submitSmart : submitOne)();
            }
          }}
          rows={Math.min(10, Math.max(1, text.split("\n").length))}
          placeholder="Empty your head… one line, or paste a whole Slack message"
          className="w-full resize-none bg-transparent text-base leading-relaxed text-fg placeholder:text-dim focus:outline-none"
        />
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {!bulk ? (
            <div className="flex overflow-hidden rounded-md border border-border">
              {KIND_ORDER.map((k) => (
                <button
                  key={k}
                  onClick={() => setKind(k)}
                  className={cx(
                    "inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium",
                    kind === k ? "bg-surface text-fg" : "text-dim hover:text-fg",
                  )}
                >
                  <KindIcon kind={k} /> {KIND_LABEL[k]}
                </button>
              ))}
            </div>
          ) : null}
          <select
            value={project}
            onChange={(e) => setProject(e.target.value)}
            className="rounded-md border border-border bg-transparent px-2 py-1 text-xs text-muted outline-none"
          >
            <option value="" className="bg-surface text-fg">
              ✨ Auto — Boucle routes it
            </option>
            <option value="__misc" className="bg-surface text-fg">
              Misc (no project)
            </option>
            {projects.map((p) => (
              <option key={p.projectId} value={p.projectId} className="bg-surface text-fg">
                {p.title}
              </option>
            ))}
          </select>
          {!bulk ? (
            <label className="ml-auto inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted">
              <input
                type="checkbox"
                checked={chat}
                onChange={(e) => setChat(e.target.checked)}
                className="accent-[var(--accent)]"
              />
              Start describe-chat
            </label>
          ) : (
            <button
              onClick={submitOne}
              disabled={busy}
              className="ml-auto text-xs text-dim hover:text-fg disabled:opacity-40"
            >
              Capture as one item
            </button>
          )}
          {bulk ? (
            <button
              onClick={submitSmart}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-md border border-accent px-3 py-1.5 text-xs font-medium text-accent hover:bg-accent/10 disabled:opacity-40"
            >
              {busy ? <Loader2Icon className="size-3.5 animate-spin" /> : <SparklesIcon className="size-3.5" />}
              AI split &amp; route
            </button>
          ) : (
            <button
              onClick={submitOne}
              disabled={busy || text.trim().length === 0}
              className="inline-flex items-center gap-1.5 rounded-md bg-btn px-3 py-1.5 text-xs font-medium text-btn-fg hover:bg-btn-hover disabled:opacity-40"
            >
              {busy ? <Loader2Icon className="size-3.5 animate-spin" /> : <PlusIcon className="size-3.5" />}
              Capture
            </button>
          )}
        </div>
        <p className="mt-3 text-[11px] text-dim">
          {bulk
            ? "⌘⏎ AI split & route — an agent splits the paste into typed items, routes them to projects, and merges with existing tickets (takes a minute or two)."
            : "⏎ capture · esc close — a describe-chat researches + routes it; untick to land silently."}
        </p>
      </div>
    </div>
  );
}
