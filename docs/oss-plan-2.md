# Boucle OSS phase 2: unified capture, UI-configurable settings, multi-runner loops

Follows docs/oss-plan.md (implemented). Three workstreams, in order. Same non-negotiables:
demo works out of the box, no env var breaks, no new runtime dependencies, Node type-stripping
constraints. Reference implementation for workstream C lives OUTSIDE this repo at
`/home/loris/boucle/src/` (the pre-Mistral Boucle): `t3code.ts` (t3code orchestration client),
`scheduler.ts` (codex exec loop runs), `config.ts` (t3codeConfigFromEnv). Read them before
implementing; port the ideas, not the code verbatim (that version had no runner seam).

---

## Workstream A1 — capture-first command palette

Problem: Cmd+K opens the search palette (`web/src/Palette.tsx`), while the dashboard's
"Empty your head" box opens the capture modal (`web/src/Capture.tsx`). Two different surfaces,
overlapping affordances ("Capture 'x' as a ticket" exists in the palette as a bottom action).

Design — one surface, capture-first:

- Merge into a single modal component opened by BOTH Cmd+K and the "Empty your head" box.
- One input, placeholder "Empty your head… or search". The capture affordances from
  Capture.tsx (kind chip, routing chip, describe-chat toggle, mic button) sit with the input.
- As the user types, search results render below (same sections/filter chips as today's
  palette: Tickets/Events/Meetings/Brain), arrow-key navigable.
- Keyboard contract:
  - Enter with NO result selected → capture (the primary action; matches the product's
    capture-first ethos).
  - ArrowDown/ArrowUp select results; Enter with a selection → open it.
  - Cmd+Enter → always capture, regardless of selection.
  - Esc → close.
- The footer hint row spells the contract out ("↵ capture · ↑↓ results · ⌘↵ capture · esc close").
- "Ask the brain about 'x'" stays as a pinned action row at the end of results.
- Voice capture keeps working exactly as in Capture.tsx (mic → transcribe → text in input).
- Kill the now-redundant surface: the old standalone modal(s) go away; every entry point
  (keyboard shortcut, header box, any "+ item" affordances that opened Capture) opens the
  unified modal, preserving any prefill behavior those entry points had.

Implementation notes: build the unified component by extending whichever of the two existing
components is structurally closer (likely Capture.tsx for the capture state machine), lifting
the search/results rendering from Palette.tsx. Keep the visual language identical to the
screenshots (chips, rounded card, footer hints). No new dependencies.

## Workstream A2 — settings become UI-configurable (boucle_meta-backed)

Today all config is env-only. Precedent from the old Boucle: `getT3CodeConfig` read
`store.getMeta("t3codeUrl")` / `getMeta("t3codeToken")` with env fallback. Generalize that:

- Resolution order for every configurable below: `boucle_meta` (UI-set) → env var → default.
- **Secrets are env-only**: `MISTRAL_API_KEY`, `OPENAI_API_KEY` are NEVER stored in the DB or
  returned by the API. Settings UI shows presence booleans ("key detected in environment") and
  names the env var to set. Exception, matching the old product's own design: the t3code token
  (workstream C) lives in boucle_meta like it used to.
- Configurable via UI (meta keys mirror env names): appName, ownerName, orgName;
  provider (mistral|openai), chatModel, embedModel, transcribeModel, openaiBaseUrl;
  runner (vibe|codex|claude, workstream C), t3codeUrl, t3codeToken.
- Server:
  - `GET /api/settings` grows the effective resolved values plus, per field, whether it comes
    from meta/env/default (the UI needs to show "set in .env, override here").
  - New `PUT /api/settings` accepting a partial object of the configurables; validates
    (e.g. provider ∈ {mistral, openai}; openai+empty chatModel rejected with the same message
    as the boot check), writes meta, then re-resolves the process-wide singletons.
  - `getIdentity()` and `getProvider()` currently cache at module level; give both a
    read-through cache with an `invalidate()` called by the PUT handler. The provider swap must
    take effect without a restart (new chats use the new provider; embeddings: the model-scoped
    vector logic from phase 1 already handles a live embed-model change).
  - Identity/provider resolution now needs the store (meta) — mind initialization order in
    server.ts: store first, then identity/provider. cli.ts and any pre-store call sites keep
    working (fall back to env-only resolution when no store is available).
- Settings page (`web/src/Settings.tsx`): grows three cards — Identity (app/owner/org name),
  Provider (provider select, model fields, base URL, key-presence lines), Loops runner
  (workstream C fields). Plain form inputs, save button per card, inline validation errors,
  same minimal styling as the existing page. After save, refetch settings; identity changes
  reflect immediately (the useIdentity cache must refetch on save).

## Workstream C — loop runners: codex and claude; t3code chat spawn

### C1. Generalize the runner seam

`src/runner.ts` is vibe-shaped. Rename the spec/result types runner-neutral (keep vibe.ts's
existing internals; adapt at the boundary):

```ts
export interface AgentExecSpec {
  prompt: string; scope: string; model: string | null;
  mcpUrl: string; mcpToken: string; dbPath: string; workdir: string;
  resumeSessionId: string | null; maxPriceUsd: number; timeoutMin: number;
}
export interface AgentExecResult { sessionId: string | null; costUsd: number | null; output: string; code: number | null; timedOut: boolean; }
export interface AgentRunner { name: string; exec(spec): Promise<AgentExecResult>; readTranscript(workdir, scope, sessionId): Promise<Transcript | null>; }
```

- Runner selection: per-loop override column (`loops.runner TEXT NULL`, migration per store.ts
  pattern) falling back to the global setting (meta/env `BOUCLE_RUNNER`, default vibe).
  Loops UI: runner picker on the loop editor next to the existing model field; model field's
  placeholder/help text adapts per runner.
- scheduler.ts calls `getAgentRunner(loop.runner)`; smart-capture/enrich/route use the global.
- Budget accounting: unchanged — it works off recorded costUsd.

### C2. CodexRunner

Port from old `/home/loris/boucle/src/scheduler.ts` `execCodex`:

- Binary: `BOUCLE_CODEX_BIN` → `~/.local/bin/codex` → `codex` on PATH.
- Invocation: `codex exec --skip-git-repo-check --sandbox danger-full-access <prompt>` with
  `--model <model>` when the loop's model is codex-servable (port `codexModelOf`'s idea:
  pass through unless empty), `-C <workdir>`, env `BOUCLE_DB`, `BOUCLE_MCP_TOKEN`.
- MCP wiring: write a scoped `CODEX_HOME` under `var/codex/<scope>/` containing a config.toml
  declaring Boucle's MCP server (streamable-http url + bearer token env var), mirroring how
  vibe.ts writes its per-scope config.toml today. Honor a pre-existing `loops.codexHome`-style
  meta if trivially portable, else scoped-home only.
- Resume: `codex exec resume <sessionId> <prompt>` when resumeSessionId is set and the CLI
  supports it (probe once with `codex exec resume --help`; on unsupported, run fresh and
  prepend a one-line "continuing session" note to the prompt).
- Session id + cost: parse from codex output/session files under `$CODEX_HOME/sessions/`
  (rollout-*.jsonl); if cost is not derivable, record null (budget treats null as 0 but the
  Loops UI must show "n/a", not $0.00 — check how costUsd renders).
- Transcript: best-effort parse of the session rollout JSONL into the existing transcript
  shape (roles + text; tool calls rendered as "used: <tool>"). On parse failure return a
  single-entry transcript containing the captured final output. Never throw.
- Timeout: kill after timeoutMin like vibe.ts does.

### C3. ClaudeRunner

- Binary: `BOUCLE_CLAUDE_BIN` → `claude` on PATH.
- Invocation: `claude -p <prompt> --output-format json --dangerously-skip-permissions`
  ONLY IF that flag is accepted; otherwise default permission mode with
  `--allowedTools "mcp__boucle__*"`. Decide by probing `claude -p --help` once and caching.
  Model via `--model` when set. MCP: `--mcp-config <path>` pointing at a generated JSON file
  under `var/claude/<scope>/mcp.json` with Boucle's streamable-http server + bearer token.
- Resume: `--resume <sessionId>` (supported by claude -p).
- The JSON result envelope gives session_id, total_cost_usd, result text — parse those.
- Transcript: `~/.claude/projects/<munged-workdir>/<session_id>.jsonl` best-effort parse into
  the transcript shape, same fallback rule as codex.
- Timeout: same kill discipline.

### C4. t3code chat spawn (interactive chats in the user's own t3code)

Port `/home/loris/boucle/src/t3code.ts` nearly as-is into `src/t3code.ts` (it is
self-contained: snapshot → matchProject → thread.create → thread.turn.start dispatches,
environment-id discovery, deep links). Changes:

- Config: `getT3CodeConfig(store)` reading meta `t3codeUrl`/`t3codeToken` then env
  `BOUCLE_T3CODE_URL`/`BOUCLE_T3CODE_TOKEN` (add to .env.example + docs). Default project:
  meta/env `BOUCLE_T3CODE_PROJECT` (the old hardcoded "dataiku" default must not survive).
- Default model selection: keep the shape but make the model string a constant near the top
  with a comment; keep claude-opus-4-8/high as shipped default.
- Surface: when t3code is configured, tickets get a secondary action "Open in t3code"
  (next to the existing chat action) → spawns the thread with the same seeded prompt as the
  browser chat (`buildTicketChatPrompt`), stores threadId with a `t3code:` prefix and the
  openUrl on the ticket, and the UI renders it as an external link (target _blank). Browser
  chats remain the default and unchanged. No transcript mirroring in v1 (the chat lives in
  t3code).
- MCP note in docs: the t3code chat can reach Boucle's tools only if the user has added
  Boucle's MCP server to their t3code/claude config; docs show the snippet from /api/mcp-info.

### Docs (small pass, same style rules: no em-dashes, no hype)

- docs/self-hosting.md + docs/providers.md: runner section (vibe/codex/claude setup, binaries,
  what each needs), Settings-UI precedence note (UI overrides env), t3code section.
- .env.example: BOUCLE_RUNNER, BOUCLE_CODEX_BIN, BOUCLE_CLAUDE_BIN, BOUCLE_T3CODE_URL/TOKEN/PROJECT.
- README provider/runner matrix row update.

---

## Acceptance checks

1. typechecks + web build pass.
2. Demo boot unchanged; Cmd+K and "Empty your head" open the same modal; Enter with no
   selection captures; arrow-selected Enter opens the result; Cmd+Enter always captures.
3. PUT /api/settings changes owner name and provider without restart; /api/settings shows
   source (meta/env/default) per field; API keys never appear in any response or in the DB
   (grep the sqlite file bytes for key material after a settings round-trip).
4. A loop with runner=codex and runner=claude each executes end-to-end against the local
   MCP (real one-shot run with a trivial prompt), records sessionId/cost-or-null, renders a
   transcript or the fallback entry; vibe loops unchanged.
5. With t3code unconfigured, no t3code UI appears; with meta-configured URL+token, the ticket
   action appears and spawn produces a thread deep link (network call mocked or against the
   real t3code if reachable).
6. Existing DBs migrate cleanly (loops.runner column added; nothing else touched).
