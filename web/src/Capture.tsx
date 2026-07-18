/**
 * Quick capture (⌘K) — dump anything from your head into the right project with the
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
import { Loader2Icon, MicIcon, PlusIcon, SparklesIcon, SquareIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { api, type ProjectSummary, type TicketKind } from "./api.ts";
import { Button, KIND_LABEL, KIND_ORDER, KindIcon, Status, cx } from "./ui.tsx";

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
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 px-4 pt-[16vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div className="w-full max-w-xl rounded-2xl border border-border bg-surface p-4 shadow-[var(--float)]">
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
            className="min-w-0 flex-1 resize-none bg-transparent text-base leading-relaxed text-fg placeholder:text-dim focus:outline-none"
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
              ✨ Auto — Mistral Boucle routes it
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
              disabled={busy || voiceBusy}
              className="ml-auto text-xs text-dim hover:text-fg disabled:opacity-40"
            >
              Capture as one item
            </button>
          )}
          {bulk ? (
            <button
              onClick={submitSmart}
              disabled={busy || voiceBusy}
              className="inline-flex items-center gap-1.5 rounded-md border border-accent px-3 py-1.5 text-xs font-medium text-accent-text hover:bg-accent/10 disabled:opacity-40"
            >
              {busy ? <Loader2Icon className="size-3.5 animate-spin" /> : <SparklesIcon className="size-3.5" />}
              AI split &amp; route
            </button>
          ) : (
            <button
              onClick={submitOne}
              disabled={busy || voiceBusy || text.trim().length === 0}
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
