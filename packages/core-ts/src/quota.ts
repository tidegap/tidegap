/**
 * Quota-reset deadlines (v0.17).
 *
 * A subscription quota (Claude, Codex) resets weekly at a fixed local time.
 * A task with deadline kind `quota_reset` must run before that reset, minus
 * a safety margin. The HOST resolves the concrete deadline at enqueue
 * ({@link resolveQuotaDeadline}); tickers call {@link prepareTick} before
 * `Scheduler.tick`, which re-resolves tasks whose reset has already passed
 * (machine asleep, daemon down) through the existing
 * `Scheduler.rescheduleIfPending` path. The window picker itself is unchanged.
 *
 * Config lives in `~/.tidegap/config` (KEY=VALUE, same file as the carbon
 * budget):
 *
 *   TIDEGAP_QUOTA_RESET_CLAUDE=mon 10:00 Europe/Berlin
 *   TIDEGAP_QUOTA_MARGIN_H_CLAUDE=2
 *
 * The label after the prefix is free-form (lowercased on read). The time
 * zone is optional (system zone by default); the margin defaults to 2 hours
 * and must be between 0 and 168. A malformed entry disables that label and
 * never throws. File I/O only; no environment reads.
 */

import { existsSync, readFileSync } from "node:fs";
import { carbonBudgetConfigPath, parseKeyValues } from "./budget.js";
import { sweepJobs } from "./jobs.js";
import type { Scheduler } from "./scheduler.js";

const RESET_PREFIX = "TIDEGAP_QUOTA_RESET_";
const MARGIN_PREFIX = "TIDEGAP_QUOTA_MARGIN_H_";
export const DEFAULT_QUOTA_MARGIN_H = 2;
const MAX_MARGIN_H = 168;
const HOUR_MS = 3_600_000;

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const WEEKDAY_NAMES = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

/** One provider label's weekly reset. `weekday` is 0 = Sunday … 6 = Saturday. */
export interface QuotaResetSchedule {
  label: string;
  weekday: number;
  hour: number;
  minute: number;
  /** IANA time zone the reset time is expressed in. */
  timeZone: string;
  /** Hours before the reset by which the task must have run. */
  marginH: number;
}

/** Configured schedules by lowercase label. */
export type QuotaResetConfig = Record<string, QuotaResetSchedule>;

export interface LoadQuotaResetOptions {
  /** Config file path. Defaults to `~/.tidegap/config`. */
  path?: string;
  /** Zone used when an entry names none. Defaults to the system zone. */
  defaultTimeZone?: string;
}

/** True when `tz` is an IANA zone this runtime knows. */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** `mon` or `monday` (any case) to 1; anything else to undefined. */
function parseWeekday(raw: string): number | undefined {
  const v = raw.toLowerCase();
  const short = (WEEKDAYS as readonly string[]).indexOf(v);
  if (short >= 0) return short;
  const full = (WEEKDAY_NAMES as readonly string[]).indexOf(v);
  return full >= 0 ? full : undefined;
}

/**
 * Parse one `TIDEGAP_QUOTA_RESET_<LABEL>` value. Returns undefined when it is
 * malformed (unknown weekday, bad time, unknown zone).
 */
export function parseQuotaResetValue(
  label: string,
  value: string,
  marginH: number,
  defaultTimeZone: string,
): QuotaResetSchedule | undefined {
  const parts = value.trim().split(/\s+/);
  if (parts.length < 2 || parts.length > 3) return undefined;
  const weekday = parseWeekday(parts[0]!);
  const m = /^(\d{1,2}):(\d{2})$/.exec(parts[1]!);
  if (weekday === undefined || !m) return undefined;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return undefined;
  const timeZone = parts[2] ?? defaultTimeZone;
  if (!isValidTimeZone(timeZone)) return undefined;
  return { label, weekday, hour, minute, timeZone, marginH };
}

/** Parse quota schedules out of already-read KEY=VALUE pairs. */
export function quotaResetConfigFromValues(
  values: Record<string, string>,
  defaultTimeZone: string = Intl.DateTimeFormat().resolvedOptions().timeZone,
): QuotaResetConfig {
  const out: QuotaResetConfig = {};
  for (const [key, value] of Object.entries(values)) {
    if (!key.startsWith(RESET_PREFIX)) continue;
    const suffix = key.slice(RESET_PREFIX.length);
    if (!/^[A-Za-z0-9_]+$/.test(suffix)) continue;
    const label = suffix.toLowerCase();
    let marginH = DEFAULT_QUOTA_MARGIN_H;
    const rawMargin = values[`${MARGIN_PREFIX}${suffix}`];
    if (rawMargin !== undefined && rawMargin.trim() !== "") {
      marginH = Number(rawMargin);
      if (!Number.isFinite(marginH) || marginH < 0 || marginH > MAX_MARGIN_H) continue;
    }
    const schedule = parseQuotaResetValue(label, value, marginH, defaultTimeZone);
    if (schedule) out[label] = schedule;
  }
  return out;
}

/**
 * Read quota-reset schedules from `~/.tidegap/config` (or `opts.path`).
 * Missing or unreadable file means no labels; never throws.
 */
export function loadQuotaResetConfig(opts: LoadQuotaResetOptions = {}): QuotaResetConfig {
  const path = opts.path ?? carbonBudgetConfigPath();
  let values: Record<string, string> = {};
  if (existsSync(path)) {
    try {
      values = parseKeyValues(readFileSync(path, "utf8"));
    } catch {
      values = {};
    }
  }
  return quotaResetConfigFromValues(values, opts.defaultTimeZone);
}

/** One formatter per zone: building an Intl.DateTimeFormat is the slow part. */
const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

/** Offset of `timeZone` from UTC at `instantMs`, in ms (local - UTC). */
export function zoneOffsetMs(instantMs: number, timeZone: string): number {
  let fmt = zoneFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    zoneFormatters.set(timeZone, fmt);
  }
  const parts = fmt.formatToParts(new Date(instantMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

/** The UTC instant of local wall time y-m-d h:mi in `timeZone`. */
function zonedToUtcMs(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  timeZone: string,
): number {
  const wall = Date.UTC(y, mo, d, h, mi);
  let guess = wall - zoneOffsetMs(wall, timeZone);
  // A second pass settles instants next to a DST change.
  guess = wall - zoneOffsetMs(guess, timeZone);
  return guess;
}

/** Reset instants (ms) on matching weekdays from about a week before to two weeks after `now`. */
function resetInstantsAround(schedule: QuotaResetSchedule, now: Date): number[] {
  const localNow = now.getTime() + zoneOffsetMs(now.getTime(), schedule.timeZone);
  const today = new Date(localNow);
  const y = today.getUTCFullYear();
  const mo = today.getUTCMonth();
  const d = today.getUTCDate();
  const out: number[] = [];
  for (let k = -8; k <= 15; k++) {
    const date = new Date(Date.UTC(y, mo, d + k));
    if (date.getUTCDay() !== schedule.weekday) continue;
    out.push(
      zonedToUtcMs(
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate(),
        schedule.hour,
        schedule.minute,
        schedule.timeZone,
      ),
    );
  }
  return out.sort((a, b) => a - b);
}

/** The most recent reset at or before `now`. */
export function previousQuotaReset(schedule: QuotaResetSchedule, now: Date): Date {
  const instants = resetInstantsAround(schedule, now).filter((t) => t <= now.getTime());
  return new Date(instants[instants.length - 1]!);
}

/** The first reset strictly after `now`. */
export function nextQuotaReset(schedule: QuotaResetSchedule, now: Date): Date {
  return new Date(resetInstantsAround(schedule, now).find((t) => t > now.getTime())!);
}

/**
 * Resolve a quota deadline: the next reset minus the margin. When that
 * instant is not after `now`, the following week's reset is used.
 */
export function resolveQuotaDeadline(
  schedule: QuotaResetSchedule,
  now: Date,
): { deadline: Date; resetAt: Date } {
  const marginMs = schedule.marginH * HOUR_MS;
  const resetMs = resetInstantsAround(schedule, now).find(
    (t) => t - marginMs > now.getTime(),
  )!;
  return { deadline: new Date(resetMs - marginMs), resetAt: new Date(resetMs) };
}

export type ResolveQuotaProviderResult =
  | { ok: true; schedule: QuotaResetSchedule }
  | { ok: false; error: string };

/**
 * Pick the schedule for a requested label, or the only configured label
 * when none is requested. Errors name the configured labels.
 */
export function resolveQuotaProvider(
  config: QuotaResetConfig,
  requested?: string,
): ResolveQuotaProviderResult {
  const labels = Object.keys(config).sort();
  const hint =
    "add TIDEGAP_QUOTA_RESET_<LABEL>=<weekday> <HH:MM> [<IANA zone>] to ~/.tidegap/config";
  if (requested !== undefined && requested.trim() !== "") {
    const schedule = config[requested.trim().toLowerCase()];
    if (schedule) return { ok: true, schedule };
    return {
      ok: false,
      error:
        labels.length === 0
          ? `quota provider "${requested}" is not configured; ${hint}`
          : `quota provider "${requested}" is not configured; configured: ${labels.join(", ")}`,
    };
  }
  if (labels.length === 1) return { ok: true, schedule: config[labels[0]!]! };
  if (labels.length === 0) {
    return { ok: false, error: `no quota reset is configured; ${hint}` };
  }
  return {
    ok: false,
    error: `several quota providers are configured (${labels.join(", ")}); pass quota_provider`,
  };
}

/**
 * Re-resolve `queued` / `scheduled` quota tasks whose reset has passed: the
 * most recent reset for the task's label is later than its stored deadline.
 * The condition ignores the margin, so a margin edit after enqueue cannot
 * misfire. Each such task gets the next reset minus margin through
 * `Scheduler.rescheduleIfPending`, which re-runs window selection and writes
 * only while the row is still queued/scheduled. Tasks whose
 * label is no longer configured are left as they are. Never throws; returns
 * one message per rescheduled task, per missing label and per failure.
 */
export async function sweepQuotaDeadlines(
  scheduler: Scheduler,
  config: QuotaResetConfig,
  now: Date = new Date(),
): Promise<string[]> {
  const messages: string[] = [];
  let tasks;
  try {
    tasks = scheduler
      .listPersistedTasks()
      .filter(
        (t) =>
          t.deadlineKind === "quota_reset" &&
          (t.status === "queued" || t.status === "scheduled"),
      );
  } catch (err) {
    return [`quota sweep: cannot read the ledger: ${errMessage(err)}`];
  }
  const missing = new Map<string, number>();
  for (const task of tasks) {
    const label = task.quotaProvider ?? "";
    const schedule = config[label];
    if (!schedule) {
      missing.set(label, (missing.get(label) ?? 0) + 1);
      continue;
    }
    const stored = task.deadline ? Date.parse(task.deadline) : Number.NaN;
    // Strictly before: with margin 0 the stored deadline IS the reset, and
    // once that reset has passed the task must be re-resolved.
    if (Number.isFinite(stored) && previousQuotaReset(schedule, now).getTime() < stored) {
      continue;
    }
    const { deadline } = resolveQuotaDeadline(schedule, now);
    try {
      // Conditional write: a concurrent ticker may have claimed the task
      // since the read above; then nothing is written and it is skipped.
      if (!(await scheduler.rescheduleIfPending(task.taskId, deadline))) continue;
      messages.push(
        `quota reset (${label}) passed for ${task.taskId}; new deadline ${deadline.toISOString()}`,
      );
    } catch (err) {
      messages.push(`quota sweep: could not reschedule ${task.taskId}: ${errMessage(err)}`);
    }
  }
  for (const [label, count] of missing) {
    messages.push(
      `quota provider "${label}" is not configured; ${count} quota task(s) left unchanged`,
    );
  }
  return messages;
}

/** Forecast horizon the scheduler plans inside, in hours. */
const REPLAN_HORIZON_H = 72;
/** Forecast span a pinned window needs before it is planned (24 h). */
const PLAN_COVER_MS = 24 * 3_600_000;

/**
 * Give unplanned `scheduled` rows a carbon window once the forecast reaches
 * them (ui v2). A row is unplanned when it has a `notBefore` (a day target
 * or a series successor), no estimate yet, and is not pinned to an exact
 * time (`scheduledFor === notBefore`). Each one inside the horizon goes
 * through `Scheduler.rescheduleIfPending` (compare-and-set). Never throws;
 * returns one message per re-planned row and per failure.
 */
export async function replanSweep(
  scheduler: Scheduler,
  now: Date = new Date(),
): Promise<string[]> {
  const messages: string[] = [];
  let rows;
  try {
    rows = scheduler.listPersistedTasks().filter(
      (t) =>
        t.status === "scheduled" &&
        t.bodyJson !== undefined &&
        t.notBefore !== undefined &&
        t.estimatedCarbonGCo2 === undefined &&
        t.scheduledFor !== t.notBefore &&
        t.deadline !== undefined,
    );
  } catch (err) {
    return [`replan sweep: cannot read the ledger: ${errMessage(err)}`];
  }
  const horizonEnd = now.getTime() + REPLAN_HORIZON_H * 3_600_000;
  for (const task of rows) {
    // Plan only once the forecast covers the window's first day (or the
    // whole window when it is shorter): a day target whose first hour just
    // entered the horizon would otherwise be planned on that hour alone.
    const start = Math.max(Date.parse(task.notBefore!), now.getTime());
    const needEnd = Math.min(Date.parse(task.deadline!), start + PLAN_COVER_MS);
    if (needEnd > horizonEnd) continue;
    try {
      if (!(await scheduler.rescheduleIfPending(task.taskId, new Date(task.deadline!)))) continue;
      const fresh = scheduler.getTask(task.taskId);
      if (fresh?.estimatedCarbonGCo2 !== undefined) {
        messages.push(`planned ${task.taskId} for ${fresh.scheduledFor}`);
      }
    } catch (err) {
      messages.push(`replan sweep: could not plan ${task.taskId}: ${errMessage(err)}`);
    }
  }
  return messages;
}

/**
 * The shared pre-tick step every ticker runs before `Scheduler.tick`
 * (`tidegap tick` and the OpenClaw interval loop): record `last_tick_at` in the
 * ledger, run the job sweep (record finished occurrences, keep one live
 * occurrence per active job), sweep passed quota deadlines, then re-plan
 * unplanned rows the forecast now reaches (`replanSweep`, which plans new
 * job occurrences too). Never throws.
 */
export async function prepareTick(
  scheduler: Scheduler,
  opts: { quotaConfig: QuotaResetConfig; now?: Date },
): Promise<string[]> {
  const now = opts.now ?? new Date();
  const messages: string[] = [];
  try {
    scheduler.recordTickRun(now);
  } catch (err) {
    messages.push(`could not record last_tick_at: ${errMessage(err)}`);
  }
  try {
    messages.push(...(await sweepJobs(scheduler, now)).messages);
  } catch (err) {
    messages.push(`job sweep failed: ${errMessage(err)}`);
  }
  messages.push(...(await sweepQuotaDeadlines(scheduler, opts.quotaConfig, now)));
  messages.push(...(await replanSweep(scheduler, now)));
  return messages;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
