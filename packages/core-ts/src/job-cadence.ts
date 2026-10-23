/**
 * Cadence, window and anchor math of floating recurring jobs (KTD5).
 *
 * Pure functions, no I/O. A job runs once per period, at the cleanest hour
 * inside `[earliest, deadline]` of its next occurrence:
 *
 *   - Run-anchored (`daily` or `every N hours`, no window): the next run is
 *     due one period after the last run started, never sooner than half a
 *     period after it. With no last run (a new or resumed job) it is due one
 *     period from now. A deadline that is not after now falls back to the
 *     no-last-run rule, so an overdue job never gets a past deadline.
 *   - Calendar-anchored (any window, `weekdays`, `weekly`): slots are local
 *     wall-clock windows in the job's IANA zone on allowed days; no window
 *     means the whole local day. The next slot is the first one that starts
 *     after the last run and ends after now.
 *
 * DST: a local time that does not exist (spring forward) moves forward to
 * the next valid minute; a repeated local time (fall back) uses its first
 * instant. A slot that DST collapses keeps its nominal length.
 *
 * Catch-up (R6) needs no extra rule: a job keeps one live occurrence, an
 * overdue one is simply due on the next tick, and its successor is computed
 * from that run's start.
 */

import { isValidTimeZone, zoneOffsetMs } from "./quota.js";
import type { JobCadence, JobWindow, Occurrence, Weekday } from "./types.js";

/** A schedule input the user gave that breaks a rule; the message names the rule. */
export class JobScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobScheduleError";
  }
}

/** The part of a job that decides when it runs. */
export interface JobSchedule {
  cadence: JobCadence;
  window?: JobWindow;
  /** IANA zone. */
  timeZone: string;
}

/** Inputs of {@link nextOccurrence}; instants as ISO strings, Dates or epoch ms. */
export interface NextOccurrenceInput {
  now: Date | string | number;
  /** Start of the job's last run, if it ever ran (ignored on resume). */
  lastRunStart?: Date | string | number;
  /**
   * Deadline of an occurrence the user skipped. The successor is anchored
   * on it: a calendar job takes the first slot starting at or after it, a
   * run-anchored job counts from it.
   */
  skippedDeadline?: Date | string | number;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Index = `Date.getUTCDay()`. */
const WEEKDAY_BY_INDEX: readonly Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
/** Display and storage order. */
const WEEKDAY_ORDER: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const WEEKDAY_NAMES: Record<string, Weekday> = {
  monday: "mon",
  tuesday: "tue",
  wednesday: "wed",
  thursday: "thu",
  friday: "fri",
  saturday: "sat",
  sunday: "sun",
};
const WORK_DAYS: ReadonlySet<Weekday> = new Set(["mon", "tue", "wed", "thu", "fri"]);

export const MIN_EVERY_HOURS = 2;
export const MAX_EVERY_HOURS = 168;

const HHMM = /^(\d{1,2}):(\d{2})$/;

/** `HH:MM` to minutes after midnight, or undefined when malformed. */
function minutesOf(hhmm: string): number | undefined {
  const m = HHMM.exec(hhmm.trim());
  if (!m) return undefined;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return undefined;
  return h * 60 + mi;
}

function hhmm(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** One weekday name (`mon` or `monday`, any case). */
function parseWeekday(raw: string): Weekday {
  const v = raw.trim().toLowerCase();
  if ((WEEKDAY_ORDER as readonly string[]).includes(v)) return v as Weekday;
  const full = WEEKDAY_NAMES[v];
  if (full) return full;
  throw new JobScheduleError(`unknown day "${raw.trim()}"; use mon, tue, wed, thu, fri, sat or sun`);
}

/**
 * Parse a window `HH:MM-HH:MM` in local time. An end at or before the start
 * crosses midnight; an end equal to the start is refused.
 */
export function parseWindow(text: string): JobWindow {
  const parts = text.split("-");
  const start = parts.length === 2 ? minutesOf(parts[0]!) : undefined;
  const end = parts.length === 2 ? minutesOf(parts[1]!) : undefined;
  if (start === undefined || end === undefined) {
    throw new JobScheduleError(`window "${text}" must look like HH:MM-HH:MM, for example 00:00-08:00`);
  }
  if (start === end) throw new JobScheduleError("window start and end must differ");
  return { start: hhmm(start), end: hhmm(end) };
}

/**
 * Parse a cadence: `daily`, `weekdays`, `weekly:<days>` (or `weekly <days>`,
 * days comma-separated) or `every <N>h` (also `every <N> hours`).
 */
export function parseCadence(text: string): JobCadence {
  const v = text.trim().toLowerCase();
  if (v === "daily") return { kind: "daily" };
  if (v === "weekdays") return { kind: "weekdays" };
  const weekly = /^weekly(?:[:\s](.*))?$/.exec(v);
  if (weekly) {
    const days = (weekly[1] ?? "").split(",").filter((d) => d.trim() !== "").map(parseWeekday);
    return { kind: "weekly", days };
  }
  const every = /^every[:\s]\s*(\d+)\s*(?:h|hours?)$/.exec(v);
  if (every) return { kind: "hours", every: Number(every[1]) };
  throw new JobScheduleError(`unknown cadence "${text.trim()}"; use daily, weekdays, weekly:mon,thu or every 6h`);
}

/**
 * Check a schedule against the rules and return it normalized (weekly days
 * deduplicated, Monday first). Throws {@link JobScheduleError} naming the
 * broken rule.
 */
export function validateJobSchedule(schedule: JobSchedule): JobSchedule {
  if (typeof schedule.timeZone !== "string" || !isValidTimeZone(schedule.timeZone)) {
    throw new JobScheduleError(`unknown time zone "${String(schedule.timeZone)}"; use an IANA name such as Europe/Berlin`);
  }
  const c = schedule.cadence;
  let cadence: JobCadence;
  switch (c?.kind) {
    case "daily":
    case "weekdays":
      cadence = { kind: c.kind };
      break;
    case "weekly": {
      const days = new Set((Array.isArray(c.days) ? c.days : []).map((d) => parseWeekday(String(d))));
      if (days.size === 0) throw new JobScheduleError("weekly: pick at least one day");
      cadence = { kind: "weekly", days: WEEKDAY_ORDER.filter((d) => days.has(d)) };
      break;
    }
    case "hours":
      if (!Number.isInteger(c.every) || c.every < MIN_EVERY_HOURS || c.every > MAX_EVERY_HOURS) {
        throw new JobScheduleError(`every N hours needs a whole N from ${MIN_EVERY_HOURS} to ${MAX_EVERY_HOURS}`);
      }
      cadence = { kind: "hours", every: c.every };
      break;
    default:
      throw new JobScheduleError(`unknown cadence ${JSON.stringify((c as { kind?: unknown } | undefined)?.kind)}`);
  }
  if (!schedule.window) return { cadence, timeZone: schedule.timeZone };
  if (cadence.kind === "hours") {
    throw new JobScheduleError("a window works only with daily, weekdays or weekly; every N hours counts from the last run");
  }
  return { cadence, window: parseWindow(`${schedule.window.start}-${schedule.window.end}`), timeZone: schedule.timeZone };
}

/** True when the schedule runs in calendar slots rather than from the last run. */
export function isCalendarAnchored(schedule: JobSchedule): boolean {
  return schedule.window !== undefined || schedule.cadence.kind === "weekdays" || schedule.cadence.kind === "weekly";
}

/** The run-anchored period in ms (`daily` = 24 h). */
function periodMs(cadence: JobCadence): number {
  return cadence.kind === "hours" ? cadence.every * HOUR_MS : DAY_MS;
}

function toMs(v: Date | string | number): number {
  const ms = typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : v.getTime();
  if (!Number.isFinite(ms)) throw new JobScheduleError(`invalid instant ${JSON.stringify(v)}`);
  return ms;
}

/** Local wall time of an instant in `tz`, as epoch ms of that wall time read as UTC. */
function localTime(ms: number, tz: string): number {
  return ms + zoneOffsetMs(ms, tz);
}

/**
 * The UTC instant of local wall time y-mo-d h:mi in `tz` (month 0-based;
 * day overflow rolls over). A repeated local time gives its first instant;
 * a local time inside a DST gap gives the first instant after the gap.
 */
export function localToUtcMs(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const wall = Date.UTC(y, mo, d, h, mi);
  const offsets = new Set([zoneOffsetMs(wall - DAY_MS, tz), zoneOffsetMs(wall, tz), zoneOffsetMs(wall + DAY_MS, tz)]);
  const exact = [...offsets].map((o) => wall - o).filter((t) => localTime(t, tz) === wall);
  if (exact.length > 0) return Math.min(...exact);
  // Inside a gap: local time jumps past `wall`. Find the first minute whose
  // local time is after it (the transition instant).
  let lo = wall - Math.max(...offsets);
  let hi = wall - Math.min(...offsets);
  while (hi - lo > MINUTE_MS) {
    const mid = lo + Math.floor((hi - lo) / 2 / MINUTE_MS) * MINUTE_MS;
    if (localTime(mid, tz) > wall) hi = mid;
    else lo = mid;
  }
  return hi;
}

interface Slot {
  start: number;
  end: number;
}

/** The slot that starts on local date y-mo-d, or undefined on a day the cadence skips. */
function slotOn(y: number, mo: number, d: number, schedule: JobSchedule): Slot | undefined {
  const weekday = WEEKDAY_BY_INDEX[new Date(Date.UTC(y, mo, d)).getUTCDay()]!;
  const c = schedule.cadence;
  if (c.kind === "weekdays" && !WORK_DAYS.has(weekday)) return undefined;
  if (c.kind === "weekly" && !c.days.includes(weekday)) return undefined;
  const tz = schedule.timeZone;
  if (!schedule.window) {
    return { start: localToUtcMs(y, mo, d, 0, 0, tz), end: localToUtcMs(y, mo, d + 1, 0, 0, tz) };
  }
  const startMin = minutesOf(schedule.window.start)!;
  const endMin = minutesOf(schedule.window.end)!;
  const crosses = endMin <= startMin;
  const start = localToUtcMs(y, mo, d, Math.floor(startMin / 60), startMin % 60, tz);
  let end = localToUtcMs(y, mo, d + (crosses ? 1 : 0), Math.floor(endMin / 60), endMin % 60, tz);
  // A DST gap can swallow the slot (02:00-03:00 on a spring-forward day):
  // keep its nominal length from the moved start.
  if (end <= start) end = start + ((endMin - startMin + 24 * 60) % (24 * 60)) * MINUTE_MS;
  return { start, end };
}

/**
 * The next occurrence of a job. Throws {@link JobScheduleError} on a
 * schedule that breaks a rule (see {@link validateJobSchedule}).
 */
export function nextOccurrence(schedule: JobSchedule, input: NextOccurrenceInput): Occurrence {
  const s = validateJobSchedule(schedule);
  const now = toMs(input.now);
  const lastRun = input.lastRunStart !== undefined ? toMs(input.lastRunStart) : undefined;
  const skipped = input.skippedDeadline !== undefined ? toMs(input.skippedDeadline) : undefined;
  const iso = (ms: number) => new Date(ms).toISOString();

  if (!isCalendarAnchored(s)) {
    const period = periodMs(s.cadence);
    const base = skipped ?? lastRun;
    if (base !== undefined && base + period > now) {
      return { earliest: iso(Math.max(base + period / 2, now)), deadline: iso(base + period), anchor: "run" };
    }
    return { earliest: iso(now), deadline: iso(now + period), anchor: "run" };
  }

  // A slot that ends after now starts at most one local day before now, so
  // the search starts on yesterday's local date.
  const local = new Date(localTime(now, s.timeZone));
  const [y, mo, d] = [local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()];
  const after = Math.max(now, skipped ?? now);
  const days = Math.ceil((after - now) / DAY_MS) + 16;
  for (let k = -1; k <= days; k++) {
    const slot = slotOn(y, mo, d + k, s);
    if (!slot || slot.end <= now) continue;
    if (lastRun !== undefined && slot.start <= lastRun) continue;
    if (skipped !== undefined && slot.start < skipped) continue;
    return { earliest: iso(Math.max(slot.start, now)), deadline: iso(slot.end), anchor: "calendar" };
  }
  // Unreachable for a validated schedule: every cadence has a slot each week.
  throw new JobScheduleError("no slot found in the next two weeks");
}

function dayList(days: readonly Weekday[]): string {
  const names = days.map((d) => d[0]!.toUpperCase() + d.slice(1));
  return names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The guarantee a schedule gives, as one sentence (R4). */
export function guaranteeText(schedule: JobSchedule): string {
  const s = validateJobSchedule(schedule);
  if (!isCalendarAnchored(s)) {
    const h = periodMs(s.cadence) / HOUR_MS;
    return `runs at least every ${h} h, never sooner than ${h / 2} h after the last run`;
  }
  const c = s.cadence;
  const days =
    c.kind === "weekly" ? `every ${dayList(c.days)}` : c.kind === "weekdays" ? "every weekday (Mon-Fri)" : "every day";
  return s.window ? `runs ${days} between ${s.window.start} and ${s.window.end}` : `runs once ${days}, any time of day`;
}
