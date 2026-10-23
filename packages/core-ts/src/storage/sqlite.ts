/**
 * SQLite-backed durable task store.
 *
 * v0.1 of the scheduler kept TaskRecords in a Map; restarting the process
 * lost queued work. v0.2 introduces an opt-in persistent store: pass
 * { dbPath } to the Scheduler and queued / completed records survive
 * a restart and remain auditable as a carbon ledger.
 *
 * The backend is Node's built-in synchronous SQLite (node:sqlite, Node
 * >= 22.5) — no native module to install or compile, which matters in
 * environments that install dependencies without running build scripts.
 * better-sqlite3 is used as a fallback on older Node if it is installed.
 *
 * Schema is intentionally narrow:
 *   - task_id            PRIMARY KEY
 *   - status             queued | scheduled | running | submitted |
 *                        completed | failed | cancelled
 *   - enqueued_at        ISO-8601
 *   - scheduled_for      ISO-8601 (nullable)
 *   - completed_at       ISO-8601 (nullable)
 *   - region             grid region code
 *   - carbon_budget_g    REAL (nullable)
 *   - result_json        text (nullable)
 *   - error              text (nullable)
 *   - receipt_json       text (nullable)
 *   - intensity_source   "scored" | "current" | "expedited" (nullable)
 *   - body_json          persisted provider-call spec (nullable, v0.4)
 *   - estimated_carbon_g REAL, schedule-time projection (nullable, v0.9)
 *   - deadline           ISO-8601 normalized deadline (nullable, v0.12)
 *   - title, origin_host, origin_cwd, parent_task_id
 *                        task identity, written once at insert (v0.17)
 *   - read_at            ISO-8601, set when a surface showed the finished
 *                        task (v0.17); written only by markRead/markUnread
 *   - deadline_kind      "absolute" | "quota_reset" (nullable = absolute, v0.17)
 *   - quota_provider     quota label for a quota_reset deadline (v0.17)
 *   - series_id, origin_session_id
 *                        series membership and the Claude Code session,
 *                        written once at insert (ui v2)
 *   - repeat             "none" | "daily" | "weekly" | "quota_reset"
 *                        (nullable = none, ui v2); written at insert and
 *                        afterwards only by transitionIf ("stop series")
 *   - not_before         ISO-8601 earliest dispatch time (nullable, ui v2)
 *   - job_id             the job this row is an occurrence of (nullable,
 *                        written once at insert)
 *
 * The `jobs` table (TS-only; the Python core never reads it) holds floating
 * recurring jobs. Every job write after the insert is a compare-and-set on
 * `revision` (`updateJobIf`).
 *
 * Writes from separate processes (the UI server, the CLI, a ticker) use
 * compare-and-set: `transitionIf` updates a row only while its status is in
 * an expected list, and `insertIfAbsent` creates a row at most once.
 *
 * `result_json` is serialized via JSON.stringify; values that are not
 * JSON-serializable are stored as `{ "_repr": "<toString>" }` so audit
 * trails survive odd values without crashing the store.
 */

import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import {
  DEFAULT_JOB_CAPS,
  type CarbonReceipt,
  type DeadlineKind,
  type JobCadence,
  type JobNotify,
  type JobOutcome,
  type JobRecord,
  type JobStatus,
  type JobTemplate,
  type RepeatRule,
  type TaskOriginHost,
  type TaskRecord,
  type TaskStatus,
  type Weekday,
} from "../types.js";
import { isChannelKind } from "../channels/kinds/index.js";
import { EVENT_KINDS, type Channel, type EventKind } from "../channels/types.js";
import { isTaskEventKind, normalizeActor, type TaskEvent, type TaskEventInput, type TaskEventKind } from "../task-events.js";

const requireFn = createRequire(import.meta.url);

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlitePreparedStatement;
  close(): void;
}

interface SqlitePreparedStatement {
  run(...params: unknown[]): {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  task_id           TEXT PRIMARY KEY,
  status            TEXT NOT NULL,
  enqueued_at       TEXT NOT NULL,
  scheduled_for     TEXT,
  completed_at      TEXT,
  region            TEXT NOT NULL,
  carbon_budget_g   REAL,
  result_json       TEXT,
  error             TEXT,
  receipt_json      TEXT,
  intensity_source  TEXT,
  body_json         TEXT,
  estimated_carbon_g REAL,
  deadline          TEXT,
  batch_id          TEXT,
  routing_decision  TEXT,
  title             TEXT,
  origin_host       TEXT,
  origin_cwd        TEXT,
  read_at           TEXT,
  parent_task_id    TEXT,
  deadline_kind     TEXT,
  quota_provider    TEXT,
  series_id         TEXT,
  repeat            TEXT,
  origin_session_id TEXT,
  not_before        TEXT
);
CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks(status);
CREATE INDEX IF NOT EXISTS tasks_enqueued_idx ON tasks(enqueued_at);

-- Carbon-budget alert markers (ROADMAP item 4). One row per
-- (window_kind, window_start, threshold_g) records that the aggregate
-- carbon budget for that rolling window has already fired an alert. The
-- composite PRIMARY KEY is what makes an alert idempotent across restarts
-- and safe under a multi-process double-fire: a second INSERT with the
-- same key is a no-op (0 rows changed), so only the first crosser fires.
-- Derived state — never signed, never part of the receipt ledger proper.
CREATE TABLE IF NOT EXISTS carbon_budget_alerts (
  window_kind   TEXT NOT NULL,
  window_start  TEXT NOT NULL,
  threshold_g   REAL NOT NULL,
  actual_g      REAL NOT NULL,
  task_id       TEXT,
  alerted_at    TEXT NOT NULL,
  PRIMARY KEY (window_kind, window_start, threshold_g)
);

-- Small key/value table for ledger-wide facts that are not tasks, e.g.
-- last_tick_at (when a ticker last ran). Derived state, never signed.
CREATE TABLE IF NOT EXISTS meta (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

-- Notification channels (coherence KTD10): a paired Telegram chat, etc.
-- TS-only; the Python core never reads it. Secrets (the bot token) are
-- never stored here.
CREATE TABLE IF NOT EXISTS channels (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  events_json  TEXT NOT NULL,
  config_json  TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

-- Task events (audit trail): one row per change of a task, written in the
-- same transaction as the task write. Shared with the Python core (same
-- DDL). The trigger keeps events exactly as long as their task row.
CREATE TABLE IF NOT EXISTS task_events (
  id       INTEGER PRIMARY KEY,
  task_id  TEXT NOT NULL,
  at       TEXT NOT NULL,
  kind     TEXT NOT NULL,
  actor    TEXT NOT NULL,
  details  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS task_events_task_idx ON task_events(task_id, at);
CREATE TRIGGER IF NOT EXISTS task_events_retention AFTER DELETE ON tasks
BEGIN
  DELETE FROM task_events WHERE task_id = OLD.task_id;
END;

-- Floating recurring jobs. TS-only; the Python core never reads it. Each
-- job keeps one live occurrence in tasks (tasks.job_id). The run template
-- and caps are JSON, read whole; cadence, window and status are columns.
CREATE TABLE IF NOT EXISTS jobs (
  job_id               TEXT PRIMARY KEY,
  title                TEXT NOT NULL,
  status               TEXT NOT NULL,
  cadence              TEXT NOT NULL,
  cadence_hours        INTEGER,
  cadence_days         TEXT,
  window_start         TEXT,
  window_end           TEXT,
  time_zone            TEXT NOT NULL,
  runner               TEXT NOT NULL,
  template_json        TEXT NOT NULL,
  caps_json            TEXT NOT NULL,
  notify               TEXT NOT NULL DEFAULT 'every_run',
  origin_host          TEXT,
  origin_cwd           TEXT,
  created_by           TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  revision             INTEGER NOT NULL DEFAULT 1,
  next_seq             INTEGER NOT NULL DEFAULT 1,
  pending_task_id      TEXT,
  last_task_id         TEXT,
  last_run_started_at  TEXT,
  last_outcome         TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  retry_used           INTEGER NOT NULL DEFAULT 0,
  pause_reason         TEXT,
  paused_at            TEXT,
  pause_notified_at    TEXT
);
CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs(status);
`;

/**
 * Idempotent column migrations. SQLite allows `ADD COLUMN` on a
 * non-empty table because each new column is nullable. We check
 * `pragma_table_info` first so re-running on an already-migrated DB
 * (including a freshly created DB) is a no-op. The check-then-ALTER is
 * racy when two processes open the same DB simultaneously (TOCTOU), so
 * a concurrent "duplicate column name" error is swallowed — the column
 * exists either way.
 *   - body_json          (v0.4) persistent provider-call task bodies
 *   - estimated_carbon_g (v0.9) schedule-time carbon projection, so the
 *                        receipt can report actual-vs-estimated delta
 *   - deadline           (v0.12) normalized ISO deadline captured at
 *                        enqueue, for dispatch-time batch decisions
 *   - batch_id           (v0.12) provider batch id set when a task is
 *                        routed through the Batch API (status "submitted")
 */
function ensureColumns(db: SqliteDatabase): void {
  const rows = db
    .prepare(`SELECT name FROM pragma_table_info('tasks')`)
    .all() as Array<{ name: string }>;
  const have = new Set(rows.map((r) => r.name));
  /** Returns true iff THIS call added the column. */
  const addColumn = (name: string, type: string): boolean => {
    if (have.has(name)) return false;
    try {
      db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${type}`);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Another process migrated between our pragma check and the ALTER.
      if (!/duplicate column name/i.test(msg)) throw err;
      return false;
    }
  };
  addColumn("body_json", "TEXT");
  addColumn("estimated_carbon_g", "REAL");
  addColumn("deadline", "TEXT");
  addColumn("batch_id", "TEXT");
  // routing_decision (ROADMAP item 1): the scored cross-provider routing
  // decision, persisted at schedule time and folded into the receipt.
  addColumn("routing_decision", "TEXT");
  // v0.17 task visibility: identity, read marker, deadline kind.
  addColumn("title", "TEXT");
  addColumn("origin_host", "TEXT");
  addColumn("origin_cwd", "TEXT");
  addColumn("parent_task_id", "TEXT");
  addColumn("deadline_kind", "TEXT");
  addColumn("quota_provider", "TEXT");
  if (addColumn("read_at", "TEXT")) {
    // One-time backfill, only in the process that added the column: tasks
    // that finished before read markers existed count as read, so an
    // upgrade does not flood the inbox with history. The Python port runs
    // the same backfill; whichever process migrates first does it.
    db.exec(
      `UPDATE tasks SET read_at = COALESCE(completed_at, enqueued_at)
        WHERE status IN ('completed', 'failed') AND read_at IS NULL`,
    );
  }
  db.exec(
    `CREATE INDEX IF NOT EXISTS tasks_parent_idx ON tasks(parent_task_id)`,
  );
  // ui v2: repeating series, Claude Code session, pinned earliest start.
  addColumn("series_id", "TEXT");
  addColumn("repeat", "TEXT");
  addColumn("origin_session_id", "TEXT");
  addColumn("not_before", "TEXT");
  db.exec(`CREATE INDEX IF NOT EXISTS tasks_series_idx ON tasks(series_id)`);
  // Floating recurring jobs: the job a row is an occurrence of. No backfill:
  // NULL means "not a job occurrence".
  addColumn("job_id", "TEXT");
  db.exec(`CREATE INDEX IF NOT EXISTS tasks_job_idx ON tasks(job_id)`);
}

const REPEAT_RULES: ReadonlySet<string> = new Set(["none", "daily", "weekly", "quota_reset"]);

/** Every column of the tasks table, in INSERT order. */
const INSERT_COLUMNS = [
  "task_id", "status", "enqueued_at", "scheduled_for", "completed_at",
  "region", "carbon_budget_g", "result_json", "error", "receipt_json", "intensity_source",
  "body_json", "estimated_carbon_g", "deadline", "batch_id", "routing_decision",
  "title", "origin_host", "origin_cwd", "parent_task_id", "deadline_kind", "quota_provider",
  "series_id", "repeat", "origin_session_id", "not_before", "job_id",
] as const;

const INSERT_SQL = `INSERT INTO tasks (${INSERT_COLUMNS.join(", ")})
  VALUES (${INSERT_COLUMNS.map((c) => `@${c}`).join(", ")})`;

/** Timing columns `transitionIf(..., unchangedSince)` compares with an earlier read. */
const TIMING_GUARD_COLUMNS = ["scheduled_for", "not_before", "deadline", "intensity_source"] as const;

/** Columns `transitionIf` binds: the mutable ones plus the key. */
const TRANSITION_COLUMNS = [
  "task_id", "status", "scheduled_for", "completed_at", "result_json", "error",
  "receipt_json", "intensity_source", "body_json", "estimated_carbon_g", "deadline",
  "batch_id", "routing_decision", "not_before", "repeat", "deadline_kind", "quota_provider",
] as const;

function recordParams(record: TaskRecord<unknown>): Record<string, unknown> {
  return {
    task_id: record.taskId,
    status: record.status,
    enqueued_at: record.enqueuedAt,
    scheduled_for: record.scheduledFor ?? null,
    completed_at: record.completedAt ?? null,
    region: record.region,
    carbon_budget_g: record.carbonBudgetG ?? null,
    result_json: safeStringify(record.result),
    error: record.error ?? null,
    receipt_json: safeStringify(record.receipt),
    intensity_source: record.intensitySource ?? null,
    body_json: record.bodyJson ?? null,
    estimated_carbon_g: record.estimatedCarbonGCo2 ?? null,
    deadline: record.deadline ?? null,
    batch_id: record.batchId ?? null,
    routing_decision: safeStringify(record.routingDecision),
    title: record.title ?? null,
    origin_host: record.originHost ?? null,
    origin_cwd: record.originCwd ?? null,
    parent_task_id: record.parentTaskId ?? null,
    deadline_kind: record.deadlineKind ?? null,
    quota_provider: record.quotaProvider ?? null,
    series_id: record.seriesId ?? null,
    repeat: record.repeat ?? null,
    origin_session_id: record.originSessionId ?? null,
    not_before: record.notBefore ?? null,
    job_id: record.jobId ?? null,
  };
}

function safeStringify(value: unknown): string | null {
  if (value === undefined) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ _repr: String(value) });
  }
}

function safeParse(s: string | null | undefined): unknown {
  if (s == null) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** Filters for {@link TaskStore.list}; all given filters must match. */
export interface TaskListFilter {
  status?: TaskStatus;
  /** Only finished (`completed` / `failed`) tasks with no read marker. */
  unread?: boolean;
  /** `absolute` also matches legacy rows with no stored kind. */
  deadlineKind?: DeadlineKind;
  /** Only occurrences of this series (ui v2). */
  seriesId?: string;
  /** Only occurrences of this job. */
  jobId?: string;
}

export interface TaskStoreOptions {
  /** Absolute path to a SQLite file. Use ":memory:" for ephemeral storage (tests). */
  dbPath: string;
  /** Inject a pre-opened SQLite database — node:sqlite or better-sqlite3 (useful for tests). */
  db?: SqliteDatabase;
}

export class TaskStore {
  private readonly db: SqliteDatabase;
  private txDepth = 0;

  constructor(opts: TaskStoreOptions) {
    if (opts.db) {
      this.db = opts.db;
    } else {
      // A fresh home has no ~/.tidegap until `tidegap install`; every
      // command opens the ledger here, so create its directory (0700, like
      // the chmod below) instead of failing with "unable to open database
      // file". recursive: an existing directory is left as it is.
      if (opts.dbPath !== ":memory:") mkdirSync(dirname(opts.dbPath), { recursive: true, mode: 0o700 });
      this.db = openSqliteSync(opts.dbPath);
    }
    // v0.11: enable WAL on disk-backed stores. WAL lifts SQLite's
    // single-writer-per-DB-file pessimism so the `tidegap tick` daemon and
    // an interactive process can hold separate `TaskStore` handles
    // against `~/.tidegap/queue.db`. Writers can still collide briefly
    // (one writer at a time even under WAL), so busy_timeout makes a
    // colliding writer queue for up to 5s instead of throwing
    // SQLITE_BUSY immediately — node:sqlite defaults to 0ms,
    // better-sqlite3 to 5s; the explicit pragma pins both backends to
    // the same behavior. The WAL PRAGMA is persistent in the DB header
    // so running once on first open is enough; busy_timeout is
    // per-connection and must be set on every open. In-memory DBs
    // (`:memory:`) intentionally skip — WAL on ephemeral stores adds
    // no value.
    if (opts.dbPath !== ":memory:") {
      try {
        this.db.exec("PRAGMA journal_mode = WAL");
        this.db.exec("PRAGMA busy_timeout = 5000");
        // synchronous=NORMAL is the standard WAL companion — durable
        // across app crashes, faster than FULL, only loses the very
        // last transaction on a hard power loss. Tidegap dispatch is
        // idempotent over `task_id`, so the worst case re-runs one task.
        this.db.exec("PRAGMA synchronous = NORMAL");
      } catch {
        // Some drivers (or read-only filesystems) refuse the pragma.
        // The store still works, just without WAL — fall through.
      }
    }
    this.db.exec(SCHEMA);
    ensureColumns(this.db);
    // The ledger stores prompts (redacted only at terminal transitions)
    // next to a 0600 signing key — keep the DB and its WAL side-files
    // out of reach of other local users. Best-effort: never fail open
    // over a chmod error (e.g. exotic filesystems, Windows).
    if (!opts.db && opts.dbPath !== ":memory:") {
      try {
        chmodSync(dirname(opts.dbPath), 0o700);
      } catch {
        // best-effort
      }
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          const p = `${opts.dbPath}${suffix}`;
          if (existsSync(p)) chmodSync(p, 0o600);
        } catch {
          // best-effort
        }
      }
    }
  }

  upsert(record: TaskRecord<unknown>, event?: TaskEventInput): void {
    const stmt = this.db.prepare(`
      ${INSERT_SQL}
      ON CONFLICT(task_id) DO UPDATE SET
        status             = excluded.status,
        scheduled_for      = excluded.scheduled_for,
        completed_at       = excluded.completed_at,
        region             = excluded.region,
        carbon_budget_g    = excluded.carbon_budget_g,
        result_json        = excluded.result_json,
        error              = excluded.error,
        receipt_json       = excluded.receipt_json,
        intensity_source   = excluded.intensity_source,
        body_json          = excluded.body_json,
        estimated_carbon_g = excluded.estimated_carbon_g,
        deadline           = excluded.deadline,
        batch_id           = excluded.batch_id,
        routing_decision   = excluded.routing_decision,
        not_before         = excluded.not_before,
        deadline_kind      = COALESCE(excluded.deadline_kind, tasks.deadline_kind),
        quota_provider     = CASE
          WHEN excluded.deadline_kind = 'absolute' THEN NULL
          ELSE COALESCE(excluded.quota_provider, tasks.quota_provider)
        END
    `);
    // Identity columns (title, origin_*, parent_task_id, series_id,
    // origin_session_id, job_id) and repeat are written on insert only and are
    // deliberately absent from DO UPDATE: a stale in-memory copy must not
    // undo a "stop series" another process wrote (transitionIf owns repeat).
    // read_at is never written here: the tick and the UI are separate
    // processes, and an in-memory record without readAt must not clear a
    // mark another process set. Use markRead / markUnread.
    this.tx(() => {
      stmt.run(recordParams(record));
      if (event) this.insertEvent(record.taskId, event);
    });
  }

  /**
   * Insert a row only if no row with this id exists (ui v2). Returns true iff
   * this call inserted it. Series rollover uses it with a deterministic
   * successor id, so two dispatchers finishing the same occurrence create
   * exactly one successor.
   */
  insertIfAbsent(record: TaskRecord<unknown>, event?: TaskEventInput): boolean {
    return this.tx(() => {
      const res = this.db
        .prepare(`${INSERT_SQL} ON CONFLICT(task_id) DO NOTHING`)
        .run(recordParams(record));
      const inserted = Number(res.changes) === 1;
      if (inserted && event) this.insertEvent(record.taskId, event);
      return inserted;
    });
  }

  /**
   * Compare-and-set write (ui v2): store the mutable columns of `record`, but
   * only while the row's status is one of `expectedStatuses`. Returns false,
   * writing nothing, when another process moved the row on meanwhile. Every
   * cross-process write path (cancel, run now, reschedule, the dispatcher's
   * terminal writes) goes through this instead of an unconditional upsert.
   *
   * `unchangedSince`, when given, also requires the row's timing columns
   * (`scheduled_for`, `not_before`, `deadline`, `intensity_source`) to equal
   * that earlier read: a write computed from a stale read (a forecast fetch
   * that awaited while the UI ran a task now or pinned it) then misses
   * instead of overwriting the newer timing.
   *
   * `event`, when given, is written to `task_events` in the same
   * transaction, and only when the update hit.
   */
  transitionIf(
    record: TaskRecord<unknown>,
    expectedStatuses: readonly TaskStatus[],
    unchangedSince?: TaskRecord<unknown>,
    event?: TaskEventInput,
  ): boolean {
    if (expectedStatuses.length === 0) return false;
    const placeholders = expectedStatuses.map((_, i) => `@expected_${i}`).join(", ");
    // Bind only the columns this UPDATE names: node:sqlite rejects unknown
    // named parameters. Identity columns stay out (insert-only).
    const all = recordParams(record);
    const params: Record<string, unknown> = {};
    for (const key of TRANSITION_COLUMNS) params[key] = all[key];
    expectedStatuses.forEach((status, i) => {
      params[`expected_${i}`] = status;
    });
    if (record.repeat !== undefined && !REPEAT_RULES.has(record.repeat)) {
      throw new Error(`transitionIf: invalid repeat ${JSON.stringify(record.repeat)}`);
    }
    let guard = "";
    if (unchangedSince) {
      const prev = recordParams(unchangedSince);
      for (const col of TIMING_GUARD_COLUMNS) params[`was_${col}`] = prev[col];
      guard = TIMING_GUARD_COLUMNS.map((col) => ` AND ${col} IS @was_${col}`).join("");
    }
    const update = this.db
      .prepare(
        `UPDATE tasks SET
           status             = @status,
           scheduled_for      = @scheduled_for,
           completed_at       = @completed_at,
           result_json        = @result_json,
           error              = @error,
           receipt_json       = @receipt_json,
           intensity_source   = @intensity_source,
           body_json          = @body_json,
           estimated_carbon_g = @estimated_carbon_g,
           deadline           = @deadline,
           batch_id           = @batch_id,
           routing_decision   = @routing_decision,
           not_before         = @not_before,
           repeat             = @repeat,
           deadline_kind      = COALESCE(@deadline_kind, deadline_kind),
           quota_provider     = CASE
             -- A quota_reset series keeps its label on a moved (absolute)
             -- occurrence: rollover reads it back for the next one.
             WHEN @deadline_kind = 'absolute' AND COALESCE(@repeat, 'none') <> 'quota_reset'
               THEN NULL
             ELSE COALESCE(@quota_provider, quota_provider)
           END
         WHERE task_id = @task_id AND status IN (${placeholders})${guard}`,
      );
    return this.tx(() => {
      const hit = Number(update.run(params).changes) === 1;
      if (hit && event) this.insertEvent(record.taskId, event);
      return hit;
    });
  }

  /** Append one event to a task's log in its own transaction. */
  recordEvent(taskId: string, event: TaskEventInput): void {
    this.tx(() => this.insertEvent(taskId, event));
  }

  /**
   * A task's events, oldest first. `limit` keeps the newest `limit` rows.
   * Rows with an unknown kind (a newer writer) are skipped.
   */
  listTaskEvents(taskId: string, opts: { limit?: number } = {}): TaskEvent[] {
    const limit = opts.limit !== undefined && opts.limit > 0 ? Math.floor(opts.limit) : -1;
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT id, task_id, at, kind, actor, details FROM task_events
            WHERE task_id = ? ORDER BY at DESC, id DESC LIMIT ?
         ) ORDER BY at ASC, id ASC`,
      )
      .all(taskId, limit);
    const out: TaskEvent[] = [];
    for (const row of rows) {
      if (!isTaskEventKind(row.kind)) continue;
      out.push(rowToEvent(row, row.kind));
    }
    return out;
  }

  /**
   * Events of every task with `at` in (`since`, `until`], oldest first,
   * optionally of the given kinds only. Rows with an unknown kind are skipped.
   */
  listEventsSince(since: string, until: string, kinds?: readonly TaskEventKind[]): TaskEvent[] {
    const byKind = kinds ? ` AND kind IN (${kinds.map(() => "?").join(", ") || "NULL"})` : "";
    const rows = this.db
      .prepare(`SELECT id, task_id, at, kind, actor, details FROM task_events WHERE at > ? AND at <= ?${byKind} ORDER BY at ASC, id ASC`)
      .all(since, until, ...(kinds ?? []));
    const out: TaskEvent[] = [];
    for (const row of rows) {
      if (!isTaskEventKind(row.kind)) continue;
      out.push(rowToEvent(row, row.kind));
    }
    return out;
  }

  /** Completed and failed tasks with `completed_at` in (`since`, `until`], oldest first (both cores write `completed_at`). */
  listFinishedSince(since: string, until: string): TaskRecord<unknown>[] {
    return this.db
      .prepare(
        `SELECT * FROM tasks WHERE status IN ('completed', 'failed') AND completed_at > ? AND completed_at <= ? ORDER BY completed_at ASC`,
      )
      .all(since, until)
      .map(rowToRecord);
  }

  private insertEvent(taskId: string, event: TaskEventInput): void {
    this.db
      .prepare(`INSERT INTO task_events (task_id, at, kind, actor, details) VALUES (?, ?, ?, ?, ?)`)
      .run(taskId, new Date().toISOString(), event.kind, normalizeActor(event.actor), safeStringify(event.details ?? {}) ?? "{}");
  }

  /**
   * Run `fn` in one write transaction (`BEGIN IMMEDIATE`), rolled back when
   * it throws. Re-entrant: a nested call joins the open transaction.
   */
  private tx<T>(fn: () => T): T {
    if (this.txDepth > 0) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.txDepth++;
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // already rolled back by SQLite
      }
      throw err;
    } finally {
      this.txDepth--;
    }
  }

  get(taskId: string): TaskRecord<unknown> | undefined {
    const row = this.db
      .prepare(`SELECT * FROM tasks WHERE task_id = ?`)
      .get(taskId);
    return row ? rowToRecord(row) : undefined;
  }

  list(filter?: TaskListFilter): TaskRecord<unknown>[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter?.status) {
      where.push(`status = ?`);
      params.push(filter.status);
    }
    if (filter?.unread) {
      where.push(`status IN ('completed', 'failed') AND read_at IS NULL`);
    }
    if (filter?.deadlineKind === "absolute") {
      where.push(`(deadline_kind IS NULL OR deadline_kind = 'absolute')`);
    } else if (filter?.deadlineKind) {
      where.push(`deadline_kind = ?`);
      params.push(filter.deadlineKind);
    }
    if (filter?.seriesId) {
      where.push(`series_id = ?`);
      params.push(filter.seriesId);
    }
    if (filter?.jobId) {
      where.push(`job_id = ?`);
      params.push(filter.jobId);
    }
    const clause = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
    return this.db
      .prepare(`SELECT * FROM tasks${clause} ORDER BY enqueued_at ASC`)
      .all(...params)
      .map(rowToRecord);
  }

  /**
   * Mark a finished task read. Only `completed` / `failed` rows that are
   * still unread change; returns true iff this call set the marker, so a
   * second call never moves the first timestamp.
   */
  markRead(taskId: string, at: Date | string = new Date()): boolean {
    const iso = typeof at === "string" ? at : at.toISOString();
    const res = this.db
      .prepare(
        `UPDATE tasks SET read_at = ?
          WHERE task_id = ? AND read_at IS NULL
            AND status IN ('completed', 'failed')`,
      )
      .run(iso, taskId);
    return Number(res.changes) === 1;
  }

  /** Clear a task's read marker. Returns true iff the marker was set. */
  markUnread(taskId: string): boolean {
    const res = this.db
      .prepare(
        `UPDATE tasks SET read_at = NULL WHERE task_id = ? AND read_at IS NOT NULL`,
      )
      .run(taskId);
    return Number(res.changes) === 1;
  }

  /**
   * SQLite's `PRAGMA data_version`: changes whenever ANOTHER connection
   * commits to this database file. Cheap change detector for pollers.
   */
  dataVersion(): number {
    const row = this.db.prepare(`PRAGMA data_version`).get() as
      | { data_version: number | bigint }
      | undefined;
    return Number(row?.data_version ?? 0);
  }

  /** Read one ledger-wide meta value (e.g. `last_tick_at`). */
  getMeta(key: string): string | undefined {
    const row = this.db
      .prepare(`SELECT value FROM meta WHERE key = ?`)
      .get(key) as { value: string } | undefined;
    return row?.value;
  }

  /** Write one ledger-wide meta value. */
  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  /** Remove one meta value; a missing key is a no-op. */
  deleteMeta(key: string): void {
    this.db.prepare(`DELETE FROM meta WHERE key = ?`).run(key);
  }

  /** Every channel row, oldest first; a row with an unknown kind or bad JSON is skipped. */
  listChannels(): Channel[] {
    const rows = this.db.prepare(`SELECT * FROM channels ORDER BY created_at, id`).all();
    const out: Channel[] = [];
    for (const row of rows) {
      const kind = row.kind as string;
      const events = safeParse(row.events_json as string);
      const config = safeParse(row.config_json as string);
      if (!isChannelKind(kind) || !Array.isArray(events) || !config || typeof config !== "object") continue;
      out.push({
        id: row.id as string,
        kind,
        enabled: Number(row.enabled) === 1,
        events: events.filter((e): e is EventKind => (EVENT_KINDS as readonly unknown[]).includes(e)),
        config: config as Record<string, unknown>,
        createdAt: row.created_at as string,
      });
    }
    return out;
  }

  /** Insert or replace a channel row (pairing the same chat again replaces it). */
  insertChannel(channel: Channel): void {
    this.db
      .prepare(
        `INSERT INTO channels (id, kind, enabled, events_json, config_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, enabled = excluded.enabled,
           events_json = excluded.events_json, config_json = excluded.config_json`,
      )
      .run(channel.id, channel.kind, channel.enabled ? 1 : 0, JSON.stringify(channel.events), JSON.stringify(channel.config), channel.createdAt);
  }

  /** Remove a channel; false when no row had that id. */
  removeChannel(id: string): boolean {
    return Number(this.db.prepare(`DELETE FROM channels WHERE id = ?`).run(id).changes) > 0;
  }

  /**
   * Conditional write for the quota sweep: store the columns a reschedule
   * (or a budget failure) changes, but only while the row is still pending
   * (`queued` / `scheduled`). Returns false when another process moved the
   * row on (claimed, submitted, finished) in the meantime; nothing is written.
   */
  updateIfPending(record: TaskRecord<unknown>): boolean {
    const res = this.db
      .prepare(
        `UPDATE tasks SET
           status             = @status,
           scheduled_for      = @scheduled_for,
           completed_at       = @completed_at,
           error              = @error,
           body_json          = @body_json,
           estimated_carbon_g = @estimated_carbon_g,
           deadline           = @deadline,
           routing_decision   = @routing_decision,
           not_before         = @not_before
         WHERE task_id = @task_id AND status IN ('queued', 'scheduled')`,
      )
      .run({
        task_id: record.taskId,
        status: record.status,
        scheduled_for: record.scheduledFor ?? null,
        completed_at: record.completedAt ?? null,
        error: record.error ?? null,
        body_json: record.bodyJson ?? null,
        estimated_carbon_g: record.estimatedCarbonGCo2 ?? null,
        deadline: record.deadline ?? null,
        routing_decision: safeStringify(record.routingDecision),
        not_before: record.notBefore ?? null,
      });
    return Number(res.changes) === 1;
  }

  /**
   * Atomic row-level claim used by `Scheduler.tick` to prevent two
   * concurrent ticks from dispatching the same task. Returns true if
   * the row was claimed (status changed from "scheduled" to "running"
   * in this call); false if the row had already moved on.
   *
   * With WAL + busy_timeout (v0.11+) two processes can hold writable
   * handles on the same DB file; this row-level claim is what makes a
   * dispatch exactly-once across them (e.g. an interactive `tidegap tick`
   * racing the launchd cron, or `expedite_task` racing a cron tick).
   */
  claimScheduled(taskId: string): boolean {
    const stmt = this.db.prepare(
      `UPDATE tasks SET status = 'running' WHERE task_id = ? AND status = 'scheduled'`,
    );
    const res = stmt.run(taskId);
    return Number(res.changes) === 1;
  }

  /**
   * Atomic row-level claim for the polling side of the Batch API path
   * (v0.12): flips a row from "submitted" to "running" so two racing
   * ticks (or an interactive `tidegap tick` + the launchd cron) cannot both
   * complete the same submitted batch. Mirrors `claimScheduled`. Returns
   * true iff this call performed the transition.
   */
  claimSubmitted(taskId: string): boolean {
    const stmt = this.db.prepare(
      `UPDATE tasks SET status = 'running' WHERE task_id = ? AND status = 'submitted'`,
    );
    const res = stmt.run(taskId);
    return Number(res.changes) === 1;
  }

  /**
   * Record a carbon-budget alert marker for a (windowKind, windowStart,
   * thresholdG) triple, returning true iff THIS call inserted the row.
   *
   * The composite PRIMARY KEY makes the write idempotent: a second call for
   * the same window+threshold conflicts and changes 0 rows, so exactly one
   * caller — the first crosser, in this process or any other pointed at the
   * same DB file — gets `true` and fires the alert. This is the multi-process
   * double-fire guard (mirrors the row-level dispatch claim).
   */
  recordBudgetAlert(
    windowKind: string,
    windowStart: string,
    thresholdG: number,
    actualG: number,
    taskId: string | undefined,
    alertedAt: string,
  ): boolean {
    const stmt = this.db.prepare(`
      INSERT INTO carbon_budget_alerts (
        window_kind, window_start, threshold_g, actual_g, task_id, alerted_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(window_kind, window_start, threshold_g) DO NOTHING
    `);
    const res = stmt.run(
      windowKind,
      windowStart,
      thresholdG,
      actualG,
      taskId ?? null,
      alertedAt,
    );
    return Number(res.changes) === 1;
  }

  /** True if an alert has already fired for this (windowKind, windowStart, thresholdG). */
  hasBudgetAlert(
    windowKind: string,
    windowStart: string,
    thresholdG: number,
  ): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM carbon_budget_alerts
          WHERE window_kind = ? AND window_start = ? AND threshold_g = ? LIMIT 1`,
      )
      .get(windowKind, windowStart, thresholdG);
    return row !== undefined;
  }

  /** Insert a new job row. Throws when the id exists. */
  insertJob(job: JobRecord): void {
    this.db.prepare(`INSERT INTO jobs (${JOB_COLUMNS.join(", ")}) VALUES (${JOB_COLUMNS.map((c) => `@${c}`).join(", ")})`).run(jobParams(job));
  }

  getJob(jobId: string): JobRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM jobs WHERE job_id = ?`).get(jobId);
    return row ? rowToJob(row) : undefined;
  }

  /** Jobs, oldest first; `status` limits the list to one or several statuses. */
  listJobs(filter: { status?: JobStatus | readonly JobStatus[] } = {}): JobRecord[] {
    const statuses = filter.status === undefined ? [] : typeof filter.status === "string" ? [filter.status] : [...filter.status];
    const clause = statuses.length > 0 ? ` WHERE status IN (${statuses.map(() => "?").join(", ")})` : "";
    return this.db
      .prepare(`SELECT * FROM jobs${clause} ORDER BY created_at ASC, job_id ASC`)
      .all(...statuses)
      .map(rowToJob);
  }

  /**
   * Compare-and-set job write: store the mutable columns of `next` only while
   * the row's revision is `expectedRevision`, and add one to the revision.
   * Returns false, writing nothing, when another writer got there first.
   * `job_id`, `created_at`, `created_by` and the origin columns never change.
   */
  updateJobIf(next: JobRecord, expectedRevision: number): boolean {
    const all = jobParams(next);
    const params: Record<string, unknown> = { expected_revision: expectedRevision };
    for (const col of JOB_MUTABLE_COLUMNS) params[col] = all[col];
    params.job_id = all.job_id;
    const res = this.db
      .prepare(
        `UPDATE jobs SET ${JOB_MUTABLE_COLUMNS.map((c) => `${c} = @${c}`).join(", ")}, revision = revision + 1
          WHERE job_id = @job_id AND revision = @expected_revision`,
      )
      .run(params);
    return Number(res.changes) === 1;
  }

  close(): void {
    this.db.close();
  }
}

/** Columns of the jobs table, in INSERT order. */
const JOB_COLUMNS = [
  "job_id", "title", "status", "cadence", "cadence_hours", "cadence_days", "window_start", "window_end",
  "time_zone", "runner", "template_json", "caps_json", "notify", "origin_host", "origin_cwd", "created_by",
  "created_at", "updated_at", "revision", "next_seq", "pending_task_id", "last_task_id", "last_run_started_at",
  "last_outcome", "consecutive_failures", "retry_used", "pause_reason", "paused_at", "pause_notified_at",
] as const;

/** Columns `updateJobIf` writes: everything except the identity and the revision. */
const JOB_MUTABLE_COLUMNS = JOB_COLUMNS.filter(
  (c) => !["job_id", "created_at", "created_by", "origin_host", "origin_cwd", "revision"].includes(c),
);

const JOB_STATUSES: ReadonlySet<string> = new Set(["active", "paused", "removed"]);
const JOB_NOTIFY: ReadonlySet<string> = new Set(["every_run", "failures", "summary"]);
const JOB_OUTCOMES: ReadonlySet<string> = new Set(["ok", "failed", "skipped"]);

function jobParams(job: JobRecord): Record<string, unknown> {
  const c = job.cadence;
  return {
    job_id: job.jobId,
    title: job.title,
    status: job.status,
    cadence: c.kind,
    cadence_hours: c.kind === "hours" ? c.every : null,
    cadence_days: c.kind === "weekly" ? c.days.join(",") : null,
    window_start: job.window?.start ?? null,
    window_end: job.window?.end ?? null,
    time_zone: job.timeZone,
    runner: job.template.runner,
    template_json: JSON.stringify(job.template),
    caps_json: JSON.stringify(job.caps),
    notify: job.notify,
    origin_host: job.originHost ?? null,
    origin_cwd: job.originCwd ?? null,
    created_by: job.createdBy ?? null,
    created_at: job.createdAt,
    updated_at: job.updatedAt,
    revision: job.revision,
    next_seq: job.nextSeq,
    pending_task_id: job.pendingTaskId ?? null,
    last_task_id: job.lastTaskId ?? null,
    last_run_started_at: job.lastRunStartedAt ?? null,
    last_outcome: job.lastOutcome ?? null,
    consecutive_failures: job.consecutiveFailures,
    retry_used: job.retryUsed ? 1 : 0,
    pause_reason: job.pauseReason ?? null,
    paused_at: job.pausedAt ?? null,
    pause_notified_at: job.pauseNotifiedAt ?? null,
  };
}

/** The template stored for a job, or undefined when it is not a template object. */
function parseTemplate(raw: unknown, runner: unknown): JobTemplate | undefined {
  const t = safeParse(raw as string | null);
  if (!t || typeof t !== "object" || Array.isArray(t)) return undefined;
  const tpl = t as JobTemplate;
  if (tpl.runner !== runner) return undefined;
  if (tpl.runner === "prompt" && typeof tpl.prompt === "string" && typeof tpl.provider === "string") return tpl;
  if (tpl.runner === "command" && typeof tpl.command === "string" && Array.isArray(tpl.secrets)) return tpl;
  return undefined;
}

function rowToCadence(row: Record<string, unknown>): JobCadence | undefined {
  switch (row.cadence) {
    case "daily":
      return { kind: "daily" };
    case "weekdays":
      return { kind: "weekdays" };
    case "weekly": {
      const days = String(row.cadence_days ?? "").split(",").filter((d) => d !== "") as Weekday[];
      return { kind: "weekly", days };
    }
    case "hours":
      return { kind: "hours", every: Number(row.cadence_hours) };
    default:
      return undefined;
  }
}

/**
 * A job row as a record. A row whose template (or cadence) does not parse
 * reads as `paused` with reason `corrupt template` instead of throwing, so
 * one bad row never stops the sweep or a list.
 */
function rowToJob(row: Record<string, unknown>): JobRecord {
  const str = (v: unknown) => (v === null || v === undefined ? undefined : String(v));
  const template = parseTemplate(row.template_json, row.runner);
  const cadence = rowToCadence(row);
  const caps = safeParse(row.caps_json as string | null);
  const status = JOB_STATUSES.has(row.status as string) ? (row.status as JobStatus) : "paused";
  const job: JobRecord = {
    jobId: String(row.job_id),
    title: String(row.title),
    status,
    cadence: cadence ?? { kind: "daily" },
    window:
      row.window_start != null && row.window_end != null
        ? { start: String(row.window_start), end: String(row.window_end) }
        : undefined,
    timeZone: String(row.time_zone),
    template: template ?? (row.runner === "command"
      ? { runner: "command", command: "", secrets: [] }
      : { runner: "prompt", prompt: "", provider: "claude-code", tools: "none" }),
    caps: { ...DEFAULT_JOB_CAPS, ...(caps && typeof caps === "object" && !Array.isArray(caps) ? caps : {}) },
    notify: JOB_NOTIFY.has(row.notify as string) ? (row.notify as JobNotify) : "every_run",
    originHost: str(row.origin_host),
    originCwd: str(row.origin_cwd),
    createdBy: str(row.created_by),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    revision: Number(row.revision),
    nextSeq: Number(row.next_seq),
    pendingTaskId: str(row.pending_task_id),
    lastTaskId: str(row.last_task_id),
    lastRunStartedAt: str(row.last_run_started_at),
    lastOutcome: JOB_OUTCOMES.has(row.last_outcome as string) ? (row.last_outcome as JobOutcome) : undefined,
    consecutiveFailures: Number(row.consecutive_failures ?? 0),
    retryUsed: Number(row.retry_used ?? 0) === 1,
    pauseReason: str(row.pause_reason),
    pausedAt: str(row.paused_at),
    pauseNotifiedAt: str(row.pause_notified_at),
  };
  if ((!template || !cadence) && job.status !== "removed") {
    job.status = "paused";
    job.pauseReason = "corrupt template";
  }
  return job;
}

function rowToEvent(row: Record<string, unknown>, kind: TaskEventKind): TaskEvent {
  const details = safeParse(row.details as string | null);
  return {
    id: Number(row.id),
    taskId: String(row.task_id),
    at: String(row.at),
    kind,
    actor: normalizeActor(row.actor),
    details: details && typeof details === "object" && !Array.isArray(details) ? (details as Record<string, unknown>) : {},
  };
}

function rowToRecord(row: Record<string, unknown>): TaskRecord<unknown> {
  const receipt = safeParse(row.receipt_json as string | null) as
    | CarbonReceipt
    | undefined;
  const result = safeParse(row.result_json as string | null);
  return {
    taskId: row.task_id as string,
    status: row.status as TaskStatus,
    enqueuedAt: row.enqueued_at as string,
    scheduledFor: (row.scheduled_for as string | null) ?? undefined,
    completedAt: (row.completed_at as string | null) ?? undefined,
    region: row.region as string,
    carbonBudgetG: (row.carbon_budget_g as number | null) ?? undefined,
    result,
    error: (row.error as string | null) ?? undefined,
    receipt,
    intensitySource:
      ((row.intensity_source as string | null) as
        | "scored"
        | "current"
        | "expedited"
        | null) ?? undefined,
    bodyJson: (row.body_json as string | null) ?? undefined,
    estimatedCarbonGCo2:
      (row.estimated_carbon_g as number | null) ?? undefined,
    deadline: (row.deadline as string | null) ?? undefined,
    batchId: (row.batch_id as string | null) ?? undefined,
    routingDecision: safeParse(row.routing_decision as string | null) as
      | TaskRecord["routingDecision"]
      | undefined,
    title: (row.title as string | null | undefined) ?? undefined,
    originHost:
      ((row.origin_host as string | null | undefined) as TaskOriginHost | null) ??
      undefined,
    originCwd: (row.origin_cwd as string | null | undefined) ?? undefined,
    readAt: (row.read_at as string | null | undefined) ?? undefined,
    parentTaskId: (row.parent_task_id as string | null | undefined) ?? undefined,
    deadlineKind:
      (row.deadline_kind as string | null | undefined) === "quota_reset"
        ? "quota_reset"
        : "absolute",
    quotaProvider: (row.quota_provider as string | null | undefined) ?? undefined,
    seriesId: (row.series_id as string | null | undefined) ?? undefined,
    repeat: REPEAT_RULES.has(row.repeat as string)
      ? (row.repeat as RepeatRule)
      : undefined,
    originSessionId: (row.origin_session_id as string | null | undefined) ?? undefined,
    notBefore: (row.not_before as string | null | undefined) ?? undefined,
    jobId: (row.job_id as string | null | undefined) ?? undefined,
  };
}

type SqliteCtor = new (path: string) => SqliteDatabase;

/** Load Node's built-in SQLite (node:sqlite, Node >= 22.5), if available. */
function loadNodeSqlite(): SqliteCtor | undefined {
  try {
    const mod = requireFn("node:sqlite") as { DatabaseSync: SqliteCtor };
    return mod.DatabaseSync;
  } catch {
    return undefined;
  }
}

/** Load the optional better-sqlite3 fallback, if it is installed. */
function loadBetterSqlite(): SqliteCtor | undefined {
  try {
    return requireFn("better-sqlite3") as SqliteCtor;
  } catch {
    return undefined;
  }
}

function openSqliteSync(path: string): SqliteDatabase {
  // Prefer Node's built-in SQLite — no native module to install or compile,
  // which matters where dependencies are installed without build scripts
  // (e.g. OpenClaw plugin installs). better-sqlite3 stays as a fallback for
  // Node < 22.5. createRequire gives a working `require` from ESM emit.
  const Ctor = loadNodeSqlite() ?? loadBetterSqlite();
  if (!Ctor) {
    throw new Error(
      "TaskStore: no SQLite backend available. This build uses Node's " +
        "built-in node:sqlite (Node >= 22.5). Upgrade Node, or install the " +
        "optional better-sqlite3 dependency as a fallback.",
    );
  }
  return new Ctor(path);
}
