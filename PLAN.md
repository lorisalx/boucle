# mistral-boucle — plan

Boucle rebuilt on the Mistral stack: Voxtral for voice capture, Vibe CLI (Devstral 2) as the
loop runner, Agents API for in-browser chats, a fully synthetic brain. Positioning: the whole
stack (Vibe CLI, Devstral weights, Voxtral weights, this repo) can be Apache-2.0 / self-hosted.

**Budget: $40 of Mistral credits — hard constraint.** See "Budget guardrails" at the bottom.
**Data rule: nothing from the real brain or real tickets ever goes to the Mistral API.**

## What stays vs what changes

Boucle (`../boucle`) is already runner-agnostic in the right places — sqlite store, Hono
server, MCP tools, React web all port untouched. The swap surface is exactly three things:

| Boucle today | mistral-boucle | Where |
|---|---|---|
| t3code orchestration (`thread.create` / `thread.turn.start`, deep link `/{env}/{threadId}`) | Mistral **Agents API** conversations, rendered in Boucle's own web UI (Mistral's Vibe app has no conversation-create API) | `src/t3code.ts` → `src/mistral.ts` |
| `codex exec` fallback runner (`--sandbox danger-full-access`) | **Vibe CLI** headless: `vibe --prompt … --auto-approve --output json --max-price …` (vibe 2.21.0 already installed) | `scheduler.ts:254-302` (`execCodex` → `execVibe`) |
| Real gbrain at `~/Documents/dataiku/brain` + `gbrain` CLI reindex/backlinks | `fake-brain/` inside this repo + no-op gbrain shim (backlinks already fail-soft) | `config.ts:16-22`, `projects.ts:369-390` |

Also to strip: the three seeded loop prompts (`store.ts:316-413`) are Loris-specific (home
paths, real names, gbrain paths) — replace with fake-company equivalents. Hardcoded model
selections (`t3code.ts:130-137` claude-opus-4-8; `scheduler.ts:305-330` gpt-/claude- prefix
gating) become Mistral model ids.

## Phases

### Phase 0 — Scaffold + isolation (no API spend, ~30 min)
- Copy `../boucle` → here (exclude `node_modules`, logs, DB), fresh `git init`, `pnpm install`.
- Env isolation so it can run side-by-side with real Boucle:
  `BOUCLE_PORT=4419`, `BOUCLE_DB=~/.mistral-boucle/boucle.db`, `BOUCLE_BRAIN_DIR=<repo>/fake-brain`.
- **Startup guard**: refuse to boot if `BOUCLE_BRAIN_DIR` resolves inside `~/Documents/dataiku/brain`
  or if the DB path is the real `~/.boucle/`. Cheap insurance against leaking real data.
- Server loads `MISTRAL_API_KEY` from `.env` (gitignored, already in place).

### Phase 1 — Fake brain (no API spend, ~45 min)
- `fake-brain/projects/*.md` — ~6 projects for a fictional company (same house format as the
  real brain: YAML frontmatter `status/owners/launch/url`, body with `## State` + `## Timeline`).
  Written by hand (me), zero API cost. Fictional names only.
- `fake-brain/meetings/*.md` — ~8 meeting notes referencing those projects.
- Seed ~15 fake tickets across statuses/buckets so the board looks alive on first boot.
- gbrain: point the reindex spawn at a no-op shim (`scripts/gbrain-noop`); `getBacklinks`
  already returns `[]` on failure.

### Phase 2 — Loops on Vibe CLI ⭐ core (~2-3 h)
- `src/vibe.ts` modeled on `execCodex`: spawn
  `vibe --prompt <loop prompt> --auto-approve --output json --max-turns 30 --max-price <cap>`
  with a vibe MCP config pointing at `http://127.0.0.1:4419/mcp` + `BOUCLE_MCP_TOKEN` bearer —
  the existing boucle MCP tools (`ticket_*`, `spawn_chat`, …) work unchanged.
- Capture vibe's session id per loop → store as the loop's `threadId`; subsequent due runs use
  `vibe --resume <id>` (continuity = what `continueT3CodeChat` gave us).
- Scheduler: delete the t3code-preference branch; `runLoop` always goes through `execVibe`.
  Loop `model` field maps to vibe's `active_model` (default `devstral-2512`).
- Record vibe's reported cost + session id in `loop_runs`; surface both in the Loops view.
- `POST /api/loops` contract unchanged — "same API to create loops" holds by construction.

### Phase 3 — Spawned chats via Agents API, in-browser (~3 h, the demo wow)
Replaces the t3code deep link. Since API-created conversations don't appear in Mistral's Vibe
app, **Boucle's web UI becomes the chat surface**:
- `src/mistral.ts`: start a conversation (`POST /v1/conversations`, model
  `mistral-medium-3.5`, boucle tools declared as function-calling tools). Boucle server runs
  the tool-relay loop: model emits function calls → execute against `BoucleStore` → return
  results → continue. (~150 lines; needed because Mistral cloud can't reach our localhost MCP.)
- `conversation_id` becomes the ticket's `threadId`; deep link becomes an internal route
  `/chats/:conversationId` — new small web view: transcript (fetched from the conversations
  history endpoint) + reply box. `spawn_chat` MCP tool and `POST /api/tickets/:id/spawn-chat`
  keep their shapes.
- Fallback if this runs long: spawn these via vibe too and show `vibe --resume <id>` as the
  "open" affordance. (Options considered: A = vibe everywhere, simplest, no in-UI chat;
  B = Agents API + own chat view — chosen; C = Mistral Workflows — overkill for a POC.)

### Phase 4 — Voxtral voice (~2 h)
- Capture view gets a mic button: `MediaRecorder` → `POST /api/capture/voice` → Mistral
  `audio/transcriptions` (`voxtral-mini-latest`, batch — $0.003/min, pennies) → transcript
  feeds the **existing** `smartCapture` pipeline → ticket appears. Batch, not realtime
  websocket: one fewer moving part and capture is short-utterance anyway.
- Stretch: "morning briefing" button — top-of-queue summary via `ticket_next`, spoken with
  `voxtral-mini-tts-latest`.

### Phase 5 — Rebrand (~30 min)
- Name, Mistral-orange accent in the web UI, README with the open-stack pitch, screenshot.

## Model choices

| Job | Model | Why |
|---|---|---|
| Loop runs (vibe) | `devstral-2512` | the agentic coding model vibe is built for |
| Spawned chats / smart capture / enrich | `mistral-medium-3.5` | current flagship-tier default |
| Cheap classification (capture routing) | `ministral-8b-2512` | near-free |
| Voice in | `voxtral-mini-latest` (batch transcribe) | $0.003/min |
| Voice out (stretch) | `voxtral-mini-tts-latest` | |

## Budget guardrails ($40 total)
- Every vibe invocation carries `--max-price 0.25` and `--max-turns 30`.
- Loops ship **disabled** (`loopEnabled` kill switch off); dev happens via "Run now".
- Long default intervals (≥60 min) once enabled.
- `loop_runs` records per-run cost; Loops view shows a running total; server warns at $10
  cumulative and refuses new runs at $30 (leaves margin for demo day).
- Rough forecast: ~50 dev loop runs × ~$0.10-0.25 + chat/capture/voice in cents ≈ $10-15. Comfortable.

## Notes
- API key lives in `.env` (mode 600, gitignored). It was pasted in a chat — worth rotating in
  La Plateforme once the POC settles.
- Naming hazard for the pitch: "Vibe" is both Mistral's CLI coding agent and the rebranded
  Le Chat app. This project uses the CLI; the app has no public conversation API.
