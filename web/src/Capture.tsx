/**
 * Capture-first command palette: one surface for quick capture and search.
 *
 * Two paths out:
 *  - one-liner → creates a single item directly (Enter);
 *  - pasted blob (multi-line / long) → "AI split & route": a headless agent run
 *    splits it into typed items, routes them to projects, and merges with existing
 *    open tickets instead of duplicating. Async — items appear as the board polls.
 *
 * Open it from anywhere: press Cmd/Ctrl+K, or dispatch
 *   window.dispatchEvent(new CustomEvent("boucle:capture", { detail: { project } }))
 * (project cards use this to preset their project).
 */
import {
  BrainIcon,
  CalendarDaysIcon,
  CheckIcon,
  ChevronDownIcon,
  FolderIcon,
  HistoryIcon,
  Loader2Icon,
  MicIcon,
  PlusIcon,
  SearchIcon,
  SparklesIcon,
  SquareIcon,
  TicketIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  api,
  type ProjectSummary,
  type SearchResponse,
  type SearchSource,
  type TicketKind,
} from "./api.ts";
import { useIdentity } from "./hooks.ts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button, Dot, KIND_LABEL, KIND_ORDER, KindIcon, Status, Tag, cx, type Tone } from "./ui.tsx";

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

/** Quiet pill chip — the base for the kind / project / describe-chat controls. */
const CHIP =
  "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-border px-2.5 py-1.5 " +
  "text-xs font-medium text-muted transition-colors hover:border-border-hover hover:text-fg " +
  "aria-expanded:border-border-hover aria-expanded:text-fg";

function Kbd({ light, children }: { light?: boolean; children: string }) {
  return (
    <kbd
      className={cx(
        "rounded border px-1 font-mono text-[10px] leading-4",
        light ? "border-white/25 text-white/85" : "border-accent/35 text-accent-text",
      )}
    >
      {children}
    </kbd>
  );
}

type VoiceState = "idle" | "requesting" | "recording" | "uploading" | "success" | "error";
type CaptureKind = TicketKind | "auto";

function audioExtension(mimeType: string): string {
  const mime = mimeType.split(";", 1)[0]?.toLowerCase();
  if (mime === "audio/ogg") return "ogg";
  if (mime === "audio/mp4") return "m4a";
  if (mime === "audio/mpeg") return "mp3";
  if (mime === "audio/wav" || mime === "audio/x-wav") return "wav";
  if (mime === "audio/flac") return "flac";
  return "webm";
}

function stopTracks(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

export function openCapture(project?: string | null): void {
  window.dispatchEvent(new CustomEvent("boucle:capture", { detail: { project: project ?? null } }));
}

export function CaptureModal() {
  const identity = useIdentity();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [kind, setKind] = useState<CaptureKind>("auto");
  const [project, setProject] = useState<string>("");
  const [chat, setChat] = useState(true);
  const [busy, setBusy] = useState(false);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [filter, setFilter] = useState<SearchSource | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const discardRecordingRef = useRef(false);
  const openRef = useRef(false);
  const requestRef = useRef(0);

  // A paste that reads like a blob (multi-line or long) is AI-split territory.
  const bulk = text.includes("\n") || text.trim().length > 160;

  const resetAndOpen = useCallback((preset: string | null) => {
    setProject(preset ?? "");
    setKind("auto");
    setChat(true);
    setVoiceState("idle");
    setVoiceError(null);
    setElapsedSeconds(0);
    setSelected(null);
    if (successTimerRef.current) clearTimeout(successTimerRef.current);
    successTimerRef.current = null;
    setOpen(true);
  }, []);

  useEffect(() => {
    const onOpen = (e: Event) => {
      const preset = (e as CustomEvent<{ project: string | null }>).detail?.project ?? null;
      resetAndOpen(preset);
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        resetAndOpen(null);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("boucle:capture", onOpen);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("boucle:capture", onOpen);
      window.removeEventListener("keydown", onKey);
    };
  }, [resetAndOpen]);

  useEffect(() => {
    if (!open) return;
    setTimeout(() => inputRef.current?.focus(), 0);
    api.projects().then(setProjects).catch(() => {});
  }, [open]);

  useEffect(() => {
    const query = text.trim();
    const requestId = ++requestRef.current;
    setSearchError(null);
    setSelected(null);
    if (query.length < 2) {
      setResponse(null);
      setSearchLoading(false);
      return;
    }
    setSearchLoading(true);
    const timer = setTimeout(() => {
      api
        .search(query)
        .then((next) => {
          if (requestRef.current === requestId) setResponse(next);
        })
        .catch((cause: unknown) => {
          if (requestRef.current === requestId) {
            setSearchError(cause instanceof Error ? cause.message : String(cause));
          }
        })
        .finally(() => {
          if (requestRef.current === requestId) setSearchLoading(false);
        });
    }, 180);
    return () => clearTimeout(timer);
  }, [text]);

  useEffect(() => {
    openRef.current = open;
    if (open) return;
    discardRecordingRef.current = true;
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    stopTracks(streamRef.current);
    streamRef.current = null;
    if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
    recordingTimerRef.current = null;
  }, [open]);

  useEffect(
    () => () => {
      discardRecordingRef.current = true;
      if (recorderRef.current?.state === "recording") recorderRef.current.stop();
      stopTracks(streamRef.current);
      if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
      if (successTimerRef.current) clearTimeout(successTimerRef.current);
    },
    [],
  );

  const finish = useCallback(() => {
    setText("");
    setSelected(null);
    setOpen(false);
    window.dispatchEvent(new CustomEvent("boucle:captured"));
  }, []);

  // "" = Auto (AI finds the project), "__misc" = explicitly no project.
  const resolvedProject = project === "" || project === "__misc" ? null : project;
  const projectLabel =
    project === ""
      ? "Auto"
      : project === "__misc"
        ? "Misc"
        : (projects.find((p) => p.projectId === project)?.title ?? project);
  const voiceBusy = voiceState === "requesting" || voiceState === "recording" || voiceState === "uploading";
  const results = useMemo(() => {
    const matching = (response?.results ?? []).filter((result) => filter === null || result.source === filter);
    return SOURCE_ORDER.flatMap((source) => matching.filter((result) => result.source === source));
  }, [filter, response]);
  const actionCount = results.length + (text.trim().length > 0 ? 1 : 0);

  const submitOne = useCallback(() => {
    const t = text.trim().replace(/\s+/g, " ");
    if (!t || busy || voiceBusy) return;
    setBusy(true);
    api
      .createEpic({ title: t, project: resolvedProject, kind, chat, autoRoute: project === "" })
      .then((r) => {
        if (r.openUrl) window.open(r.openUrl, "_blank");
        finish();
      })
      .catch((e) => alert(String(e.message ?? e)))
      .finally(() => setBusy(false));
  }, [text, busy, voiceBusy, project, resolvedProject, kind, chat, finish]);

  const submitSmart = useCallback(() => {
    const t = text.trim();
    if (!t || busy || voiceBusy) return;
    setBusy(true);
    api
      .smartCapture(t, resolvedProject)
      .then(finish)
      .catch((e) => alert(String(e.message ?? e)))
      .finally(() => setBusy(false));
  }, [text, busy, voiceBusy, resolvedProject, finish]);

  const capture = useCallback(() => {
    (bulk ? submitSmart : submitOne)();
  }, [bulk, submitOne, submitSmart]);

  const close = useCallback(() => {
    setOpen(false);
    setText("");
    setSelected(null);
  }, []);

  const openResult = useCallback((url: string) => {
    close();
    assignResult(url);
  }, [close]);

  const askBrain = useCallback(() => {
    const query = text.trim();
    if (!query) return;
    sessionStorage.setItem("brainPrefill", query);
    close();
    window.location.assign("/#/brain");
  }, [close, text]);

  const uploadRecording = useCallback(
    async (blob: Blob, mimeType: string) => {
      if (blob.size === 0) {
        setVoiceError("No audio was recorded. Please try again.");
        setVoiceState("error");
        return;
      }
      setVoiceState("uploading");
      try {
        const result = await api.voiceCapture(blob, `capture.${audioExtension(mimeType)}`, resolvedProject);
        window.dispatchEvent(new CustomEvent("boucle:captured"));
        if (!openRef.current) return;
        setText(result.transcript);
        setVoiceState("success");
        successTimerRef.current = setTimeout(() => {
          setText("");
          setVoiceState("idle");
          setOpen(false);
        }, 1800);
      } catch (error) {
        setVoiceError(error instanceof Error ? error.message : "The recording could not be transcribed.");
        setVoiceState("error");
      }
    },
    [resolvedProject],
  );

  const toggleRecording = useCallback(async () => {
    if (voiceState === "recording") {
      if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
      setVoiceState("uploading");
      recorderRef.current?.stop();
      return;
    }
    if (busy || voiceState === "requesting" || voiceState === "uploading") return;
    setVoiceError(null);
    setVoiceState("requesting");
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setVoiceError("Voice capture is not supported by this browser.");
      setVoiceState("error");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!openRef.current) {
        stopTracks(stream);
        setVoiceState("idle");
        return;
      }
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      discardRecordingRef.current = false;
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onerror = () => {
        discardRecordingRef.current = true;
        stopTracks(streamRef.current);
        streamRef.current = null;
        setVoiceError("Recording failed. Please try again.");
        setVoiceState("error");
      };
      recorder.onstop = () => {
        if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
        recordingTimerRef.current = null;
        stopTracks(streamRef.current);
        streamRef.current = null;
        recorderRef.current = null;
        if (discardRecordingRef.current) return;
        const mimeType = recorder.mimeType || chunks[0]?.type || "audio/webm";
        void uploadRecording(new Blob(chunks, { type: mimeType }), mimeType);
      };
      recorder.start();
      const startedAt = Date.now();
      setElapsedSeconds(0);
      recordingTimerRef.current = setInterval(() => {
        setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
      }, 250);
      setVoiceState("recording");
    } catch (error) {
      stopTracks(streamRef.current);
      streamRef.current = null;
      const denied = error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError");
      setVoiceError(
        denied
          ? "Microphone access was denied. Allow microphone access in your browser settings, then try again."
          : "The microphone could not be started. Please check that it is available and try again.",
      );
      setVoiceState("error");
    }
  }, [busy, uploadRecording, voiceState]);

  if (!open) return null;
  const counts = response?.counts ?? EMPTY_COUNTS;

  return (
    <div
      className="fixed inset-0 z-50 flex animate-in items-start justify-center bg-black/50 px-4 pt-[12vh] fade-in-0 duration-150"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={`Capture or search ${identity.appName}`}
        className="flex max-h-[76vh] w-full max-w-2xl animate-in flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-[var(--float)] fade-in-0 zoom-in-[0.97] slide-in-from-bottom-2 duration-200 ease-out"
      >
        <div className="p-4">
          <div className="flex items-start gap-3">
            {searchLoading ? (
              <Loader2Icon className="mt-1.5 size-4 shrink-0 animate-spin text-muted" />
            ) : (
              <SearchIcon className="mt-1.5 size-4 shrink-0 text-muted" />
            )}
            <textarea
              ref={inputRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown" && actionCount > 0) {
                  e.preventDefault();
                  setSelected((value) => value === null ? 0 : (value + 1) % actionCount);
                } else if (e.key === "ArrowUp" && actionCount > 0) {
                  e.preventDefault();
                  setSelected((value) => value === null ? actionCount - 1 : (value - 1 + actionCount) % actionCount);
                } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  capture();
                } else if (e.key === "Enter" && !e.shiftKey && !bulk) {
                  e.preventDefault();
                  const result = selected === null ? undefined : results[selected];
                  if (result) openResult(result.url);
                  else if (selected === results.length) askBrain();
                  else capture();
                }
              }}
              rows={Math.min(6, Math.max(1, text.split("\n").length))}
              placeholder="Empty your head… or search"
              className="min-w-0 flex-1 resize-none bg-transparent text-[17px] leading-relaxed text-fg placeholder:text-dim focus:outline-none focus-visible:outline-none"
            />
            <Button
              variant="outline"
              onClick={() => void toggleRecording()}
              disabled={busy || voiceState === "requesting" || voiceState === "uploading" || voiceState === "success"}
              title={voiceState === "recording" ? "Stop recording" : "Record a voice capture"}
              aria-label={voiceState === "recording" ? "Stop recording" : "Start voice recording"}
              className={cx("size-9 shrink-0 p-0", voiceState === "recording" && "border-danger text-danger")}
            >
              {voiceState === "requesting" || voiceState === "uploading" ? (
                <Loader2Icon className="size-4 animate-spin" />
              ) : voiceState === "recording" ? (
                <SquareIcon className="size-3.5 fill-current" />
              ) : (
                <MicIcon className="size-4" />
              )}
            </Button>
          </div>
          {voiceState === "requesting" ? (
            <div className="mt-3"><Status pulse>Waiting for microphone permission…</Status></div>
          ) : null}
          {voiceState === "recording" ? (
            <div className="mt-3"><Status tone="danger" pulse>Recording · {elapsedSeconds}s</Status></div>
          ) : null}
          {voiceState === "uploading" ? (
            <div className="mt-3"><Status tone="accent" pulse>Transcribing and routing…</Status></div>
          ) : null}
          {voiceState === "success" ? (
            <div className="mt-3"><Status tone="success">Transcript captured — routing it now</Status></div>
          ) : null}
          {voiceError ? (
            <p role="alert" className="mt-3 text-xs text-danger">{voiceError}</p>
          ) : null}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <div className={cx("overflow-hidden transition-all duration-200", bulk ? "-ml-2 max-w-0 opacity-0" : "max-w-44 opacity-100")}>
              <DropdownMenu>
                <DropdownMenuTrigger className={CHIP} disabled={bulk} title="What is this item?">
                  {kind === "auto" ? <SparklesIcon className="size-3.5 text-accent-text" /> : <KindIcon kind={kind} />}
                  {kind === "auto" ? "Auto" : KIND_LABEL[kind]}
                  <ChevronDownIcon className="size-3 text-dim" />
                </DropdownMenuTrigger>
                <DropdownMenuContent className="w-40">
                  <DropdownMenuItem onClick={() => setKind("auto")}>
                    <SparklesIcon className="size-3.5 text-accent-text" /> Auto
                    {kind === "auto" ? <CheckIcon className="ml-auto size-3.5 text-accent-text" /> : null}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {KIND_ORDER.map((k) => (
                    <DropdownMenuItem key={k} onClick={() => setKind(k)}>
                      <KindIcon kind={k} /> {KIND_LABEL[k]}
                      {kind === k ? <CheckIcon className="ml-auto size-3.5 text-accent-text" /> : null}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger className={CHIP} title="Where it lands">
                {project === "" ? <SparklesIcon className="size-3.5 text-accent-text" /> : <FolderIcon className="size-3.5" />}
                {projectLabel}
                <ChevronDownIcon className="size-3 text-dim" />
              </DropdownMenuTrigger>
              <DropdownMenuContent className="max-h-72 w-56">
                <DropdownMenuItem onClick={() => setProject("")}>
                  <SparklesIcon className="size-3.5 text-accent-text" /> Auto — {identity.appName} routes it
                  {project === "" ? <CheckIcon className="ml-auto size-3.5 text-accent-text" /> : null}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setProject("__misc")}>
                  Misc (no project)
                  {project === "__misc" ? <CheckIcon className="ml-auto size-3.5 text-accent-text" /> : null}
                </DropdownMenuItem>
                {projects.length > 0 ? <DropdownMenuSeparator /> : null}
                {projects.map((p) => (
                  <DropdownMenuItem key={p.projectId} onClick={() => setProject(p.projectId)}>
                    {p.title}
                    {project === p.projectId ? <CheckIcon className="ml-auto size-3.5 text-accent-text" /> : null}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <button
              onClick={() => setChat(!chat)}
              title={chat
                ? "A describe-chat researches + routes it — click to land silently"
                : "Lands silently — click to start a describe-chat"}
              className={cx(CHIP, "cursor-pointer", !chat && "text-dim")}
            >
              <Dot tone={chat ? "success" : "neutral"} /> describe-chat
            </button>
            <button
              onClick={capture}
              disabled={busy || voiceBusy || text.trim().length === 0}
              className={cx(
                "ml-auto inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-xs font-medium",
                "transition-all duration-200 disabled:pointer-events-none disabled:opacity-40",
                bulk
                  ? "border-accent bg-transparent text-accent-text hover:bg-accent/10"
                  : "border-transparent bg-btn text-btn-fg hover:bg-btn-hover",
              )}
            >
              {busy ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : bulk ? (
                <SparklesIcon className="size-3.5" />
              ) : (
                <PlusIcon className="size-3.5" />
              )}
              <span>{bulk ? "AI split & route" : "Capture"}</span>
              <Kbd light={!bulk}>{bulk ? "⌘⏎" : "⏎"}</Kbd>
            </button>
          </div>
          {bulk ? (
            <p className="mt-3 text-[11px] leading-relaxed text-dim">
              Splits the paste into typed items, routes them, and merges with existing tickets (takes a minute or two).{" "}
              <button
                onClick={submitOne}
                disabled={busy || voiceBusy}
                className="text-muted underline decoration-dotted underline-offset-2 hover:text-fg disabled:opacity-40"
              >
                Capture as one item
              </button>{" "}
              instead.
            </p>
          ) : null}
        </div>

        <div className="flex flex-wrap gap-1.5 border-y border-border px-4 py-2.5">
          {SOURCE_ORDER.map((source) => (
            <button
              key={source}
              type="button"
              aria-pressed={filter === source}
              onClick={() => {
                setFilter((value) => value === source ? null : source);
                setSelected(null);
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
                      ref={(element) => {
                        if (element && selected === index) element.scrollIntoView({ block: "nearest" });
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
          {text.trim().length >= 2 && !searchLoading && results.length === 0 && !searchError ? (
            <p className="px-3 py-6 text-center text-sm text-muted">No matching results.</p>
          ) : null}
          {text.trim().length < 2 ? (
            <p className="px-3 py-6 text-center text-sm text-muted">Type at least two characters to search.</p>
          ) : null}
          {searchError ? <p className="px-3 py-3 text-xs text-danger">{searchError}</p> : null}
        </div>

        <div className="border-t border-border p-2">
          <button
            type="button"
            disabled={!text.trim()}
            onMouseEnter={() => setSelected(results.length)}
            onClick={askBrain}
            className={cx(
              "flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm disabled:opacity-40",
              selected === results.length ? "bg-side" : "hover:bg-side/70",
            )}
          >
            <BrainIcon className="size-4" /> Ask the brain about '{text}'
          </button>
        </div>
        <footer className="border-t border-border px-4 py-2 text-center text-[10px] text-dim">
          {bulk
            ? "↵ newline · ⌘↵ capture · ↑↓ results · esc close"
            : "↵ capture · ⇧↵ newline · ↑↓ results · ⌘↵ capture · esc close"}
        </footer>
      </section>
    </div>
  );
}
