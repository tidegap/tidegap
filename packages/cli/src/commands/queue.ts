/**
 * `tidegap queue list | show | unread` — inspect the ledger.
 * `tidegap queue cancel | reschedule | run-now | reply` — change it (ui v2).
 *   Writes go through a `Scheduler` without adapters: they never dispatch;
 *   the dispatcher (`tidegap tick` or the OpenClaw loop) runs the task.
 *
 * We deliberately avoid a table-printing dependency. Columns are
 * padded with String.prototype.padEnd to a fixed width.
 *
 * Every task string printed here (title, prompt, result, error, ids) is
 * untrusted: it comes from prompts and model output. It goes through
 * `stripControlChars` so it cannot carry terminal escape sequences.
 */

import {
  buildDefaultGridFeed,
  deadlineKindLabel,
  displayTitle,
  LAST_TICK_META_KEY,
  loadQuotaResetConfig,
  resolveRegion,
  resumeCommand,
  Scheduler,
  stripControlChars,
  taskHistory,
  taskPrompt,
  taskResultText,
  TaskStore,
} from "@tidegap/core";
import type {
  DeadlineKind,
  GridFeed,
  QuotaResetConfig,
  RescheduleTarget,
  TaskListFilter,
  TaskRecord,
  TaskStatus,
} from "@tidegap/core";
import { existsSync } from "node:fs";

import { readEnvCredentials, readUsageEnv } from "../env.js";
import { clockLabel, hostResetTarget, windowLabel, type HostLimitsOptions } from "../usage/index.js";
import { loadEnvFileIntoProcess } from "./env-file.js";
import { defaultDbPath } from "./tick.js";

export const VALID_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "queued",
  "scheduled",
  "running",
  // v0.12: task routed through a provider Batch API, awaiting results.
  "submitted",
  "completed",
  "failed",
  "cancelled",
]);

export const VALID_KINDS: ReadonlySet<DeadlineKind> = new Set(["absolute", "quota_reset"]);

export interface QueueListOptions {
  db?: string;
  status?: string;
  /** Only finished (completed / failed) tasks nobody has viewed yet. */
  unread?: boolean;
  /** `absolute` or `quota_reset`. */
  kind?: string;
  json?: boolean;
  /**
   * SessionStart-hook mode: one line naming the unread count, or nothing.
   * Never throws; a missing or unreadable ledger prints nothing.
   */
  hook?: boolean;
  /** Only the occurrences of this series, oldest first (ui v2). */
  series?: string;
}

export interface QueueListResult {
  rows: TaskRecord<unknown>[];
  rendered: string;
}

/** One line of terminal-safe text. */
function safe(value: string): string {
  return stripControlChars(value);
}

/** Multi-line terminal-safe text (keeps newlines and tabs). */
function safeBlock(value: string): string {
  return stripControlChars(value, { multiline: true });
}

function fmtCol(value: string | number | undefined, width: number): string {
  const s = value === undefined || value === null ? "-" : safe(String(value));
  const chars = Array.from(s);
  return (chars.length > width ? chars.slice(0, width - 1).join("") + "…" : s).padEnd(width);
}

function kindCell(r: TaskRecord<unknown>): string {
  return r.deadlineKind === "quota_reset" ? `quota:${r.quotaProvider ?? "?"}` : "abs";
}

export function renderQueue(
  rows: TaskRecord<unknown>[],
  opts: { lastTickAt?: string } = {},
): string {
  const header =
    fmtCol("task_id", 38) +
    fmtCol("status", 12) +
    fmtCol("title", 34) +
    fmtCol("deadline", 26) +
    fmtCol("kind", 14) +
    fmtCol("scheduled_for", 26) +
    fmtCol("region", 16);
  const sep = "-".repeat(header.length);
  const lines = rows.map(
    (r) =>
      fmtCol(r.taskId, 38) +
      fmtCol(r.status, 12) +
      fmtCol(r.title, 34) +
      fmtCol(r.deadline, 26) +
      fmtCol(kindCell(r), 14) +
      fmtCol(r.scheduledFor, 26) +
      fmtCol(r.region, 16),
  );
  // When a ticker (`tidegap tick` or the OpenClaw loop) last ran: tells the user
  // whether scheduled tasks are actually being dispatched.
  const tick = `last tick: ${opts.lastTickAt ?? "never recorded"}`;
  return [header, sep, ...lines, "", tick].join("\n");
}

/**
 * The fields `queue list --json` and the `tidegap ui` list API print per task
 * (no prompt, no result).
 */
export function taskSummary(r: TaskRecord<unknown>): Record<string, unknown> {
  const { provider, model } = taskProviderModel(r);
  return {
    task_id: r.taskId,
    title: r.title ?? null,
    display_title: displayTitle(r) ?? r.taskId,
    status: r.status,
    origin_host: r.originHost ?? null,
    deadline: r.deadline ?? null,
    deadline_kind: r.deadlineKind ?? "absolute",
    quota_provider: r.quotaProvider ?? null,
    scheduled_for: r.scheduledFor ?? null,
    completed_at: r.completedAt ?? null,
    read_at: r.readAt ?? null,
    region: r.region,
    series_id: r.seriesId ?? null,
    repeat: r.repeat ?? "none",
    provider: provider ?? null,
    model: model ?? null,
  };
}

/**
 * Provider and model of a task: what ran (receipt) when it finished, else
 * what the stored body asks for. Closure tasks have neither.
 */
export function taskProviderModel(r: TaskRecord<unknown>): { provider?: string; model?: string } {
  if (r.receipt?.provider || r.receipt?.model) {
    return { provider: r.receipt.provider, model: r.receipt.model };
  }
  if (!r.bodyJson) return {};
  try {
    const spec = JSON.parse(r.bodyJson) as { provider?: unknown; model?: unknown };
    return {
      provider: typeof spec.provider === "string" ? spec.provider : undefined,
      model: typeof spec.model === "string" ? spec.model : undefined,
    };
  } catch {
    return {};
  }
}

function buildFilter(opts: QueueListOptions): TaskListFilter {
  const filter: TaskListFilter = {};
  if (opts.status) {
    if (!VALID_STATUSES.has(opts.status as TaskStatus)) {
      throw new Error(
        `queue list: unknown status ${JSON.stringify(opts.status)}. Valid: ${[...VALID_STATUSES].join(", ")}`,
      );
    }
    filter.status = opts.status as TaskStatus;
  }
  if (opts.kind) {
    if (!VALID_KINDS.has(opts.kind as DeadlineKind)) {
      throw new Error(
        `queue list: unknown kind ${JSON.stringify(opts.kind)}. Valid: ${[...VALID_KINDS].join(", ")}`,
      );
    }
    filter.deadlineKind = opts.kind as DeadlineKind;
  }
  if (opts.unread) filter.unread = true;
  if (opts.series) filter.seriesId = opts.series;
  return filter;
}

/**
 * The Claude Code SessionStart line: `N unread Tidegap task(s), run `tidegap ui``,
 * or "" when nothing is unread. It names no task text, so nothing from a
 * prompt or a model reply reaches the session context.
 */
export function renderHookLine(unreadCount: number): string {
  if (unreadCount <= 0) return "";
  const noun = unreadCount === 1 ? "task" : "tasks";
  return stripControlChars(`${unreadCount} unread Tidegap ${noun}, run \`tidegap ui\` to read them.`);
}

function runQueueHook(opts: QueueListOptions): QueueListResult {
  const dbPath = opts.db ?? defaultDbPath();
  // Do not create a ledger just to report that it is empty.
  if (dbPath !== ":memory:" && !existsSync(dbPath)) return { rows: [], rendered: "" };
  let store: TaskStore | undefined;
  try {
    store = new TaskStore({ dbPath });
    const rows = store.list({ unread: true });
    return { rows, rendered: renderHookLine(rows.length) };
  } catch {
    return { rows: [], rendered: "" };
  } finally {
    try {
      store?.close();
    } catch {
      // ignore
    }
  }
}

export async function runQueueList(
  opts: QueueListOptions = {},
): Promise<QueueListResult> {
  if (opts.hook) return runQueueHook(opts);
  const filter = buildFilter(opts);
  const dbPath = opts.db ?? defaultDbPath();
  const store = new TaskStore({ dbPath });
  try {
    // A series lists its occurrences oldest first (by occurrence number).
    const rows = opts.series ? sortSeries(store.list(filter)) : store.list(filter);
    const lastTickAt = store.getMeta(LAST_TICK_META_KEY);
    const rendered = opts.json
      ? JSON.stringify({ last_tick_at: lastTickAt ?? null, tasks: rows.map(taskSummary) }, null, 2)
      : renderQueue(rows, { lastTickAt });
    return { rows, rendered };
  } finally {
    store.close();
  }
}

export interface QueueShowOptions {
  db?: string;
  /** Include the raw vendor payload (`result.raw`). */
  raw?: boolean;
  json?: boolean;
  /** Default true: viewing a finished task marks it read. */
  markRead?: boolean;
  /** Override the ~/.tidegap/config path (tests). */
  config?: string;
}

export interface QueueShowResult {
  record: TaskRecord<unknown>;
  rendered: string;
}

export function rawPayload(record: TaskRecord<unknown>): unknown {
  const r = record.result as { raw?: unknown } | undefined;
  return r && typeof r === "object" ? r.raw : undefined;
}

/** Render one task in text, the CLI twin of the `tidegap ui` detail view. */
export function renderTask(
  record: TaskRecord<unknown>,
  opts: { raw?: boolean; quota?: QuotaResetConfig; children?: readonly string[] } = {},
): string {
  const lines: string[] = [];
  const kv = (key: string, value: string | number | undefined) => {
    if (value !== undefined && value !== "") lines.push(`${key}: ${safe(String(value))}`);
  };
  kv("task_id", record.taskId);
  kv("title", record.title);
  kv("status", record.status);
  if (record.originHost) {
    kv("origin", `${record.originHost}${record.originCwd ? ` (${record.originCwd})` : ""}`);
  }
  kv("origin_session", record.originSessionId);
  kv("resume", resumeCommand(record));
  kv("parent", record.parentTaskId);
  if (opts.children && opts.children.length > 0) kv("children", opts.children.join(", "));
  if (record.seriesId) {
    kv("series", record.seriesId);
    kv("repeat", record.repeat && record.repeat !== "none" ? record.repeat : "none (series ended)");
  }
  kv("read_at", record.readAt);
  lines.push("");
  kv("enqueued_at", record.enqueuedAt);
  kv("scheduled_for", record.scheduledFor);
  if (record.deadline) {
    kv("deadline", `${record.deadline} (${deadlineKindLabel(record, opts.quota)})`);
  }
  kv("completed_at", record.completedAt);
  kv("region", record.region);

  const prompt = taskPrompt(record);
  if (prompt !== undefined) {
    lines.push("", "Prompt:", safeBlock(prompt));
  }
  // Prior turns only: the current user turn is the prompt and the reply is
  // the result, both printed in their own blocks.
  const history = taskHistory(record);
  const hasReply = record.status === "completed" && taskResultText(record) !== undefined;
  const prior = history.slice(0, Math.max(0, history.length - 1 - (hasReply ? 1 : 0)));
  if (prior.length > 0) {
    lines.push("", "History:");
    for (const turn of prior) lines.push(`[${turn.role}] ${safeBlock(turn.content)}`);
  }
  const text = taskResultText(record);
  if (text !== undefined) {
    lines.push("", "Result:", safeBlock(text));
  } else if (record.result !== undefined && record.status === "completed") {
    lines.push("", "Result:", safeBlock(JSON.stringify(record.result, null, 2)));
  }
  if (record.error) lines.push("", `error: ${safeBlock(record.error)}`);

  const receipt = record.receipt;
  if (receipt) {
    lines.push("", "Receipt:");
    const rk = (key: string, value: string | number | undefined) => {
      if (value !== undefined) lines.push(`  ${key}: ${safe(String(value))}`);
    };
    rk("ran_at", receipt.ranAt);
    if (receipt.provider || receipt.model) {
      rk("model", `${receipt.provider ?? "?"}:${receipt.model ?? "?"}`);
    }
    rk("estimated_carbon_g", receipt.estimatedCarbonGCo2);
    rk("actual_carbon_g", receipt.actualCarbonGCo2);
    rk("intensity_g_co2_per_kwh", receipt.intensityGCo2PerKwh);
    rk(
      "grid_source",
      receipt.gridSource === "mock"
        ? "mock (SYNTHETIC grid data, not a measurement)"
        : receipt.gridSource,
    );
    rk("energy_source", receipt.energySource);
    if (receipt.tools) rk("tools", receipt.tools.length > 0 ? receipt.tools.join(", ") : "none");
    rk("signed", receipt.signature ? "yes" : "no");
  }
  const routing = receipt?.routing ?? record.routingDecision;
  if (routing) {
    lines.push("", "Routing:", `  chosen: ${safe(routing.chosen)}`, `  reasoning: ${safe(routing.reasoning)}`);
  }
  if (opts.raw) {
    const raw = rawPayload(record);
    lines.push("", "Raw payload:", raw === undefined ? "(none)" : safeBlock(JSON.stringify(raw, null, 2)));
  }
  return lines.join("\n");
}

/**
 * `tidegap queue show <id>`: print one task. A completed or failed task is
 * marked read unless `markRead` is false. Throws on an unknown id.
 */
export async function runQueueShow(
  taskId: string,
  opts: QueueShowOptions = {},
): Promise<QueueShowResult> {
  const dbPath = opts.db ?? defaultDbPath();
  const store = new TaskStore({ dbPath });
  try {
    let record = store.get(taskId);
    if (!record) throw new Error(`queue show: no task with id ${JSON.stringify(taskId)}`);
    if (opts.markRead !== false && store.markRead(taskId)) {
      record = store.get(taskId) ?? record;
    }
    const quota = loadQuotaResetConfig(opts.config !== undefined ? { path: opts.config } : {});
    if (opts.json) {
      const { result, ...rest } = record;
      const payload = {
        ...rest,
        result: opts.raw ? result : withoutRaw(result),
        deadline_label: deadlineKindLabel(record, quota),
        history: taskHistory(record),
      };
      return { record, rendered: JSON.stringify(payload, null, 2) };
    }
    const children = store
      .list()
      .filter((t) => t.parentTaskId === record!.taskId)
      .map((t) => t.taskId);
    return { record, rendered: renderTask(record, { raw: opts.raw, quota, children }) };
  } finally {
    store.close();
  }
}

export function withoutRaw(result: unknown): unknown {
  if (!result || typeof result !== "object" || !("raw" in result)) return result;
  const { raw: _raw, ...rest } = result as Record<string, unknown>;
  return rest;
}

/**
 * `tidegap queue unread <id>`: clear a task's read marker so it shows in the
 * inbox again. Throws on an unknown id.
 */
export async function runQueueUnread(
  taskId: string,
  opts: { db?: string } = {},
): Promise<string> {
  const store = new TaskStore({ dbPath: opts.db ?? defaultDbPath() });
  try {
    if (!store.get(taskId)) {
      throw new Error(`queue unread: no task with id ${JSON.stringify(taskId)}`);
    }
    return store.markUnread(taskId)
      ? `${safe(taskId)}: marked unread`
      : `${safe(taskId)}: already unread`;
  } finally {
    store.close();
  }
}

// ── Write commands (ui v2) ──────────────────────────────────────────────────

/** Occurrences of one series in order: the series id first, then `~2`, `~3`… */
export function sortSeries(rows: TaskRecord<unknown>[]): TaskRecord<unknown>[] {
  const n = (r: TaskRecord<unknown>) => {
    const m = /~(\d+)$/.exec(r.taskId);
    return m && r.seriesId && r.taskId.startsWith(`${r.seriesId}~`) ? Number(m[1]) : 1;
  };
  return [...rows].sort((a, b) => n(a) - n(b) || a.enqueuedAt.localeCompare(b.enqueuedAt));
}

export interface QueueWriteOptions {
  db?: string;
  region?: string;
  /** Inject a grid feed (tests); default: the same feed `tidegap tick` builds. */
  feed?: GridFeed;
  now?: () => Date;
}

/**
 * The scheduler every write path uses (`tidegap queue` writes and `tidegap ui`): the
 * ledger, the default grid feed and the quota config, and NO adapters, so a
 * write can never dispatch a provider call. Signing is off for the same
 * reason: no receipt is produced here.
 */
export function actionScheduler(opts: QueueWriteOptions & { dbPath: string }): Scheduler {
  let feed = opts.feed;
  if (!feed) {
    loadEnvFileIntoProcess();
    feed = buildDefaultGridFeed(readEnvCredentials().grid);
  }
  return new Scheduler({
    dbPath: opts.dbPath,
    feed,
    defaultRegion: resolveRegion(undefined, opts.region).region,
    signing: false,
    eager: false,
    quotaConfig: () => loadQuotaResetConfig(),
  });
}

/** `30m`, `2h`, `3d`, `1w` from now, or an ISO-8601 instant. */
export function parseWhen(value: string, now: Date = new Date()): Date {
  const m = /^(\d+)\s*(m|min|h|d|w)$/i.exec(value.trim());
  if (m) {
    const unit = { m: 60_000, min: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[
      m[2]!.toLowerCase() as "m" | "min" | "h" | "d" | "w"
    ];
    return new Date(now.getTime() + Number(m[1]) * unit);
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`not a duration (30m, 2h, 3d, 1w) or an ISO-8601 time: ${JSON.stringify(value)}`);
  }
  return d;
}

/** Bounds of a local calendar day `yyyy-mm-dd`, as instants (23 to 25 h with DST). */
export function localDayBounds(day: string): { dayStart: Date; dayEnd: Date } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim());
  if (!m) throw new Error(`--day must be yyyy-mm-dd, got ${JSON.stringify(day)}`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const dayStart = new Date(y, mo, d, 0, 0, 0, 0);
  const dayEnd = new Date(y, mo, d + 1, 0, 0, 0, 0);
  if (dayStart.getMonth() !== mo || dayStart.getDate() !== d) {
    throw new Error(`--day is not a calendar date: ${JSON.stringify(day)}`);
  }
  return { dayStart, dayEnd };
}

/** The one line after every write: when it runs and whether a ticker is alive. */
function nextTickLine(store: TaskStore): string {
  const last = store.getMeta(LAST_TICK_META_KEY);
  return `runs on the next tick (last tick: ${last ?? "never recorded"})`;
}

function writeResult(scheduler: Scheduler, dbPath: string, record: TaskRecord<unknown>, head: string): string {
  const store = new TaskStore({ dbPath });
  try {
    const fresh = store.get(record.taskId) ?? record;
    const lines = [
      safe(head),
      `status: ${safe(fresh.status)}`,
      ...(fresh.scheduledFor ? [`scheduled_for: ${safe(fresh.scheduledFor)}`] : []),
      ...(fresh.deadline ? [`deadline: ${safe(fresh.deadline)}`] : []),
    ];
    if (fresh.status === "scheduled" || fresh.status === "queued") lines.push(nextTickLine(store));
    return lines.join("\n");
  } finally {
    store.close();
    scheduler.shutdown();
  }
}

/** `tidegap queue cancel <id> [--series]`. Throws (exit 1) on an unknown id. */
export async function runQueueCancel(
  taskId: string,
  opts: QueueWriteOptions & { series?: boolean } = {},
): Promise<string> {
  const dbPath = opts.db ?? defaultDbPath();
  const scheduler = actionScheduler({ ...opts, dbPath });
  let rec: TaskRecord<unknown>;
  try {
    rec = scheduler.cancelTask(taskId, { series: opts.series === true });
  } catch (err) {
    scheduler.shutdown();
    throw err;
  }
  const ended = opts.series && rec.seriesId ? ` (series ${rec.seriesId} ended)` : "";
  return writeResult(scheduler, dbPath, rec, `${taskId}: ${rec.status}${ended}`);
}

/** `tidegap queue run-now <id>`. Throws (exit 1) when the task cannot run now. */
export async function runQueueRunNow(taskId: string, opts: QueueWriteOptions = {}): Promise<string> {
  const dbPath = opts.db ?? defaultDbPath();
  const scheduler = actionScheduler({ ...opts, dbPath });
  let rec: TaskRecord<unknown>;
  try {
    rec = scheduler.runNow(taskId);
  } catch (err) {
    scheduler.shutdown();
    throw err;
  }
  return writeResult(scheduler, dbPath, rec, `${taskId}: marked to run now`);
}

/**
 * `tidegap queue reschedule <id> (--by <when> | --at <iso> | --day <yyyy-mm-dd> | --after-limit-reset)`.
 * Exactly one target. `--day` uses this machine's time zone for the bounds.
 * `--after-limit-reset` sets the earliest start to the Claude limit reset
 * (KTD5); with no limit state it refuses with the cause.
 */
export async function runQueueReschedule(
  taskId: string,
  opts: QueueWriteOptions & {
    by?: string;
    at?: string;
    day?: string;
    afterLimitReset?: boolean;
    /** Usage read overrides (tests). */
    usage?: HostLimitsOptions;
  } = {},
): Promise<string> {
  const given = [opts.by, opts.at, opts.day, opts.afterLimitReset || undefined].filter((v) => v !== undefined);
  if (given.length !== 1) {
    throw new Error("queue reschedule: pass exactly one of --by, --at, --day or --after-limit-reset");
  }
  const now = opts.now?.() ?? new Date();
  let target: RescheduleTarget;
  let done = `${taskId}: rescheduled`;
  if (opts.afterLimitReset) {
    const res = await hostResetTarget({ env: readUsageEnv(), ...opts.usage, now });
    if (!res.ok) throw new Error(`queue reschedule: ${res.reason}`);
    target = { notBefore: res.target.at };
    done = `${taskId}: rescheduled after the ${windowLabel(res.target.window)} limit reset (${clockLabel(res.target.at, now)})`;
  } else if (opts.by !== undefined) target = { deadline: parseWhen(opts.by, now) };
  else if (opts.at !== undefined) target = { at: parseWhen(opts.at, now) };
  else target = localDayBounds(opts.day!);
  const dbPath = opts.db ?? defaultDbPath();
  const scheduler = actionScheduler({ ...opts, dbPath });
  let rec: TaskRecord<unknown>;
  try {
    rec = await scheduler.rescheduleTask(taskId, target);
  } catch (err) {
    scheduler.shutdown();
    throw err;
  }
  return writeResult(scheduler, dbPath, rec, done);
}

/** `tidegap queue reply <id> <text> [--by <when>]`: a child task with the history. */
export async function runQueueReply(
  taskId: string,
  text: string,
  opts: QueueWriteOptions & { by?: string } = {},
): Promise<string> {
  if (text.length === 0 || text.length > 32_000) {
    throw new Error("queue reply: text must be 1 to 32000 characters");
  }
  const now = opts.now?.() ?? new Date();
  const dbPath = opts.db ?? defaultDbPath();
  const scheduler = actionScheduler({ ...opts, dbPath });
  let child: TaskRecord<unknown>;
  try {
    child = await scheduler.replyToTask(taskId, text, {
      ...(opts.by !== undefined ? { deadline: parseWhen(opts.by, now) } : {}),
    });
  } catch (err) {
    scheduler.shutdown();
    throw err;
  }
  return writeResult(scheduler, dbPath, child, `reply queued as ${child.taskId} (parent ${taskId})`);
}
