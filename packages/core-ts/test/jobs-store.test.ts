/**
 * Ledger shape of floating recurring jobs (U1): the `jobs` table, the
 * insert-only `tasks.job_id` column, and the compare-and-set job write.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_JOB_CAPS, TaskStore } from "../src/index.js";
import type { JobRecord, TaskRecord } from "../src/index.js";

const requireFn = createRequire(import.meta.url);

interface RawDb {
  exec(sql: string): void;
  prepare(sql: string): { all(...p: unknown[]): Array<Record<string, unknown>>; run(...p: unknown[]): unknown };
  close(): void;
}

function openRawDb(path: string): RawDb {
  try {
    const { DatabaseSync } = requireFn("node:sqlite") as { DatabaseSync: new (p: string) => RawDb };
    return new DatabaseSync(path);
  } catch {
    const Database = requireFn("better-sqlite3") as new (p: string) => RawDb;
    return new Database(path);
  }
}

/** The tasks table as v0.19 shipped it: every column before job_id. */
const V019_SCHEMA = `
  CREATE TABLE tasks (
    task_id TEXT PRIMARY KEY, status TEXT NOT NULL, enqueued_at TEXT NOT NULL,
    scheduled_for TEXT, completed_at TEXT, region TEXT NOT NULL,
    carbon_budget_g REAL, result_json TEXT, error TEXT, receipt_json TEXT,
    intensity_source TEXT, body_json TEXT, estimated_carbon_g REAL,
    deadline TEXT, batch_id TEXT, routing_decision TEXT, title TEXT,
    origin_host TEXT, origin_cwd TEXT, read_at TEXT, parent_task_id TEXT,
    deadline_kind TEXT, quota_provider TEXT, series_id TEXT, repeat TEXT,
    origin_session_id TEXT, not_before TEXT
  );
  INSERT INTO tasks (task_id, status, enqueued_at, region)
    VALUES ('old', 'scheduled', '2026-10-01T00:00:00.000Z', 'DE');`;

function job(jobId: string, extra: Partial<JobRecord> = {}): JobRecord {
  return {
    jobId,
    title: "Mail digest",
    status: "active",
    cadence: { kind: "weekly", days: ["mon", "thu"] },
    window: { start: "22:00", end: "06:00" },
    timeZone: "Europe/Berlin",
    template: { runner: "prompt", prompt: "summarize my mail", provider: "claude-code", tools: "files" },
    caps: { ...DEFAULT_JOB_CAPS },
    notify: "every_run",
    originHost: "cli",
    createdAt: "2026-10-20T00:00:00.000Z",
    updatedAt: "2026-10-20T00:00:00.000Z",
    revision: 1,
    nextSeq: 1,
    consecutiveFailures: 0,
    retryUsed: false,
    ...extra,
  };
}

function occurrence(taskId: string, extra: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId,
    status: "scheduled",
    enqueuedAt: "2026-10-20T00:00:00.000Z",
    region: "DE",
    ...extra,
  };
}

function names(store: TaskStore, sql: string): string[] {
  const db = (store as unknown as { db: RawDb }).db;
  return db.prepare(sql).all().map((r) => String(r.name));
}

describe("jobs ledger (U1)", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-jobs-store-"));
    dbPath = join(dir, "queue.db");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("a v0.19 ledger opens with a jobs table, tasks.job_id and its index; a second open adds nothing", () => {
    const raw = openRawDb(dbPath);
    raw.exec(V019_SCHEMA);
    raw.close();
    const store = new TaskStore({ dbPath });
    expect(names(store, `SELECT name FROM sqlite_master WHERE type = 'table'`)).toContain("jobs");
    const cols = names(store, `SELECT name FROM pragma_table_info('tasks')`);
    expect(cols).toContain("job_id");
    expect(names(store, `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tasks'`)).toContain(
      "tasks_job_idx",
    );
    expect(store.get("old")?.jobId).toBeUndefined();
    store.close();
    const again = new TaskStore({ dbPath });
    expect(names(again, `SELECT name FROM pragma_table_info('tasks')`)).toEqual(cols);
    again.close();
  });

  it("two stores opening the same new file in sequence share job rows", () => {
    const a = new TaskStore({ dbPath });
    a.insertJob(job("job-0000000a"));
    const b = new TaskStore({ dbPath });
    expect(b.getJob("job-0000000a")).toEqual(job("job-0000000a"));
    a.close();
    b.close();
  });

  it("a duplicate column error on the job_id ALTER counts as another process migrating first", () => {
    const raw = openRawDb(dbPath);
    raw.exec(V019_SCHEMA);
    raw.close();
    const inner = openRawDb(dbPath);
    let raced = false;
    const db = {
      exec(sql: string): void {
        if (!raced && /ADD COLUMN job_id/.test(sql)) {
          raced = true;
          new TaskStore({ dbPath }).close();
        }
        inner.exec(sql);
      },
      prepare: (sql: string) => inner.prepare(sql) as never,
      close: () => inner.close(),
    };
    const store = new TaskStore({ dbPath, db });
    expect(raced).toBe(true);
    store.upsert(occurrence("t1", { jobId: "job-0000000a" }));
    expect(store.get("t1")?.jobId).toBe("job-0000000a");
    store.close();
  });

  it("upsert of a stale record without jobId keeps the stored job_id", () => {
    const store = new TaskStore({ dbPath });
    store.upsert(occurrence("job-0000000a~1", { jobId: "job-0000000a" }));
    store.upsert(occurrence("job-0000000a~1", { status: "running" }));
    expect(store.get("job-0000000a~1")).toMatchObject({ status: "running", jobId: "job-0000000a" });
    // transitionIf leaves it alone too.
    expect(store.transitionIf(occurrence("job-0000000a~1", { status: "completed" }), ["running"])).toBe(true);
    expect(store.get("job-0000000a~1")).toMatchObject({ status: "completed", jobId: "job-0000000a" });
    store.close();
  });

  it("updateJobIf writes and bumps the revision; a stale revision returns false and changes nothing", () => {
    const store = new TaskStore({ dbPath });
    store.insertJob(job("job-0000000a"));
    expect(store.updateJobIf(job("job-0000000a", { status: "paused", pauseReason: "manual" }), 1)).toBe(true);
    expect(store.getJob("job-0000000a")).toMatchObject({ status: "paused", pauseReason: "manual", revision: 2 });
    expect(store.updateJobIf(job("job-0000000a", { title: "stale" }), 1)).toBe(false);
    expect(store.getJob("job-0000000a")).toMatchObject({ title: "Mail digest", status: "paused", revision: 2 });
    store.close();
  });

  it("updateJobIf never rewrites the identity columns", () => {
    const store = new TaskStore({ dbPath });
    store.insertJob(job("job-0000000a"));
    store.updateJobIf(job("job-0000000a", { originHost: "mcp", createdAt: "2030-01-01T00:00:00.000Z" }), 1);
    expect(store.getJob("job-0000000a")).toMatchObject({ originHost: "cli", createdAt: "2026-10-20T00:00:00.000Z" });
    store.close();
  });

  it("listTasks({ jobId }) returns only that job's occurrences, oldest first", () => {
    const store = new TaskStore({ dbPath });
    store.upsert(occurrence("job-0000000a~2", { jobId: "job-0000000a", enqueuedAt: "2026-10-21T00:00:00.000Z" }));
    store.upsert(occurrence("other", { enqueuedAt: "2026-10-20T12:00:00.000Z" }));
    store.upsert(occurrence("job-0000000a~1", { jobId: "job-0000000a", enqueuedAt: "2026-10-20T00:00:00.000Z" }));
    store.upsert(occurrence("job-0000000b~1", { jobId: "job-0000000b" }));
    expect(store.list({ jobId: "job-0000000a" }).map((t) => t.taskId)).toEqual(["job-0000000a~1", "job-0000000a~2"]);
    store.close();
  });

  it("list filters by several statuses and returns the newest rows first up to a limit", () => {
    const store = new TaskStore({ dbPath });
    const rows: Array<[string, TaskRecord["status"]]> = [
      ["job-0000000a~1", "completed"],
      ["job-0000000a~2", "failed"],
      ["job-0000000a~3", "running"],
      ["job-0000000a~4", "scheduled"],
    ];
    rows.forEach(([id, status], i) =>
      store.insertIfAbsent(occurrence(id, { status, jobId: "job-0000000a", enqueuedAt: new Date(Date.UTC(2026, 9, 20, i)).toISOString() })),
    );
    const ids = (filter: Parameters<TaskStore["list"]>[0]) => store.list(filter).map((t) => t.taskId);
    expect(ids({ jobId: "job-0000000a", status: ["running", "scheduled"] })).toEqual(["job-0000000a~3", "job-0000000a~4"]);
    expect(ids({ jobId: "job-0000000a", status: "failed" })).toEqual(["job-0000000a~2"]);
    expect(ids({ jobId: "job-0000000a", newestFirst: true, limit: 3 })).toEqual(["job-0000000a~4", "job-0000000a~3", "job-0000000a~2"]);
    store.close();
  });

  it("listJobs filters by one or several statuses", () => {
    const store = new TaskStore({ dbPath });
    store.insertJob(job("job-0000000a"));
    store.insertJob(job("job-0000000b", { status: "paused" }));
    store.insertJob(job("job-0000000c", { status: "removed" }));
    expect(store.listJobs().map((j) => j.jobId)).toEqual(["job-0000000a", "job-0000000b", "job-0000000c"]);
    expect(store.listJobs({ status: "paused" }).map((j) => j.jobId)).toEqual(["job-0000000b"]);
    expect(store.listJobs({ status: ["active", "paused"] }).map((j) => j.jobId)).toEqual(["job-0000000a", "job-0000000b"]);
    store.close();
  });

  it("a malformed template reads as paused with reason corrupt template", () => {
    const store = new TaskStore({ dbPath });
    store.insertJob(job("job-0000000a"));
    const db = (store as unknown as { db: RawDb }).db;
    db.prepare(`UPDATE jobs SET template_json = '{not json' WHERE job_id = ?`).run("job-0000000a");
    expect(store.getJob("job-0000000a")).toMatchObject({ status: "paused", pauseReason: "corrupt template" });
    expect(store.listJobs({ status: "active" }).map((j) => j.jobId)).toEqual(["job-0000000a"]);
    store.close();
  });
});
