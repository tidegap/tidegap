import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { Scheduler, TaskStore } from "../src/index.js";

const requireFn = createRequire(import.meta.url);

interface RawDb {
  exec(sql: string): void;
  prepare(sql: string): never;
  close(): void;
}

/**
 * Open a raw SQLite handle with the same backend order as TaskStore:
 * node:sqlite (Node >= 22.5), else the better-sqlite3 fallback. CI's
 * Node 20 leg has no node:sqlite.
 */
function openRawDb(path: string): RawDb {
  try {
    const { DatabaseSync } = requireFn("node:sqlite") as {
      DatabaseSync: new (p: string) => RawDb;
    };
    return new DatabaseSync(path);
  } catch {
    const Database = requireFn("better-sqlite3") as new (p: string) => RawDb;
    return new Database(path);
  }
}

describe("TaskStore (SQLite-backed)", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-sqlite-"));
    dbPath = join(dir, "queue.sqlite");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a TaskRecord through upsert + get", () => {
    const store = new TaskStore({ dbPath });
    store.upsert({
      taskId: "t1",
      status: "queued",
      enqueuedAt: "2026-05-12T00:00:00.000Z",
      region: "US-CAL-CISO",
      carbonBudgetG: 1.5,
    });
    const got = store.get("t1");
    expect(got?.status).toBe("queued");
    expect(got?.region).toBe("US-CAL-CISO");
    expect(got?.carbonBudgetG).toBe(1.5);
    store.close();
  });

  it("enables WAL mode on disk-backed stores (v0.11)", () => {
    const store = new TaskStore({ dbPath });
    // Cast through `unknown` because TaskStore intentionally hides the
    // raw db handle from its public surface.
    const db = (store as unknown as {
      db: { prepare: (s: string) => { get(): { journal_mode: string } } };
    }).db;
    const row = db.prepare("PRAGMA journal_mode").get();
    expect(row.journal_mode.toLowerCase()).toBe("wal");
    store.close();
  });

  it("two TaskStore handles over the same file write concurrently without SQLITE_BUSY", () => {
    const a = new TaskStore({ dbPath });
    const b = new TaskStore({ dbPath });
    // Interleave writes — without WAL this used to throw SQLITE_BUSY
    // intermittently when the `tidegap tick` daemon and the MCP server held
    // separate connections.
    for (let i = 0; i < 20; i++) {
      const writer = i % 2 === 0 ? a : b;
      writer.upsert({
        taskId: `t-${i}`,
        status: "queued",
        enqueuedAt: new Date(2026, 4, 27, 0, 0, i).toISOString(),
        region: "US-CAL-CISO",
      });
    }
    expect(a.list()).toHaveLength(20);
    expect(b.list()).toHaveLength(20);
    a.close();
    b.close();
  });

  it("survives a reopen", () => {
    const writer = new TaskStore({ dbPath });
    writer.upsert({
      taskId: "t2",
      status: "completed",
      enqueuedAt: "2026-05-12T00:00:00.000Z",
      completedAt: "2026-05-12T01:00:00.000Z",
      region: "US-TEX-ERCO",
      result: { ok: true, payload: "hello" },
      receipt: {
        taskId: "t2",
        ranAt: "2026-05-12T01:00:00.000Z",
        region: "US-TEX-ERCO",
        estimatedCarbonGCo2: 0.4,
        durationMs: 123,
      },
      intensitySource: "scored",
    });
    writer.close();

    const reader = new TaskStore({ dbPath });
    const got = reader.get("t2");
    expect(got?.status).toBe("completed");
    expect((got?.result as { ok: boolean }).ok).toBe(true);
    expect(got?.receipt?.estimatedCarbonGCo2).toBe(0.4);
    expect(got?.intensitySource).toBe("scored");
    reader.close();
  });

  it("filters list() by status", () => {
    const store = new TaskStore({ dbPath });
    store.upsert({
      taskId: "a",
      status: "queued",
      enqueuedAt: "2026-05-12T00:00:00.000Z",
      region: "US-CAL-CISO",
    });
    store.upsert({
      taskId: "b",
      status: "completed",
      enqueuedAt: "2026-05-12T00:01:00.000Z",
      region: "US-CAL-CISO",
    });
    const completed = store.list({ status: "completed" });
    expect(completed.map((r) => r.taskId)).toEqual(["b"]);
    store.close();
  });
});

describe("Scheduler with dbPath persists task transitions", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-sched-sqlite-"));
    dbPath = join(dir, "queue.sqlite");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes queued + completed records", async () => {
    const scheduler = new Scheduler({ dbPath });
    const result = await scheduler.defer(
      async () => ({ value: 42 }),
      { deadline: new Date(Date.now() + 60_000) },
    );
    expect((result as { value: number }).value).toBe(42);
    const persisted = scheduler.listPersistedTasks();
    expect(persisted.length).toBe(1);
    expect(persisted[0]?.status).toBe("completed");
    expect(persisted[0]?.receipt).toBeDefined();
    scheduler.shutdown();
  });
});

describe("TaskStore task-visibility fields (v0.17)", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-visibility-"));
    dbPath = join(dir, "queue.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const V016_SCHEMA = `
    CREATE TABLE tasks (
      task_id TEXT PRIMARY KEY, status TEXT NOT NULL, enqueued_at TEXT NOT NULL,
      scheduled_for TEXT, completed_at TEXT, region TEXT NOT NULL,
      carbon_budget_g REAL, result_json TEXT, error TEXT, receipt_json TEXT,
      intensity_source TEXT, body_json TEXT, estimated_carbon_g REAL,
      deadline TEXT, batch_id TEXT, routing_decision TEXT
    );`;

  function seedV016(path: string): void {
    const raw = openRawDb(path);
    raw.exec(V016_SCHEMA);
    raw.exec(`
      INSERT INTO tasks (task_id, status, enqueued_at, completed_at, region)
        VALUES ('done', 'completed', '2026-10-01T00:00:00.000Z', '2026-10-01T01:00:00.000Z', 'DE');
      INSERT INTO tasks (task_id, status, enqueued_at, completed_at, region)
        VALUES ('bad', 'failed', '2026-10-01T00:00:00.000Z', '2026-10-01T02:00:00.000Z', 'DE');
      INSERT INTO tasks (task_id, status, enqueued_at, scheduled_for, region)
        VALUES ('later', 'scheduled', '2026-10-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z', 'DE');
    `);
    raw.close();
  }

  function rawColumns(store: TaskStore): string[] {
    const db = (store as unknown as {
      db: { prepare: (s: string) => { all(): Array<{ name: string }> } };
    }).db;
    return db.prepare(`SELECT name FROM pragma_table_info('tasks')`).all().map((r) => r.name);
  }

  function rawIndexes(store: TaskStore): string[] {
    const db = (store as unknown as {
      db: { prepare: (s: string) => { all(): Array<{ name: string }> } };
    }).db;
    return db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tasks'`)
      .all()
      .map((r) => r.name);
  }

  const NEW_COLUMNS = [
    "title",
    "origin_host",
    "origin_cwd",
    "read_at",
    "parent_task_id",
    "deadline_kind",
    "quota_provider",
  ];

  function finished(taskId: string, status: "completed" | "failed" = "completed") {
    return {
      taskId,
      status,
      enqueuedAt: "2026-10-10T00:00:00.000Z",
      completedAt: "2026-10-10T01:00:00.000Z",
      region: "DE",
    } as const;
  }

  it("a fresh in-memory store has every new column and the parent index", () => {
    const store = new TaskStore({ dbPath: ":memory:" });
    expect(rawColumns(store)).toEqual(expect.arrayContaining(NEW_COLUMNS));
    expect(rawIndexes(store)).toContain("tasks_parent_idx");
    store.close();
  });

  it("migrating a v0.16 ledger backfills read_at on finished rows only (AE10)", () => {
    seedV016(dbPath);
    const store = new TaskStore({ dbPath });
    expect(rawColumns(store)).toEqual(expect.arrayContaining(NEW_COLUMNS));
    expect(store.get("done")?.readAt).toBe("2026-10-01T01:00:00.000Z");
    expect(store.get("bad")?.readAt).toBe("2026-10-01T02:00:00.000Z");
    expect(store.get("later")?.readAt).toBeUndefined();
    expect(store.list({ unread: true })).toHaveLength(0);
    // A legacy row has no stored kind and reads as absolute.
    expect(store.get("done")?.deadlineKind).toBe("absolute");
    // Marked unread by hand, then reopened: the backfill does not run again.
    expect(store.markUnread("done")).toBe(true);
    store.close();
    const reopened = new TaskStore({ dbPath });
    expect(reopened.get("done")?.readAt).toBeUndefined();
    expect(reopened.list({ unread: true }).map((r) => r.taskId)).toEqual(["done"]);
    reopened.close();
  });

  it("two stores opening a v0.16 ledger one after the other both succeed", () => {
    seedV016(dbPath);
    const a = new TaskStore({ dbPath });
    const b = new TaskStore({ dbPath });
    expect(a.get("done")?.readAt).toBeDefined();
    expect(b.get("done")?.readAt).toBeDefined();
    a.close();
    b.close();
  });

  it("a store that loses the read_at migration race skips the backfill", () => {
    seedV016(dbPath);
    const inner = openRawDb(dbPath);
    let raced = false;
    // Between this store's pragma check and its ALTER, another process
    // migrates the ledger (with the backfill) and the user marks a task
    // unread. This store's ALTER then fails with "duplicate column name".
    const db = {
      exec(sql: string): void {
        if (!raced && /ADD COLUMN read_at/.test(sql)) {
          raced = true;
          const other = new TaskStore({ dbPath });
          expect(other.markUnread("done")).toBe(true);
          other.close();
        }
        inner.exec(sql);
      },
      prepare: (sql: string) => inner.prepare(sql),
      close: () => inner.close(),
    };
    const store = new TaskStore({ dbPath, db });
    expect(raced).toBe(true);
    expect(store.get("done")?.readAt).toBeUndefined();
    expect(store.get("bad")?.readAt).toBeDefined();
    store.close();
  });

  it("upsert never clears read_at and never rewrites identity columns", () => {
    const store = new TaskStore({ dbPath });
    store.upsert({
      ...finished("t1"),
      title: "original",
      originHost: "mcp",
      originCwd: "/work",
      parentTaskId: "p0",
    });
    expect(store.markRead("t1", "2026-10-10T02:00:00.000Z")).toBe(true);
    store.upsert({ ...finished("t1"), title: "changed", originHost: "cli" });
    const got = store.get("t1");
    expect(got?.readAt).toBe("2026-10-10T02:00:00.000Z");
    expect(got?.title).toBe("original");
    expect(got?.originHost).toBe("mcp");
    expect(got?.originCwd).toBe("/work");
    expect(got?.parentTaskId).toBe("p0");
    store.close();
  });

  it("upsert keeps a stored quota kind when the record has none, and clears the label on absolute", () => {
    const store = new TaskStore({ dbPath });
    store.upsert({
      taskId: "q",
      status: "scheduled",
      enqueuedAt: "2026-10-10T00:00:00.000Z",
      region: "DE",
      deadlineKind: "quota_reset",
      quotaProvider: "claude",
    });
    store.upsert({
      taskId: "q",
      status: "scheduled",
      enqueuedAt: "2026-10-10T00:00:00.000Z",
      region: "DE",
    });
    expect(store.get("q")?.deadlineKind).toBe("quota_reset");
    expect(store.get("q")?.quotaProvider).toBe("claude");
    store.upsert({
      taskId: "q",
      status: "scheduled",
      enqueuedAt: "2026-10-10T00:00:00.000Z",
      region: "DE",
      deadlineKind: "absolute",
    });
    expect(store.get("q")?.deadlineKind).toBe("absolute");
    expect(store.get("q")?.quotaProvider).toBeUndefined();
    store.close();
  });

  it("markRead only touches finished rows and sets the timestamp once", () => {
    const store = new TaskStore({ dbPath });
    store.upsert({
      taskId: "s",
      status: "scheduled",
      enqueuedAt: "2026-10-10T00:00:00.000Z",
      region: "DE",
    });
    store.upsert(finished("c"));
    expect(store.markRead("s")).toBe(false);
    expect(store.get("s")?.readAt).toBeUndefined();
    expect(store.markRead("c", "2026-10-10T03:00:00.000Z")).toBe(true);
    expect(store.markRead("c", "2026-10-10T04:00:00.000Z")).toBe(false);
    expect(store.get("c")?.readAt).toBe("2026-10-10T03:00:00.000Z");
    expect(store.markUnread("c")).toBe(true);
    expect(store.markUnread("c")).toBe(false);
    expect(store.get("c")?.readAt).toBeUndefined();
    store.close();
  });

  it("list filters by unread and deadline kind (absolute includes legacy rows)", () => {
    const store = new TaskStore({ dbPath });
    store.upsert(finished("read"));
    store.markRead("read");
    store.upsert(finished("unread-ok"));
    store.upsert(finished("unread-fail", "failed"));
    store.upsert({
      taskId: "quota",
      status: "scheduled",
      enqueuedAt: "2026-10-10T00:00:00.000Z",
      region: "DE",
      deadlineKind: "quota_reset",
      quotaProvider: "claude",
    });
    expect(store.list({ unread: true }).map((r) => r.taskId).sort()).toEqual([
      "unread-fail",
      "unread-ok",
    ]);
    expect(store.list({ deadlineKind: "quota_reset" }).map((r) => r.taskId)).toEqual([
      "quota",
    ]);
    expect(store.list({ deadlineKind: "absolute" }).map((r) => r.taskId).sort()).toEqual([
      "read",
      "unread-fail",
      "unread-ok",
    ]);
    expect(
      store.list({ status: "failed", unread: true }).map((r) => r.taskId),
    ).toEqual(["unread-fail"]);
    store.close();
  });

  it("dataVersion moves on another handle's write and stays put otherwise", () => {
    const watcher = new TaskStore({ dbPath });
    const writer = new TaskStore({ dbPath });
    const v0 = watcher.dataVersion();
    expect(watcher.dataVersion()).toBe(v0);
    writer.upsert(finished("x"));
    expect(watcher.dataVersion()).not.toBe(v0);
    watcher.close();
    writer.close();
  });

  it("meta values round-trip and overwrite", () => {
    const store = new TaskStore({ dbPath });
    expect(store.getMeta("last_tick_at")).toBeUndefined();
    store.setMeta("last_tick_at", "2026-10-10T00:00:00.000Z");
    store.setMeta("last_tick_at", "2026-10-10T00:05:00.000Z");
    expect(store.getMeta("last_tick_at")).toBe("2026-10-10T00:05:00.000Z");
    store.close();
  });
});

describe("TaskStore series, repeat, session and CAS writes (ui v2)", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-series-"));
    dbPath = join(dir, "queue.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const V017_SCHEMA = `
    CREATE TABLE tasks (
      task_id TEXT PRIMARY KEY, status TEXT NOT NULL, enqueued_at TEXT NOT NULL,
      scheduled_for TEXT, completed_at TEXT, region TEXT NOT NULL,
      carbon_budget_g REAL, result_json TEXT, error TEXT, receipt_json TEXT,
      intensity_source TEXT, body_json TEXT, estimated_carbon_g REAL,
      deadline TEXT, batch_id TEXT, routing_decision TEXT, title TEXT,
      origin_host TEXT, origin_cwd TEXT, read_at TEXT, parent_task_id TEXT,
      deadline_kind TEXT, quota_provider TEXT
    );
    INSERT INTO tasks (task_id, status, enqueued_at, region)
      VALUES ('old', 'scheduled', '2026-10-01T00:00:00.000Z', 'DE');`;

  function introspect(store: TaskStore, sql: string): string[] {
    const db = (store as unknown as {
      db: { prepare: (s: string) => { all(): Array<{ name: string }> } };
    }).db;
    return db.prepare(sql).all().map((r) => r.name);
  }

  const pending = (taskId: string, extra: Record<string, unknown> = {}) => ({
    taskId,
    status: "scheduled" as const,
    enqueuedAt: "2026-10-10T00:00:00.000Z",
    region: "DE",
    ...extra,
  });

  it("migrates a v0.17 ledger: four new columns and the series index; reopen is a no-op", () => {
    const raw = openRawDb(dbPath);
    raw.exec(V017_SCHEMA);
    raw.close();
    const store = new TaskStore({ dbPath });
    const cols = introspect(store, `SELECT name FROM pragma_table_info('tasks')`);
    expect(cols).toEqual(
      expect.arrayContaining(["series_id", "repeat", "origin_session_id", "not_before"]),
    );
    expect(
      introspect(store, `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tasks'`),
    ).toContain("tasks_series_idx");
    expect(store.get("old")?.repeat).toBeUndefined();
    store.close();
    const again = new TaskStore({ dbPath });
    expect(introspect(again, `SELECT name FROM pragma_table_info('tasks')`)).toEqual(cols);
    again.close();
  });

  it("upsert never overwrites series_id, origin_session_id or repeat; writes not_before", () => {
    const store = new TaskStore({ dbPath });
    store.upsert(
      pending("s", { seriesId: "s", repeat: "weekly", originSessionId: "sess-0001" }),
    );
    store.upsert(
      pending("s", {
        seriesId: "other",
        repeat: "none",
        originSessionId: "sess-9999",
        notBefore: "2026-10-12T00:00:00.000Z",
      }),
    );
    const got = store.get("s");
    expect(got?.seriesId).toBe("s");
    expect(got?.repeat).toBe("weekly");
    expect(got?.originSessionId).toBe("sess-0001");
    expect(got?.notBefore).toBe("2026-10-12T00:00:00.000Z");
    store.close();
  });

  it("transitionIf writes when the status is listed, including repeat", () => {
    const store = new TaskStore({ dbPath });
    store.upsert(pending("t", { seriesId: "t", repeat: "weekly" }));
    const rec = store.get("t")!;
    const ok = store.transitionIf(
      {
        ...rec,
        status: "cancelled",
        completedAt: "2026-10-10T01:00:00.000Z",
        repeat: "none",
        intensitySource: "expedited",
      },
      ["queued", "scheduled"],
    );
    expect(ok).toBe(true);
    const got = store.get("t")!;
    expect(got.status).toBe("cancelled");
    expect(got.completedAt).toBe("2026-10-10T01:00:00.000Z");
    expect(got.repeat).toBe("none");
    expect(got.intensitySource).toBe("expedited");
    expect(got.seriesId).toBe("t");
    store.close();
  });

  it("transitionIf returns false and writes nothing when the status is outside the list", () => {
    const store = new TaskStore({ dbPath });
    store.upsert(pending("r", { status: "running" }));
    const rec = store.get("r")!;
    expect(store.transitionIf({ ...rec, status: "cancelled" }, ["queued", "scheduled"])).toBe(
      false,
    );
    expect(store.get("r")?.status).toBe("running");
    store.close();
  });

  it("insertIfAbsent inserts once and leaves the first row unchanged", () => {
    const store = new TaskStore({ dbPath });
    expect(store.insertIfAbsent(pending("s~2", { title: "first", seriesId: "s" }))).toBe(true);
    expect(store.insertIfAbsent(pending("s~2", { title: "second", status: "queued" }))).toBe(
      false,
    );
    expect(store.get("s~2")?.title).toBe("first");
    expect(store.get("s~2")?.status).toBe("scheduled");
    store.close();
  });

  it("list filters by series id", () => {
    const store = new TaskStore({ dbPath });
    store.upsert(pending("a", { seriesId: "a", repeat: "daily" }));
    store.upsert(pending("a~2", { seriesId: "a", repeat: "daily" }));
    store.upsert(pending("b"));
    expect(store.list({ seriesId: "a" }).map((r) => r.taskId)).toEqual(["a", "a~2"]);
    store.close();
  });
});

describe("TaskStore channels (coherence KTD10)", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-channels-store-"));
    dbPath = join(dir, "queue.db");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const channel = {
    id: "telegram-5",
    kind: "telegram" as const,
    enabled: true,
    events: ["task_done", "not_ready"] as Array<"task_done" | "not_ready">,
    config: { chat_id: 5 },
    createdAt: "2026-10-17T10:00:00.000Z",
  };

  it("the migration is idempotent on a ledger opened twice and leaves task rows untouched", () => {
    // A ledger written before the channels table existed.
    const before = new TaskStore({ dbPath });
    before.upsert({ taskId: "old", status: "queued", enqueuedAt: "2026-10-01T00:00:00Z", region: "DE" });
    before.close();
    const raw = openRawDb(dbPath);
    raw.exec("DROP TABLE channels");
    raw.close();
    const first = new TaskStore({ dbPath });
    first.insertChannel(channel);
    first.close();
    const second = new TaskStore({ dbPath });
    expect(second.listChannels()).toEqual([channel]);
    expect(second.get("old")?.status).toBe("queued");
    second.close();
  });

  it("insert replaces the same id, remove deletes, meta delete is a no-op when absent", () => {
    const store = new TaskStore({ dbPath });
    store.insertChannel(channel);
    store.insertChannel({ ...channel, config: { chat_id: 5, label: "@me" } });
    expect(store.listChannels()).toHaveLength(1);
    expect(store.listChannels()[0]!.config).toEqual({ chat_id: 5, label: "@me" });
    expect(store.removeChannel("telegram-5")).toBe(true);
    expect(store.removeChannel("telegram-5")).toBe(false);
    store.setMeta("k", "v");
    store.deleteMeta("k");
    store.deleteMeta("k");
    expect(store.getMeta("k")).toBeUndefined();
    store.close();
  });
});

describe("TaskStore on a fresh home", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "tidegap-fresh-home-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("creates the missing ledger directory (0700) and the db on first open", () => {
    const dbPath = join(home, ".tidegap", "queue.db");
    const store = new TaskStore({ dbPath });
    store.upsert({ taskId: "t1", status: "queued", enqueuedAt: "2026-10-19T00:00:00.000Z", region: "US-CAL-CISO", carbonBudgetG: 1 });
    store.close();
    expect(existsSync(dbPath)).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(join(home, ".tidegap")).mode & 0o777).toBe(0o700);
    }
  });

  it("leaves an existing ledger directory and its contents as they are", () => {
    const dir = join(home, ".tidegap");
    const dbPath = join(dir, "queue.db");
    mkdirSync(dir, { mode: 0o700 });
    writeFileSync(join(dir, "keep.txt"), "keep");
    const first = new TaskStore({ dbPath });
    first.upsert({ taskId: "t1", status: "queued", enqueuedAt: "2026-10-19T00:00:00.000Z", region: "US-CAL-CISO", carbonBudgetG: 1 });
    first.close();
    const again = new TaskStore({ dbPath });
    expect(again.get("t1")?.status).toBe("queued");
    again.close();
    expect(readFileSync(join(dir, "keep.txt"), "utf8")).toBe("keep");
  });
});
