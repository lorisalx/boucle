# Cockpit plan — sessions inbox, live threads, web terminal

Goal: live inside Boucle even while developing. Three milestones, shipped in order,
each independently useful and committed separately. Engines: **claude and codex only**.
Architecture strongly inspired by t3code (reference clone for consultation:
`/tmp/t3code`) but drastically simplified for single-user self-hosted.

Non-goals: multi-tenant, other engines (vibe/gemini/opencode), event-sourced CQRS,
Electron/mobile, preview browsers, relay/cloud auth. The existing loops/runners/tickets
subsystems are untouched; threads are a new subsystem beside them.

Core design decision (lifted from t3code): **the agent never runs inside the terminal.**
Chat threads use structured runtimes — the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)
and `codex app-server` (JSON-RPC over stdio) — which give typed streaming events,
native approval requests, and interrupts. The web terminal is a separate plain shell
(node-pty) opened in the thread's cwd. No ANSI parsing to build chat, no jsonl tailing
for live state.

This adds runtime dependencies (`@anthropic-ai/claude-agent-sdk`, `@hono/node-ws`,
`node-pty`; web: `@xterm/xterm`, `@xterm/addon-fit`). That is a deliberate break from
the zero-runtime-deps doctrine, confined to these features.

Repo facts the implementation must reuse (verified):

- Server is Hono on `@hono/node-server` (`src/server.ts`), SQLite via `node:sqlite`
  (`src/store.ts`, additive migrations via `PRAGMA user_version` in `migrateSteps()`).
- No WS/SSE exists anywhere today; web UI polls. Auth: optional bearer/`boucle_auth`
  cookie middleware on `/api/*` (`server.ts:121`). WS upgrades MUST enforce the same check.
- Claude transcript discovery + jsonl parser already exist: `src/claude.ts:101-142`
  (`~/.claude/projects/<munged-cwd>/<sessionId>.jsonl`). Codex rollout parser:
  `src/codex.ts:113-185`. Both normalize to `Transcript`/`TranscriptEntry` (`src/runner.ts`).
- Path-containment security template for file-reading endpoints: `src/vibe-transcript.ts`
  (realpath + `isInside` + strict id regexes). Copy this pattern for every new
  file-reading route.
- Web: React 19 + Vite + Tailwind 4, no router lib — regex routes in `web/src/App.tsx`,
  nav in `web/src/Shell.tsx` (`CORE_NAV`), API client in `web/src/api.ts`, UI kit in
  `web/src/ui.tsx` + shadcn primitives in `web/src/components/ui/` (message, bubble,
  message-scroller already exist), markdown via `web/src/Markdown.tsx`.
- Verification gates: `pnpm typecheck`, `node --test src/*.test.ts` (individual
  `*.test.ts` files run with `node --test`), `pnpm --dir web build`.

User session stores to index (verified on this machine):

- Claude Code: `~/.claude/projects/<munged-cwd>/<uuid>.jsonl`; lines carry `type`
  (`user`/`assistant`/`summary`…), `message.content` blocks, `timestamp`, `sessionId`, `cwd`.
- Codex CLI: `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`; first line
  `{"type":"session_meta","payload":{"session_id","cwd","originator","source",...}}`,
  then `event_msg` payloads (`user_message`/`agent_message`/`task_complete`/`token_count`)
  and `response_item` payloads (`message`, `custom_tool_call(+_output)`, `reasoning`).
  `~/.codex/session_index.jsonl` provides `{id, thread_name, updated_at}` for titles.
  Also `~/.codex/archived_sessions`. Env overrides: `BOUCLE_CLAUDE_HOME` (default
  `~/.claude`), `BOUCLE_CODEX_HOME` (default `~/.codex`).

---

## Milestone 1 — Sessions inbox (read-only)

Every claude/codex session on this machine, listed and readable inside Boucle.

### Backend

New `src/sessions-index.ts`:

```ts
export interface SessionSummary {
  engine: "claude" | "codex";
  sessionId: string;
  title: string | null;       // codex: session_index.jsonl thread_name; claude: first user message, truncated
  cwd: string | null;
  project: string | null;     // basename of cwd
  startedAt: string | null;
  updatedAt: string;          // file mtime, ISO
  filePath: string;
  sizeBytes: number;
}
export function listSessions(opts?: { engine?; q?; limit? }): Promise<SessionSummary[]>
export function readSession(engine, sessionId): Promise<Transcript | null>
```

- Enumerate both stores. Cheap listing: `fs.stat` mtime + parse only the head of each
  file (claude: first ~30 lines for cwd/title/sessionId; codex: first line for
  `session_meta`, titles joined from `session_index.jsonl`). In-memory cache keyed by
  `filePath` invalidated by `(mtime, size)` — listing must stay fast with thousands of files.
- `readSession` reuses/refactors the existing parsers: export the claude jsonl parser
  from `src/claude.ts` and the codex rollout entry mapper from `src/codex.ts` rather than
  duplicating them. Codex sessions from `~/.codex` (not just Boucle's `var/codex`).
  Normalize both to the existing `Transcript` type. Skip `reasoning` (encrypted) and
  meta rows; map codex `custom_tool_call`/`function_call`/`local_shell_call` (+outputs)
  to `role:"tool"` entries with `toolName`.
- Session ids validated with strict regexes; resolved paths must pass containment
  checks under their store root (vibe-transcript pattern).

Routes in `src/server.ts` (behind existing auth middleware):

- `GET /api/sessions?engine=&q=&limit=` → `{ sessions: SessionSummary[] }`, sorted by
  `updatedAt` desc, default limit 100. `q` filters title/project/cwd, case-insensitive.
- `GET /api/sessions/:engine/:sessionId` → `{ summary, transcript }`.

### Web

- New page `web/src/Sessions.tsx`, hash route `#/sessions`, nav entry "Sessions" in
  `CORE_NAV` (Shell.tsx) with a lucide icon. List rows: engine badge (claude/codex),
  title, project, relative time (`formatWhen`), search input, engine filter tabs.
- Clicking a row opens the transcript: reuse the rendering approach of
  `web/src/VibeThread.tsx` (markdown bubbles, tool calls as collapsible `<details>`)
  — extract shared pieces rather than copy-pasting where reasonable. Route
  `#/sessions/:engine/:sessionId` (hash, since path routes need server fallback anyway).
- `web/src/api.ts`: `api.sessions.list(params)`, `api.sessions.get(engine, id)`.

### Tests

`src/sessions-index.test.ts` with fixture jsonl files (both formats, written to a temp
dir; point the indexer at it via the env overrides): listing, title extraction, mtime
cache invalidation, malformed lines skipped, containment rejection, codex tool-call
mapping.

Definition of done: typecheck + tests + web build green; `GET /api/sessions` returns
real sessions on this machine; transcripts render.

---

## Milestone 2 — Live threads (chat with claude/codex, resume included)

A "Threads" page where a conversation with claude or codex runs live inside Boucle:
streaming responses, tool activity, approvals, interrupt — and any inbox session can be
continued as a live thread. This subsumes the old "resume as a headless run" idea.

### Storage (`src/store.ts`, new migration step)

```sql
CREATE TABLE threads (
  thread_id TEXT PRIMARY KEY, engine TEXT NOT NULL CHECK (engine IN ('claude','codex')),
  title TEXT NOT NULL DEFAULT '', cwd TEXT NOT NULL, status TEXT NOT NULL,           -- idle|running|error
  resume_cursor TEXT,                    -- opaque JSON, engine-specific
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE thread_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, sequence INTEGER NOT NULL,
  kind TEXT NOT NULL,                    -- message|activity
  payload_json TEXT NOT NULL, turn_id TEXT, created_at TEXT NOT NULL
);
CREATE INDEX idx_thread_events ON thread_events(thread_id, sequence);
```

Messages: `{role: 'user'|'assistant', content, streaming?}` — assistant text split into a
new message at each tool boundary (t3code's segment rule). Activities:
`{tone: 'tool'|'approval'|'error'|'info', kind, summary, payloadJson?, status?}`.
Per-thread monotonic `sequence` assigned by the thread manager.

### Canonical runtime events (`src/threads/events.ts`)

One union both adapters translate into (~12 types, zod-validated):
`session.started {nativeSessionId}`, `turn.started {turnId}`, `turn.completed`,
`turn.aborted`, `content.delta {text}`, `message.completed {text}`,
`activity {tone,kind,summary,payload?,status}`, `request.opened {requestId,kind,summary,payload}`,
`request.resolved {requestId,outcome}`, `token-usage {input,output}`, `error {message}`.
Raw native events additionally appended to `var/threads/<threadId>.ndjson` for debugging.

### Adapters (`src/threads/claude-adapter.ts`, `src/threads/codex-adapter.ts`)

Common interface:

```ts
export interface ThreadAdapter {
  engine: "claude" | "codex";
  start(opts: { threadId; cwd; resumeCursor: unknown | null;
                onEvent: (ev: RuntimeEvent) => void }): Promise<LiveSession>;
}
export interface LiveSession {
  sendTurn(prompt: string): Promise<void>;
  interrupt(): Promise<void>;
  respond(requestId: string, outcome: "approve" | "deny"): Promise<void>;
  stop(): Promise<void>;
  resumeCursor(): unknown;    // persisted after every turn
}
```

- **Claude**: `@anthropic-ai/claude-agent-sdk` `query()` with an async prompt queue
  (follow-up turns feed the same live session; fresh `query({resume})` only after
  restart). Options: `cwd`, `includePartialMessages: true`, `permissionMode` from a
  per-thread setting (default `acceptEdits`; `bypassPermissions` opt-in), `canUseTool`
  callback → `request.opened` and park until `respond()`. Capture `session_id` from SDK
  messages → cursor `{resume: sessionId}`. Map SDK messages: `stream_event` text deltas
  → `content.delta`; `assistant` blocks → `message.completed` / tool_use activities;
  `result` → `turn.completed` + `token-usage`.
- **Codex**: spawn one `codex app-server` child per live session, hand-rolled JSON-RPC
  stdio client (~150 lines; newline-delimited JSON, id-matched responses,
  notifications, and server→client requests for approvals). `thread/start`
  (cwd, model from settings) or `thread/resume {threadId}` with automatic fallback to
  `thread/start` on resume errors. Cursor = native thread id from the `thread/started`
  notification. `turn/create` per prompt; map `item/agentMessage/delta`,
  command-execution notifications, `turn/started`, token usage. **Verify the exact
  method/notification names against `/tmp/t3code/packages/effect-codex-app-server`
  and `apps/server/src/provider/Layers/CodexSessionRuntime.ts` — do not guess.**
  Approval requests parked and resolved via `respond()`.

### Thread manager (`src/threads/manager.ts`)

In-memory live sessions keyed by threadId; resume-on-demand (a turn arriving for a
thread with no live session starts one from `resume_cursor`); idle reaper stops live
sessions after 30 min without activity (cursor persisted, thread stays resumable);
folds runtime events into `thread_events` rows (buffer `content.delta`, flush ≤10/s)
and fans them out to WS subscribers with `sequence`.

### Transport

`@hono/node-ws` wired in `src/server.ts` (`createNodeWebSocket`, `injectWebSocket` on
the server returned by `serve()`).

- REST (auth middleware applies): `GET /api/threads` (list, recency),
  `POST /api/threads {engine, cwd, resumeFrom?: {engine, sessionId}}` — `resumeFrom`
  builds the cursor from a Milestone-1 inbox session (claude: uuid; codex: session id;
  title copied from the session), `GET /api/threads/:id` → snapshot
  `{thread, events[], sequence}`, `POST /api/threads/:id/turns {prompt}`,
  `POST /api/threads/:id/interrupt`, `POST /api/threads/:id/requests/:requestId {outcome}`,
  `DELETE /api/threads/:id` (stop + delete).
- WS `GET /api/threads/:id/ws`: on connect enforce the same auth as `/api/*`
  (cookie or `?token=`), then send nothing — client fetches the REST snapshot and
  passes `?after=<sequence>`; server streams `{sequence, kind, payload}` events with
  `sequence > after` (buffered from subscribe time to avoid gaps), client dedupes by
  sequence. Simple JSON, zod-validated shared shapes in `src/threads/wire.ts`.

### Web

- `#/threads` list + "New thread" (engine picker, cwd picker seeded from
  `api.projects()`, free-text path allowed); `#/threads/:id` = `ThreadView`.
- `ThreadView`: timeline merging messages and activities ordered by sequence;
  streaming deltas appended to the open assistant bubble; tool activities as
  collapsible rows (collapse older ones while a turn runs); approval requests as
  inline approve/deny cards; composer with Enter-to-send; interrupt button while
  running; status dot. Reuse `components/ui` message/bubble/message-scroller and
  `Markdown.tsx`. WS hook with auto-reconnect (resnapshot + `?after=` on reconnect).
- Sessions inbox (M1) gains a "Continue in Boucle" button → `POST /api/threads`
  with `resumeFrom` → navigate to the new thread.

### Tests

Adapter mapping tests with fake SDK/app-server event fixtures → canonical events;
manager fold/sequence tests; wire schema tests; codex JSON-RPC client framing test
(in-process fake stdio). No live-model calls in tests.

Definition of done: gates green; manual QA — create claude thread, see streamed
response; create codex thread; continue an inbox session with context intact;
interrupt works; server restart → thread resumes from cursor.

---

## Milestone 3 — Web terminal

A terminal drawer on every thread (plain shell in the thread's cwd), t3code's attach
protocol.

### Backend (`src/terminal/`)

- `pty-adapter.ts`: t3code's seam, verbatim shape — `spawn(input) → PtyProcess
  {pid, write, resize, kill, onData, onExit}`; `node-pty` implementation
  (`name: "xterm-256color"`, cwd, cols/rows, env).
- `manager.ts`: sessions keyed `(threadId, terminalId)`, **client-chosen** terminal ids
  (`term-1`…, regex-validated). Shell ladder `$SHELL` → `/bin/zsh` → `/bin/bash` →
  `/bin/sh`, retry next candidate only on ENOENT. Env: inherit everything minus a small
  blocklist (`PORT`, `BOUCLE_*` secrets) — blocklist, not allowlist. History: in-memory
  string capped ~5000 lines (strip only dangerous control sequences, keep ANSI colors;
  handle escape sequences split across chunks), debounce-persisted (~50 ms) to
  `var/terminals/<threadId>_<terminalId>.log` so history survives server restarts
  (session then shows exited + restartable). Kill: SIGTERM, 1 s grace, SIGKILL.
  Cap retained exited sessions (~32). PTYs live in the server process → page reloads
  cost nothing.
- WS `GET /api/terminals/:threadId/:terminalId/ws` (same auth as threads WS).
  Server→client: `{type:'snapshot', history, status, pid}` first — subscribe-to-output
  **before** open/attach, buffer, then snapshot, then flush (t3code's no-gap handshake)
  — then `{type:'output', data}`, `{type:'exited', code}`, `{type:'restarted'}`.
  Client→server: `{type:'write', data}` (cap 64 KiB), `{type:'resize', cols, rows}`
  (validate 1–1000/1–500), `{type:'restart'}`, `{type:'close'}`.

### Web

- `TerminalDrawer` inside `ThreadView` (toggleable bottom drawer, tabs for `term-N`,
  "+" opens a new one). xterm: `new Terminal({cursorBlink:true, fontSize:12,
  scrollback:5000, fontFamily: mono stack, theme from CSS vars})` + `FitAddon` only.
  **Client keeps a `{buffer, status, version}` reducer; on change, write only the
  suffix if the new buffer extends the old, else `ESC c` reset + full rewrite**
  (idempotent reconnect/replay — t3code's key client trick). `fit()` on mount/resize
  guarded in try/catch, then send `resize`.
- Terminal must also work standalone per project: `#/terminal/:projectId` opening in
  the project root reuses the same drawer component full-page (threadId = `project_<id>`).

### Tests

Manager: history cap, debounced persistence, escape-sequence carry-over, kill
escalation (fake PtyAdapter — no real pty in tests), snapshot-then-flush ordering.
Wire schema validation.

Definition of done: gates green; open a thread terminal, run `ls`, colors correct,
reload page → history intact, resize works, second terminal tab independent, exited
shell restartable.

---

## Execution notes (for the driving session, not codex)

- Implementer: `codex exec -m gpt-5.6-sol -c model_reasoning_effort="high"
  --dangerously-bypass-approvals-and-sandbox` from the repo root, one milestone per run,
  prompt = pointer to this file + milestone number + repo-facts section.
- QA: sonnet subagent per milestone. Gates: `pnpm typecheck`,
  `node --test src/*.test.ts src/threads/*.test.ts src/terminal/*.test.ts` (as
  applicable), `pnpm --dir web build`, then behavioral checks per the milestone's
  definition of done against a server on a test port (`BOUCLE_PORT=4519`) with temp
  state dirs. Browser-based checks: **one** headless browser instance max, pages
  sequential, `pkill -f chrome-headless-shell` afterwards (host constraint).
- Ship rule: QA green → commit + push (per milestone).
