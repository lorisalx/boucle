import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { BoucleStore } from "./store.ts";

test("opening a phase-1 database adds a nullable loop runner without changing the loop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "boucle-store-test-"));
  const dbPath = join(dir, "existing.db");
  const before = new DatabaseSync(dbPath);
  before.exec(`
    CREATE TABLE loops (
      loop_id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      prompt TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0,
      interval_minutes INTEGER NOT NULL DEFAULT 60, active_days TEXT NOT NULL DEFAULT '',
      active_start_hour INTEGER NOT NULL DEFAULT 0, active_end_hour INTEGER NOT NULL DEFAULT 0,
      timezone TEXT NOT NULL DEFAULT 'UTC', codex_home TEXT, profile TEXT, model TEXT,
      thread_id TEXT, thread_project TEXT, thread_open_url TEXT,
      last_run_at TEXT, last_status TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    INSERT INTO loops VALUES (
      'existing-loop', 'Existing', 'keep me', 'do one thing', 1,
      120, 'Mon', 9, 17, 'UTC', '/tmp/codex-home', 'profile-a', 'custom-model',
      'session-a', 'vibe', NULL, '2026-01-02T03:04:05.000Z', 'ok',
      '2026-01-01T00:00:00.000Z', '2026-01-02T03:04:05.000Z'
    );
    CREATE TABLE loop_runs (
      run_id TEXT PRIMARY KEY, loop_id TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
      status TEXT NOT NULL, exit_code INTEGER, summary TEXT NOT NULL DEFAULT '',
      trigger TEXT NOT NULL DEFAULT 'schedule', cost_usd REAL, session_id TEXT
    );
  `);
  before.close();

  try {
    const store = new BoucleStore(dbPath, { appName: "Boucle", ownerName: "", orgName: "", demoMode: false });
    assert.deepEqual(store.getLoop("existing-loop"), {
      loopId: "existing-loop",
      name: "Existing",
      description: "keep me",
      prompt: "do one thing",
      enabled: true,
      intervalMinutes: 120,
      activeDays: "Mon",
      activeStartHour: 9,
      activeEndHour: 17,
      timezone: "UTC",
      codexHome: "/tmp/codex-home",
      profile: "profile-a",
      model: "custom-model",
      runner: null,
      threadId: "session-a",
      threadProject: "vibe",
      threadOpenUrl: null,
      lastRunAt: "2026-01-02T03:04:05.000Z",
      lastStatus: "ok",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T03:04:05.000Z",
    });
    const migrated = new DatabaseSync(dbPath);
    assert.equal(migrated.prepare("PRAGMA table_info(loops)").all().some((row) => (row as { name: string }).name === "runner"), true);
    assert.equal(migrated.prepare("PRAGMA table_info(loop_runs)").all().some((row) => (row as { name: string }).name === "runner"), true);
    migrated.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("linking a t3code chat preserves the ticket's browser chat", async () => {
  const dir = await mkdtemp(join(tmpdir(), "boucle-store-chat-test-"));
  const dbPath = join(dir, "chat.db");
  try {
    const store = new BoucleStore(dbPath, { appName: "Boucle", ownerName: "", orgName: "", demoMode: false });
    const ticket = store.upsert({ dedupeKey: "test:chat", title: "Keep both chats", source: "manual" });
    store.setFields({ ticketId: ticket.ticketId, threadId: "local-browser-chat" });
    const updated = store.setFields({
      ticketId: ticket.ticketId,
      t3codeThreadId: "t3code:external-chat",
      t3codeOpenUrl: "https://t3.example/environment/external-chat",
    });
    assert.equal(updated.threadId, "local-browser-chat");
    assert.equal(updated.t3codeThreadId, "t3code:external-chat");
    assert.equal(updated.t3codeOpenUrl, "https://t3.example/environment/external-chat");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
