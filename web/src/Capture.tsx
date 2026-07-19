/**
 * Quick capture — dump anything from your head into the right project with the
 * right kind, without leaving whatever page you're on. Replaces the Slack DM-to-self.
 *
 * Two paths out:
 *  - one-liner → creates a single item directly (Enter);
 *  - pasted blob (multi-line / long) → "AI split & route": a headless Vibe run
 *    splits it into typed items, routes them to projects, and merges with existing
 *    open tickets instead of duplicating. Async — items appear as the board polls.
 *
 * Open it from anywhere: press ⌘K, or dispatch
 *   window.dispatchEvent(new CustomEvent("boucle:capture", { detail: { project } }))
 * (project cards use this to preset their project).
 */
import {
  CheckIcon,
  ChevronDownIcon,
  FolderIcon,
  Loader2Icon,
  MicIcon,
  PlusIcon,
  SparklesIcon,
  SquareIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { api, type ProjectSummary, type TicketKind } from "./api.ts";
import { useIdentity } from "./hooks.ts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button, Dot, KIND_LABEL, KIND_ORDER, KindIcon, Status, cx } from "./ui.tsx";

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
  const [kind, setKind] = useState<TicketKind>("idea");
  const [project, setProject] = useState<string>("");
  const [chat, setChat] = useState(true);
  const [busy, setBusy] = useState(false);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
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

  // A paste that reads like a blob (multi-line or long) is AI-split territory.
  const bulk = text.includes("\n") || text.trim().length > 160;

  useEffect(() => {
    const onOpen = (e: Event) => {
      const preset = (e as CustomEvent<{ project: string | null }>).detail?.project ?? null;
      setProject(preset ?? "");
      setKind(preset ? "task" : "idea");
      setChat(true);
      setVoiceState("idle");
      setVoiceError(null);
      setElapsedSeconds(0);
      if (successTimerRef.current) clearTimeout(successTimerRef.current);
      successTimerRef.current = null;
      setOpen(true);
    };
    const onKey = (e: KeyboardEvent) => {
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

  return (
    <div
      className="fixed inset-0 z-50 flex animate-in items-start justify-center bg-black/50 px-4 pt-[16vh] fade-in-0 duration-150"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div className="w-full max-w-xl animate-in rounded-2xl border border-border bg-surface p-4 shadow-[var(--float)] fade-in-0 zoom-in-[0.97] slide-in-from-bottom-2 duration-200 ease-out">
        <div className="flex items-start gap-3">
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
          <div className="mt-3">
            <Status pulse>Waiting for microphone permission…</Status>
          </div>
        ) : null}
        {voiceState === "recording" ? (
          <div className="mt-3">
            <Status tone="danger" pulse>
              Recording · {elapsedSeconds}s
            </Status>
          </div>
        ) : null}
        {voiceState === "uploading" ? (
          <div className="mt-3">
            <Status tone="accent" pulse>
              Transcribing and routing…
            </Status>
          </div>
        ) : null}
        {voiceState === "success" ? (
          <div className="mt-3">
            <Status tone="success">Transcript captured — routing it now</Status>
          </div>
        ) : null}
        {voiceError ? (
          <p role="alert" className="mt-3 text-xs text-danger">
            {voiceError}
          </p>
        ) : null}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <div
            className={cx(
              "overflow-hidden transition-all duration-200",
              bulk ? "-ml-2 max-w-0 opacity-0" : "max-w-44 opacity-100",
            )}
          >
            <DropdownMenu>
              <DropdownMenuTrigger className={CHIP} disabled={bulk} title="What is this item?">
                <KindIcon kind={kind} /> {KIND_LABEL[kind]}
                <ChevronDownIcon className="size-3 text-dim" />
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-40">
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
              {project === "" ? (
                <SparklesIcon className="size-3.5 text-accent-text" />
              ) : (
                <FolderIcon className="size-3.5" />
              )}
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
            title={chat ? "A describe-chat researches + routes it — click to land silently" : "Lands silently — click to start a describe-chat"}
            className={cx(CHIP, "cursor-pointer", !chat && "text-dim")}
          >
            <Dot tone={chat ? "success" : "neutral"} /> describe-chat
          </button>
          <button
            onClick={bulk ? submitSmart : submitOne}
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
            <span key={bulk ? "bulk" : "one"} className="animate-in fade-in-0 duration-150">
              {bulk ? "AI split & route" : "Capture"}
            </span>
            <Kbd light={!bulk}>{bulk ? "⌘⏎" : "⏎"}</Kbd>
          </button>
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-dim">
          {bulk ? (
            <>
              Splits the paste into typed items, routes them, and merges with existing tickets (takes a minute or
              two).{" "}
              <button
                onClick={submitOne}
                disabled={busy || voiceBusy}
                className="text-muted underline decoration-dotted underline-offset-2 hover:text-fg disabled:opacity-40"
              >
                Capture as one item
              </button>{" "}
              instead.
            </>
          ) : (
            <>
              <span className="font-medium text-muted">⏎</span> capture · <span className="font-medium text-muted">esc</span> close
            </>
          )}
        </p>
      </div>
    </div>
  );
}
