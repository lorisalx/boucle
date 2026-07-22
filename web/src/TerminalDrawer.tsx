import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { ArrowLeftIcon, PlusIcon, RotateCcwIcon, TerminalIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import { api } from "./api.ts";
import { navigate } from "./hooks.ts";
import { cx } from "./ui.tsx";

type TerminalStatus = "connecting" | "running" | "exited" | "disconnected";

interface TerminalBufferState {
  buffer: string;
  status: TerminalStatus;
  version: number;
}

type TerminalBufferAction =
  | { type: "snapshot"; history: string; status: "running" | "exited" }
  | { type: "output"; data: string }
  | { type: "exited" }
  | { type: "restarted" }
  | { type: "connecting" }
  | { type: "disconnected" };

const INITIAL_BUFFER: TerminalBufferState = { buffer: "", status: "connecting", version: 0 };

function terminalBufferReducer(state: TerminalBufferState, action: TerminalBufferAction): TerminalBufferState {
  switch (action.type) {
    case "snapshot":
      return { buffer: action.history, status: action.status, version: state.version + 1 };
    case "output":
      return { buffer: state.buffer + action.data, status: state.status, version: state.version + 1 };
    case "exited":
      return { ...state, status: "exited", version: state.version + 1 };
    case "restarted":
      return { buffer: "", status: "running", version: state.version + 1 };
    case "connecting":
      return { ...state, status: "connecting", version: state.version + 1 };
    case "disconnected":
      return { ...state, status: "disconnected", version: state.version + 1 };
  }
}

function isServerMessage(value: unknown): value is
  | { type: "snapshot"; history: string; status: "running" | "exited"; pid: number | null }
  | { type: "output"; data: string }
  | { type: "exited"; code: number }
  | { type: "restarted" } {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  if (message.type === "snapshot") {
    return typeof message.history === "string"
      && (message.status === "running" || message.status === "exited")
      && (message.pid === null || (typeof message.pid === "number" && Number.isInteger(message.pid)));
  }
  if (message.type === "output") return typeof message.data === "string";
  if (message.type === "exited") return typeof message.code === "number" && Number.isInteger(message.code);
  return message.type === "restarted";
}

function cssColor(styles: CSSStyleDeclaration, name: string, fallback: string): string {
  return styles.getPropertyValue(name).trim() || fallback;
}

function terminalTheme(): ITheme {
  const styles = getComputedStyle(document.documentElement);
  return {
    background: cssColor(styles, "--side", "#151412"),
    foreground: cssColor(styles, "--fg", "#f1eee7"),
    cursor: cssColor(styles, "--accent", "#fa500f"),
    selectionBackground: "rgba(250, 80, 15, 0.28)",
    black: "#1b1b19",
    brightBlack: cssColor(styles, "--dim", "#6e6b62"),
    white: "#d6d2c8",
    brightWhite: cssColor(styles, "--fg", "#f1eee7"),
  };
}

function TerminalSession({
  threadId,
  terminalId,
  visible,
  closeRequest,
  onClose,
}: {
  threadId: string;
  terminalId: string;
  visible: boolean;
  closeRequest: number;
  onClose: () => void;
}) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const previousRef = useRef<TerminalBufferState>(INITIAL_BUFFER);
  const handledCloseRequest = useRef(0);
  const closePendingRef = useRef(false);
  const onCloseRef = useRef(onClose);
  const [state, dispatch] = useReducer(terminalBufferReducer, INITIAL_BUFFER);

  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  const fitAndResize = useCallback(() => {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!terminal || !fitAddon) return;
    try { fitAddon.fit(); } catch { return; }
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
    }
  }, []);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 12,
      scrollback: 5000,
      fontFamily: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace",
      theme: terminalTheme(),
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(mount);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    const input = terminal.onData((data) => {
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "write", data }));
    });
    const resizeObserver = new ResizeObserver(() => window.requestAnimationFrame(fitAndResize));
    resizeObserver.observe(mount);
    const themeObserver = new MutationObserver(() => {
      terminal.options.theme = terminalTheme();
      terminal.refresh(0, terminal.rows - 1);
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });
    const frame = window.requestAnimationFrame(() => {
      fitAndResize();
      if (visible) terminal.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      input.dispose();
      resizeObserver.disconnect();
      themeObserver.disconnect();
      terminalRef.current = null;
      fitAddonRef.current = null;
      terminal.dispose();
    };
  }, [fitAndResize]);

  useEffect(() => {
    if (!visible) return;
    const frame = window.requestAnimationFrame(() => {
      fitAndResize();
      terminalRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [fitAndResize, visible]);

  useEffect(() => {
    let alive = true;
    let retry: number | undefined;
    let socket: WebSocket | null = null;
    const connect = () => {
      if (!alive) return;
      dispatch({ type: "connecting" });
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${window.location.host}/api/terminals/${encodeURIComponent(threadId)}/${encodeURIComponent(terminalId)}/ws`);
      socketRef.current = socket;
      socket.onopen = () => {
        if (closePendingRef.current) socket?.send(JSON.stringify({ type: "close" }));
        else window.requestAnimationFrame(fitAndResize);
      };
      socket.onmessage = (event) => {
        let message: unknown;
        try { message = JSON.parse(String(event.data)); } catch { return; }
        if (!isServerMessage(message)) return;
        if (message.type === "snapshot") dispatch({ type: "snapshot", history: message.history, status: message.status });
        else if (message.type === "output") dispatch({ type: "output", data: message.data });
        else if (message.type === "exited") dispatch({ type: "exited" });
        else dispatch({ type: "restarted" });
      };
      socket.onclose = () => {
        if (!alive) return;
        if (closePendingRef.current) {
          onCloseRef.current();
          return;
        }
        dispatch({ type: "disconnected" });
        retry = window.setTimeout(connect, 900);
      };
      socket.onerror = () => socket?.close();
    };
    connect();
    return () => {
      alive = false;
      if (retry !== undefined) window.clearTimeout(retry);
      socket?.close();
      if (socketRef.current === socket) socketRef.current = null;
    };
  }, [fitAndResize, terminalId, threadId]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || state.version === previousRef.current.version) return;
    const previous = previousRef.current;
    if (state.buffer.length >= previous.buffer.length && state.buffer.startsWith(previous.buffer)) {
      terminal.write(state.buffer.slice(previous.buffer.length));
    } else {
      terminal.write("\u001bc");
      if (state.buffer) terminal.write(state.buffer);
    }
    previousRef.current = state;
  }, [state]);

  function restart() {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "restart" }));
  }

  function close() {
    closePendingRef.current = true;
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "close" }));
  }

  useEffect(() => {
    if (closeRequest <= handledCloseRequest.current) return;
    handledCloseRequest.current = closeRequest;
    close();
  }, [closeRequest]);

  return (
    <div className={cx("relative h-full min-h-0 bg-side", visible ? "block" : "hidden")}>
      <div ref={mountRef} className="h-full w-full px-2 py-1" />
      {state.status !== "running" ? (
        <div className="absolute right-4 top-3 flex items-center gap-2 rounded-md border border-border bg-surface/95 px-2 py-1 text-[10px] text-muted shadow-sm">
          <span>{state.status}</span>
          {state.status === "exited" ? (
            <button onClick={restart} className="inline-flex items-center gap-1 font-semibold text-fg hover:text-accent">
              <RotateCcwIcon className="size-3" /> Restart
            </button>
          ) : null}
          <button onClick={close} title="Close terminal" className="text-muted hover:text-danger"><XIcon className="size-3" /></button>
        </div>
      ) : null}
    </div>
  );
}

export function TerminalDrawer({
  threadId,
  cwd,
  fullPage = false,
}: {
  threadId: string;
  cwd: string;
  fullPage?: boolean;
}) {
  const [terminalIds, setTerminalIds] = useState(["term-1"]);
  const [activeTerminalId, setActiveTerminalId] = useState("term-1");
  const [closeRequests, setCloseRequests] = useState<Record<string, number>>({});
  const nextTerminalNumber = useRef(2);

  function addTerminal() {
    const terminalId = `term-${nextTerminalNumber.current}`;
    nextTerminalNumber.current += 1;
    setTerminalIds((current) => [...current, terminalId]);
    setActiveTerminalId(terminalId);
  }

  function closeTerminal(terminalId: string) {
    setCloseRequests((current) => {
      const next = { ...current };
      delete next[terminalId];
      return next;
    });
    setTerminalIds((current) => {
      const remaining = current.filter((id) => id !== terminalId);
      const replacement = `term-${nextTerminalNumber.current}`;
      const next = remaining.length > 0 ? remaining : [replacement];
      if (remaining.length === 0) nextTerminalNumber.current += 1;
      setActiveTerminalId((currentActive) => currentActive === terminalId ? next[0]! : currentActive);
      return next;
    });
  }

  function requestClose(terminalId: string) {
    setCloseRequests((current) => ({ ...current, [terminalId]: (current[terminalId] ?? 0) + 1 }));
  }

  return (
    <section className={cx("flex min-h-0 flex-col border-t border-border bg-side", fullPage ? "h-full border-t-0" : "h-[300px] shrink-0")}>
      <div className="flex h-9 shrink-0 items-center border-b border-border bg-surface px-2">
        <TerminalIcon className="mr-2 size-3.5 text-muted" />
        {terminalIds.map((terminalId) => (
          <div key={terminalId} className={cx("flex h-full items-center border-b-2", terminalId === activeTerminalId ? "border-accent text-fg" : "border-transparent text-muted")}>
            <button onClick={() => setActiveTerminalId(terminalId)} className="h-full px-2 font-mono text-[11px]">{terminalId}</button>
            <button onClick={() => requestClose(terminalId)} title={`Close ${terminalId}`} className="mr-1 hover:text-danger"><XIcon className="size-3" /></button>
          </div>
        ))}
        <button onClick={addTerminal} title="New terminal" className="ml-1 flex size-7 items-center justify-center rounded hover:bg-side hover:text-fg"><PlusIcon className="size-3.5" /></button>
        <span className="ml-auto max-w-[45%] truncate font-mono text-[9px] text-dim">{cwd}</span>
      </div>
      <div className="min-h-0 flex-1">
        {terminalIds.map((terminalId) => (
          <TerminalSession
            key={terminalId}
            threadId={threadId}
            terminalId={terminalId}
            visible={terminalId === activeTerminalId}
            closeRequest={closeRequests[terminalId] ?? 0}
            onClose={() => closeTerminal(terminalId)}
          />
        ))}
      </div>
    </section>
  );
}

export function ProjectTerminalPage({ projectId }: { projectId: string }) {
  const [project, setProject] = useState<{ title: string; cwd: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([api.projects(), api.meta()]).then(([projects, meta]) => {
      if (!alive) return;
      const match = projects.find((candidate) => candidate.projectId === projectId);
      if (!match) throw new Error("Project not found");
      setProject({ title: match.title, cwd: meta.workdir });
    }).catch((cause) => alive && setError(String((cause as Error)?.message ?? cause)));
    return () => { alive = false; };
  }, [projectId]);

  if (!project) return <div className="flex h-full items-center justify-center text-sm text-muted">{error ?? "Loading terminal…"}</div>;
  return (
    <div className="flex h-[calc(100vh-52px)] min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-surface px-4">
        <button onClick={() => navigate(`#/projects/${encodeURIComponent(projectId)}`)} className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
          <ArrowLeftIcon className="size-4" /> Projects
        </button>
        <h1 className="truncate text-sm font-semibold text-fg">{project.title} terminal</h1>
      </header>
      <div className="min-h-0 flex-1">
        <TerminalDrawer threadId={`project_${projectId}`} cwd={project.cwd} fullPage />
      </div>
    </div>
  );
}
