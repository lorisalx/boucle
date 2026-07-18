#!/usr/bin/env bash
# screenshot-tour.sh — capture every Mistral Boucle feature as presentation-ready PNGs.
#
# Usage:
#   scripts/screenshot-tour.sh [output-dir]
#
# Defaults to docs/screenshots/tour/. Requires the boucle server to be running
# (node src/server.ts). Prefers the Vite dev server on :4320 if it is up,
# otherwise uses the built app served by the API on :4419.
#
# Screenshots are retina (2x) at a 1600x1000 viewport. Pages that need live
# data (loop detail, vibe thread, chat) are skipped gracefully when the
# database has nothing to show.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$REPO_DIR/docs/screenshots/tour}"
API="http://localhost:4419"

# --- locate the gstack browse daemon (single shared headless instance) ------
BROWSE="${BROWSE_BIN:-}"
if [ -z "$BROWSE" ]; then
  for cand in "$(command -v browse || true)" \
              "$HOME/.claude/skills/browse/dist/browse" \
              "$HOME/.claude-lolo/skills/browse/dist/browse"; do
    if [ -n "$cand" ] && [ -x "$cand" ]; then BROWSE="$cand"; break; fi
  done
fi
if [ -z "$BROWSE" ]; then
  echo "error: gstack 'browse' CLI not found (set BROWSE_BIN=/path/to/browse)" >&2
  exit 1
fi

# --- pick the base URL -------------------------------------------------------
if curl -s -o /dev/null --max-time 2 http://localhost:4320; then
  BASE="http://localhost:4320"   # vite dev server: always latest code
elif curl -s -o /dev/null --max-time 2 "$API/api/health"; then
  BASE="$API"                    # built app served by the API (web/dist)
else
  echo "error: boucle server is not running (start it with: node src/server.ts)" >&2
  exit 1
fi

mkdir -p "$OUT"
echo "base: $BASE"
echo "out:  $OUT"

# Remember whether the browse daemon was already running so we only stop
# what we started (never leave a headless chromium behind).
DAEMON_WAS_UP=0
"$BROWSE" status >/dev/null 2>&1 && DAEMON_WAS_UP=1
cleanup() {
  if [ "$DAEMON_WAS_UP" -eq 0 ]; then "$BROWSE" stop >/dev/null 2>&1 || true; fi
  [ -n "${TMP_SHOT:-}" ] && rm -rf "$TMP_SHOT"
}
trap cleanup EXIT

# --- helpers -----------------------------------------------------------------
jget() { curl -s --max-time 8 "$API$1"; }

# json <extractor-js> — reads JSON on stdin, prints the extractor's result.
json() {
  node -e '
    let d = "";
    process.stdin.on("data", (c) => (d += c)).on("end", () => {
      let v; try { v = JSON.parse(d); } catch { return; }
      const fn = new Function("v", "return (" + process.argv[1] + ")");
      const r = fn(v);
      if (r !== undefined && r !== null) console.log(r);
    })' "$1"
}

go() { "$BROWSE" goto "$BASE$1" >/dev/null; "$BROWSE" wait --networkidle >/dev/null 2>&1 || true; }

# The browse daemon only writes files under its own cwd or /private/tmp,
# so screenshot to a temp file and move it into the output dir.
TMP_SHOT="$(mktemp -d /private/tmp/boucle-tour.XXXXXX)"
shot() { # shot <name> [settle-seconds]
  sleep "${2:-0.8}"
  "$BROWSE" screenshot "$TMP_SHOT/$1.png" >/dev/null
  mv "$TMP_SHOT/$1.png" "$OUT/$1.png"
  echo "  ok $1.png"
}

# --- browser setup -----------------------------------------------------------
"$BROWSE" viewport 1600x1000 --scale 2 >/dev/null

# --- the tour ----------------------------------------------------------------
echo "capturing:"

go "/" && shot "01-home-queue"

# Command palette (Cmd+K)
"$BROWSE" press Meta+k >/dev/null
shot "02-command-palette" 0.5
"$BROWSE" press Escape >/dev/null

# Capture modal (same event the Capture button dispatches)
"$BROWSE" js 'window.dispatchEvent(new CustomEvent("boucle:capture", { detail: { project: null } }))' >/dev/null
shot "03-capture-modal" 0.5
"$BROWSE" press Escape >/dev/null

# Ticket detail — first open ticket
TICKET_ID="$(jget /api/tickets/open | json 'v[0] && v[0].ticketId')"
if [ -n "${TICKET_ID:-}" ]; then
  go "/#/ticket/$TICKET_ID" && shot "04-ticket-detail"
else
  echo "  -- skipped ticket detail (no open tickets)"
fi

go "/#/projects" && shot "05-projects"
go "/#/brain"    && shot "06-brain"
go "/#/graph"    && shot "07-brain-graph" 2.5   # graph needs time to lay out
go "/#/meetings" && shot "08-meetings"
go "/#/loops"    && shot "09-loops"

# Loop detail + a vibe thread from its runs
LOOP_ID="$(jget /api/loops | json 'v[0] && v[0].loopId')"
if [ -n "${LOOP_ID:-}" ]; then
  go "/#/loops/$LOOP_ID" && shot "10-loop-detail"
  SESSION_ID="$(jget "/api/loops/$LOOP_ID/runs" | json '(v.find((r) => r.sessionId) || {}).sessionId')"
  if [ -n "${SESSION_ID:-}" ]; then
    go "/vibe/loops_$LOOP_ID/$SESSION_ID" && shot "11-vibe-thread"
  else
    echo "  -- skipped vibe thread (loop has no runs yet)"
  fi
else
  echo "  -- skipped loop detail (no loops defined)"
fi

# Browser chat — needs a ticket whose threadId is a Mistral conversation UUID.
# The chat page fetches the transcript from the Mistral API, so this only
# works with a valid MISTRAL_API_KEY and network access.
UUID_RE='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
CHAT_ID="$(jget /api/tickets | json "(v.find((t) => /${UUID_RE//\//\\/}/i.test(t.threadId || \"\")) || {}).threadId" || true)"
if [ -n "${CHAT_ID:-}" ]; then
  go "/chats/$CHAT_ID" && shot "12-chat" 2
else
  echo "  -- skipped chat (no ticket with a Mistral conversation thread)"
fi

go "/#/settings" && shot "13-settings"

echo
echo "done — $(ls "$OUT" | wc -l | tr -d ' ') screenshots in $OUT"
