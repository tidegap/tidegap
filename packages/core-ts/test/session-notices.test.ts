/**
 * Session notices in the ledger: the session filter of `list`, the notice
 * query (which finished tasks a Claude Code session has not been told about),
 * the one-time `notified` claim and the event cursor.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { formatTaskEvent, SESSION_NOTICES_SINCE_META_KEY, TaskStore } from "../src/index.js";
import type { TaskRecord, TaskStatus } from "../src/index.js";

interface RawDb {
  exec(sql: string): void;
  prepare(sql: string): { all(...a: unknown[]): unknown[]; run(...a: unknown[]): unknown };
  close(): void;
}

/** A raw handle with TaskStore's backend order: node:sqlite, else better-sqlite3 (CI's Node 20). */
function openRawDb(path: string): RawDb {
  const req = createRequire(import.meta.url);
  try {
    const { DatabaseSync } = req("node:sqlite") as { DatabaseSync: new (p: string) => RawDb };
    return new DatabaseSync(path);
  } catch {
    const Database = req("better-sqlite3") as new (p: string) => RawDb;
    return new Database(path);
  }
}

const NOW = new Date("2026-10-30T12:00:00.000Z");
const SINCE = "2026-10-01T00:00:00.000Z";
const S1 = "sess-aaaa1111";
const S2 = "sess-bbbb2222";
const CHECKED = { agent: "claude-code", via: "hook" };

function row(
  taskId: string,
  status: TaskStatus,
  opts: { session?: string; completedAt?: string; origin?: unknown; handoff?: unknown } = {},
): TaskRecord<unknown> {
  const body = {
    type: "provider_call",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    prompt: "p",
    ...(opts.origin === undefined ? { origin: CHECKED } : opts.origin === null ? {} : { origin: opts.origin }),
    ...(opts.handoff ? { handoff: opts.handoff } : {}),
  };
  return {
    taskId,
    status,
    enqueuedAt: "2026-10-30T08:00:00.000Z",
    region: "FR",
    title: `title ${taskId}`,
    originSessionId: opts.session ?? S1,
    bodyJson: JSON.stringify(body),
    ...(opts.completedAt ? { completedAt: opts.completedAt } : {}),
  } as TaskRecord<unknown>;
}

describe("session notices in the ledger", () => {
  let dir: string;
  let dbPath: string;
  const open: TaskStore[] = [];

  function store(opts: { busyTimeoutMs?: number } = {}): TaskStore {
    const s = new TaskStore({ dbPath, ...opts });
    open.push(s);
    return s;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-notices-"));
    dbPath = join(dir, "queue.db");
  });

  afterEach(() => {
    for (const s of open.splice(0)) s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const ids = (s: TaskStore, sessionId?: string) =>
    s.listSessionNotices({ now: NOW, ...(sessionId ? { sessionId } : {}) }).map((n) => n.record.taskId);

  it("lists only the tasks of the named session", () => {
    const s = store();
    s.upsert(row("t-a1", "scheduled"));
    s.upsert(row("t-b1", "scheduled", { session: S2 }));
    s.upsert(row("t-a2", "completed", { completedAt: "2026-10-30T09:00:00.000Z" }));
    expect(s.list({ originSessionId: S1 }).map((r) => r.taskId)).toEqual(["t-a1", "t-a2"]);
    expect(s.list({ originSessionId: S2 }).map((r) => r.taskId)).toEqual(["t-b1"]);
    expect(s.list({ originSessionId: "sess-none0000" })).toEqual([]);
  });

  it("a notice lists completed, failed and cancelled tasks of the session, oldest first", () => {
    const s = store();
    s.setMeta(SESSION_NOTICES_SINCE_META_KEY, SINCE);
    s.upsert(row("t-cancel", "cancelled", { completedAt: "2026-10-30T11:00:00.000Z" }));
    s.upsert(row("t-done", "completed", { completedAt: "2026-10-30T09:00:00.000Z" }));
    s.upsert(row("t-fail", "failed", { completedAt: "2026-10-30T10:00:00.000Z" }));
    s.upsert(row("t-queued", "queued"));
    s.upsert(row("t-running", "running"));
    s.upsert(row("t-other", "completed", { session: S2, completedAt: "2026-10-30T09:30:00.000Z" }));
    expect(ids(s, S1)).toEqual(["t-done", "t-fail", "t-cancel"]);
    // Without a session: every session's notices, for the tick's marker sweep.
    expect(ids(s)).toEqual(["t-done", "t-other", "t-fail", "t-cancel"]);
  });

  it("a row whose body has no origin (an unchecked origin_session_id) is never a notice", () => {
    const s = store();
    s.setMeta(SESSION_NOTICES_SINCE_META_KEY, SINCE);
    s.upsert(row("t-none", "completed", { origin: null, completedAt: "2026-10-30T09:00:00.000Z" }));
    s.upsert(row("t-codex", "completed", { origin: { agent: "codex", via: "env" }, completedAt: "2026-10-30T09:00:00.000Z" }));
    s.upsert(row("t-checked", "completed", { completedAt: "2026-10-30T09:00:00.000Z" }));
    expect(ids(s, S1)).toEqual(["t-checked"]);
  });

  it("a row with handoff.resultPath is a notice only after its result_file event", () => {
    const s = store();
    s.setMeta(SESSION_NOTICES_SINCE_META_KEY, SINCE);
    const handoff = { resultPath: "/tmp/tg-result.txt" };
    s.upsert(row("t-file", "completed", { handoff, completedAt: "2026-10-30T09:00:00.000Z" }));
    // A failed task gets no file, so it is not held back.
    s.upsert(row("t-file-failed", "failed", { handoff, completedAt: "2026-10-30T09:30:00.000Z" }));
    expect(ids(s, S1)).toEqual(["t-file-failed"]);
    // A newer writer records the file with a kind this build may not know.
    const raw = openRawDb(dbPath);
    raw
      .prepare(`INSERT INTO task_events (task_id, at, kind, actor, details) VALUES (?, ?, 'result_file', 'tick', ?)`)
      .run("t-file", "2026-10-30T09:01:00.000Z", JSON.stringify({ path: "/tmp/tg-result.txt", written: false, error: "exists" }));
    raw.close();
    const notices = s.listSessionNotices({ sessionId: S1, now: NOW });
    expect(notices.map((n) => n.record.taskId)).toEqual(["t-file", "t-file-failed"]);
    expect(notices[0]!.resultPath).toBe("/tmp/tg-result.txt");
    expect(notices[0]!.resultFile).toEqual({ path: "/tmp/tg-result.txt", written: false, error: "exists" });
    expect(notices[1]!.resultFile).toBeUndefined();
  });

  it("a task finished before session_notices_since is never a notice", () => {
    const s = store();
    s.upsert(row("t-history", "completed", { completedAt: "2026-10-30T09:00:00.000Z" }));
    // The first use sets the key to "now", so an upgrade does not replay history.
    expect(ids(s, S1)).toEqual([]);
    expect(s.getMeta(SESSION_NOTICES_SINCE_META_KEY)).toBe(NOW.toISOString());
    // A later call never moves it.
    s.listSessionNotices({ sessionId: S1, now: new Date(NOW.getTime() + 3_600_000) });
    expect(s.getMeta(SESSION_NOTICES_SINCE_META_KEY)).toBe(NOW.toISOString());
    s.upsert(row("t-new", "completed", { completedAt: "2026-10-30T12:30:00.000Z" }));
    expect(s.listSessionNotices({ sessionId: S1, now: new Date("2026-10-30T13:00:00.000Z") }).map((n) => n.record.taskId)).toEqual(["t-new"]);
  });

  it("a task finished more than 7 days ago is not a notice", () => {
    const s = store();
    s.setMeta(SESSION_NOTICES_SINCE_META_KEY, SINCE);
    s.upsert(row("t-old", "completed", { completedAt: "2026-10-22T11:59:00.000Z" }));
    s.upsert(row("t-week", "completed", { completedAt: "2026-10-23T12:00:00.000Z" }));
    expect(ids(s, S1)).toEqual(["t-week"]);
  });

  it("a task with read_at set is still a notice", () => {
    const s = store();
    s.setMeta(SESSION_NOTICES_SINCE_META_KEY, SINCE);
    s.upsert(row("t-read", "completed", { completedAt: "2026-10-30T09:00:00.000Z" }));
    expect(s.markRead("t-read")).toBe(true);
    expect(ids(s, S1)).toEqual(["t-read"]);
  });

  it("the first claim returns true, the second returns false and writes nothing", () => {
    const s = store();
    s.setMeta(SESSION_NOTICES_SINCE_META_KEY, SINCE);
    s.upsert(row("t-claim", "completed", { completedAt: "2026-10-30T09:00:00.000Z" }));
    const other = store();
    expect(s.claimNotice("t-claim", { via: "prompt", session_id: S1 }, "agent:claude-code")).toBe(true);
    expect(other.claimNotice("t-claim", { via: "wait", session_id: S1 }, "cli")).toBe(false);
    const notified = s.listTaskEvents("t-claim").filter((e) => e.kind === "notified");
    expect(notified).toHaveLength(1);
    expect(notified[0]!.actor).toBe("agent:claude-code");
    expect(notified[0]!.details).toEqual({ via: "prompt", session_id: S1, completed_at: "2026-10-30T09:00:00.000Z" });
    expect(formatTaskEvent(notified[0]!)).toMatch(/ notified by agent:claude-code - via prompt$/);
    expect(ids(s, S1)).toEqual([]);
  });

  it("a retried task that finishes again is a new notice, claimed once", () => {
    const s = store();
    s.setMeta(SESSION_NOTICES_SINCE_META_KEY, SINCE);
    s.upsert(row("t-retry", "failed", { completedAt: "2026-10-30T09:00:00.000Z" }));
    expect(s.claimNotice("t-retry", { via: "prompt", session_id: S1 }, "agent:claude-code")).toBe(true);
    expect(ids(s, S1)).toEqual([]);
    // retryTask keeps the task id and clears completed_at; the retry then finishes.
    s.upsert(row("t-retry", "scheduled"));
    expect(ids(s, S1)).toEqual([]);
    s.upsert(row("t-retry", "completed", { completedAt: "2026-10-30T11:00:00.000Z" }));
    expect(ids(s, S1)).toEqual(["t-retry"]);
    expect(s.claimNotice("t-retry", { via: "wait", session_id: S1 }, "cli")).toBe(true);
    expect(s.claimNotice("t-retry", { via: "prompt", session_id: S1 }, "agent:claude-code")).toBe(false);
    expect(ids(s, S1)).toEqual([]);
    const claims = s.listTaskEvents("t-retry").filter((e) => e.kind === "notified");
    expect(claims.map((e) => e.details.completed_at)).toEqual(["2026-10-30T09:00:00.000Z", "2026-10-30T11:00:00.000Z"]);
  });

  it("a claim of an unknown task writes nothing", () => {
    const s = store();
    expect(s.claimNotice("t-missing", { via: "prompt", session_id: S1 })).toBe(false);
    expect(s.listTaskEvents("t-missing")).toEqual([]);
  });

  it("listTaskEventsAfter returns only newer events", () => {
    const s = store();
    s.upsert(row("t-ev", "scheduled"), { kind: "created", actor: "cli" });
    s.recordEvent("t-ev", { kind: "postponed", actor: "page" });
    s.recordEvent("t-other", { kind: "created", actor: "cli" });
    s.recordEvent("t-ev", { kind: "expedited", actor: "cli" });
    const all = s.listTaskEventsAfter("t-ev", 0);
    expect(all.map((e) => e.kind)).toEqual(["created", "postponed", "expedited"]);
    expect(s.listTaskEventsAfter("t-ev", all[0]!.id).map((e) => e.kind)).toEqual(["postponed", "expedited"]);
    expect(s.listTaskEventsAfter("t-ev", all[2]!.id)).toEqual([]);
  });

  it("an older reader skips a notified row", async () => {
    const s = store();
    s.upsert(row("t-old-reader", "completed", { completedAt: "2026-10-30T09:00:00.000Z" }), { kind: "completed", actor: "tick" });
    expect(s.claimNotice("t-old-reader", { via: "prompt", session_id: S1 }, "agent:claude-code")).toBe(true);
    // A build whose kind list predates `notified`.
    vi.resetModules();
    vi.doMock("../src/task-events.js", async (importOriginal) => {
      const real = await importOriginal<typeof import("../src/task-events.js")>();
      const kinds = real.TASK_EVENT_KINDS.filter((k) => k !== "notified");
      return { ...real, TASK_EVENT_KINDS: kinds, isTaskEventKind: (k: unknown) => (kinds as readonly unknown[]).includes(k) };
    });
    try {
      const { TaskStore: OlderStore } = await import("../src/storage/sqlite.js");
      const older = new OlderStore({ dbPath });
      try {
        expect(older.listTaskEvents("t-old-reader").map((e) => e.kind)).toEqual(["completed"]);
      } finally {
        older.close();
      }
    } finally {
      vi.doUnmock("../src/task-events.js");
      vi.resetModules();
    }
  });

  it("a notice query with session_notices_since set takes no write lock", () => {
    // A write would wait the whole busy timeout behind the other writer.
    const s = store({ busyTimeoutMs: 3_000 });
    s.setMeta(SESSION_NOTICES_SINCE_META_KEY, SINCE);
    s.upsert(row("t-busy", "completed", { completedAt: "2026-10-30T09:00:00.000Z" }));
    const raw = openRawDb(dbPath);
    raw.exec("BEGIN IMMEDIATE");
    try {
      const t0 = Date.now();
      expect(ids(s, S1)).toEqual(["t-busy"]);
      expect(Date.now() - t0).toBeLessThan(1_500);
    } finally {
      raw.exec("ROLLBACK");
      raw.close();
    }
  });

  it("busyTimeoutMs bounds how long a write waits for another writer", () => {
    store().upsert(row("t-lock", "scheduled"));
    const raw = openRawDb(dbPath);
    raw.exec("BEGIN IMMEDIATE");
    try {
      const s = store({ busyTimeoutMs: 50 });
      const t0 = Date.now();
      expect(() => s.claimNotice("t-lock", { via: "prompt", session_id: S1 })).toThrow();
      expect(Date.now() - t0).toBeLessThan(2_000);
    } finally {
      raw.exec("ROLLBACK");
      raw.close();
    }
  });
});
