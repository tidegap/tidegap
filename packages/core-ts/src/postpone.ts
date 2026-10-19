/**
 * "Later" (coherence KTD4 to KTD6): move a pending task so it never runs
 * earlier than its current planned start. One preset vocabulary for every
 * surface (KTD15), resolved in the process's local time zone. Pure apart
 * from the limit-reset hint, which the helpers read and write through the
 * store's meta table.
 *
 * `Scheduler.postponeTask` turns a resolved target into a reschedule: delay
 * presets and `after_limit_reset` become `{notBefore}` (the scheduler's
 * `startFields` rule: the deadline rises to at least `notBefore + 2 h` and
 * a later one is kept), day presets become `{dayStart, dayEnd}` (the
 * deadline is the window end), and a pin becomes `{at}`.
 */

import { taskActions } from "./history.js";
import type { RescheduleTarget } from "./scheduler.js";
import type { ProviderCallSpec, TaskRecord } from "./types.js";

/** Preset ids every surface maps to (KTD15). */
export type PostponePreset = "1h" | "tonight" | "tomorrow_morning" | "after_limit_reset";

/** Presets in display order. */
export const POSTPONE_PRESETS: readonly PostponePreset[] = ["1h", "tonight", "tomorrow_morning", "after_limit_reset"];

/** Display labels of the presets (KTD15). */
export const POSTPONE_LABELS: Readonly<Record<PostponePreset, string>> = {
  "1h": "One hour later",
  tonight: "Tonight",
  tomorrow_morning: "Tomorrow morning",
  after_limit_reset: "After limit reset",
};

/** Target of {@link Scheduler.postponeTask}: a preset, a delay or an exact pin. */
export type PostponeTarget =
  /** `resetAt` applies to `after_limit_reset` only and wins over every other reset source. */
  | { preset: PostponePreset; resetAt?: string | Date }
  /** Not before the planned start plus `delayMs` (the CLI's `+<dur>`). */
  | { delayMs: number }
  /** An exact time (a picked time). */
  | { until: string | Date };

/** A known limit reset and where it came from (`caller`, `hint`, or the source's own name). */
export interface LimitReset {
  at: Date;
  source: string;
}

/**
 * The plugged-in reset source (KTD5), for example the CLI usage module's
 * Claude limit reset. Returns null when it knows no reset for `task`.
 */
export type LimitResetSource = (
  task: TaskRecord<unknown>,
  now: Date,
) => LimitReset | null | Promise<LimitReset | null>;

/** One entry of {@link postponeOptions}; `not_before` is ISO-8601, null when unavailable. */
export interface PostponeOption {
  preset: PostponePreset;
  label: string;
  not_before: string | null;
  available: boolean;
  reason?: string;
}

/** Ledger meta key of the last reset time a caller gave (`{at, provider}`). */
export const LIMIT_RESET_HINT_META_KEY = "limit_reset_hint";

/** The meta part of a `TaskStore` the hint helpers need. */
export interface MetaStore {
  getMeta(key: string): string | undefined;
  setMeta(key: string, value: string): void;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
/** `after_limit_reset` waits this long past the reset. */
const RESET_MARGIN_MS = 5 * MINUTE_MS;
/** Local hour the `tonight` preset starts; also the start of a channel's quiet hours (KTD10). */
export const TONIGHT_START_H = 22;
const TONIGHT_END_H = 6;
/** Local hour the `tomorrow_morning` preset starts; also the end of a channel's quiet hours (KTD10). */
export const MORNING_START_H = 9;
const MORNING_END_H = 12;

export const NEEDS_RESET_TIME = "needs the reset time";

/** The stored hint, when it is still in the future. */
export function readLimitResetHint(store: MetaStore | undefined, now: Date): LimitReset | null {
  const raw = store?.getMeta(LIMIT_RESET_HINT_META_KEY);
  if (!raw) return null;
  try {
    const at = new Date((JSON.parse(raw) as { at?: string }).at ?? "");
    return at.getTime() > now.getTime() ? { at, source: "hint" } : null;
  } catch {
    return null;
  }
}

/** Store a caller-given reset as the hint for later tasks. */
export function writeLimitResetHint(store: MetaStore | undefined, at: Date, provider: string | undefined): void {
  store?.setMeta(LIMIT_RESET_HINT_META_KEY, JSON.stringify({ at: at.toISOString(), ...(provider ? { provider } : {}) }));
}

/**
 * The reset `after_limit_reset` waits for (R14): the plugged-in source,
 * else a still-future stored hint. A caller-given `reset_at` is handled by
 * the caller before this, because it wins over both.
 */
export async function resolveLimitReset(
  record: TaskRecord<unknown>,
  now: Date,
  source: LimitResetSource | undefined,
  store: MetaStore | undefined,
): Promise<LimitReset | null> {
  const plugged = source ? await source(record, now) : null;
  return plugged ?? readLimitResetHint(store, now);
}

/** The provider of a provider-call task, if the body parses. */
export function taskProvider(record: TaskRecord<unknown>): string | undefined {
  try {
    return (JSON.parse(record.bodyJson ?? "") as Partial<ProviderCallSpec>).provider;
  } catch {
    return undefined;
  }
}

/**
 * The planned start (KTD4): `scheduledFor` if in the future, else a future
 * `notBefore`, else now. `future` is false for "now", where any target at
 * or after now is later.
 */
export function plannedStart(record: TaskRecord<unknown>, now: Date): { at: Date; future: boolean } {
  for (const iso of [record.scheduledFor, record.notBefore]) {
    const t = iso ? Date.parse(iso) : Number.NaN;
    if (Number.isFinite(t) && t > now.getTime()) return { at: new Date(t), future: true };
  }
  return { at: now, future: false };
}

/** A local wall-clock instant `dayOffset` days after `base`'s local day. */
function localAt(base: Date, dayOffset: number, hour: number): Date {
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset, hour, 0, 0, 0);
}

/** "23:00" on the local day of `now`, else "2026-10-23 23:00". */
export function localTimeLabel(at: Date, now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const time = `${p(at.getHours())}:${p(at.getMinutes())}`;
  const sameDay =
    at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate();
  return sameDay ? time : `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())} ${time}`;
}

/** A resolved postpone: the earliest start and the reschedule that writes it. */
export type ResolvedPostpone =
  | { ok: true; notBefore: Date; reschedule: RescheduleTarget }
  | { ok: false; reason: string };

/**
 * Resolve `target` for `record` at `now` (KTD4). `reset` is the reset an
 * `after_limit_reset` target uses (already resolved by precedence); a
 * target's own `resetAt` wins over it. Refuses a task that is not movable,
 * a window with less than one hour left, a missing reset, and any start at
 * or before the planned start.
 */
export function resolvePostpone(
  record: TaskRecord<unknown>,
  target: PostponeTarget,
  now: Date,
  reset: LimitReset | null,
): ResolvedPostpone {
  if (!taskActions(record).later) {
    return { ok: false, reason: `task is ${record.status}; only queued or scheduled provider-call tasks can move` };
  }
  const planned = plannedStart(record, now);
  let start: Date;
  let reschedule: RescheduleTarget;
  if ("until" in target) {
    start = target.until instanceof Date ? target.until : new Date(target.until);
    if (Number.isNaN(start.getTime())) return { ok: false, reason: `not an ISO-8601 time: ${JSON.stringify(target.until)}` };
    reschedule = { at: start };
  } else if ("delayMs" in target) {
    if (!Number.isFinite(target.delayMs) || target.delayMs <= 0) {
      return { ok: false, reason: "a delay must be a positive duration" };
    }
    start = new Date(planned.at.getTime() + target.delayMs);
    reschedule = { notBefore: start };
  } else if (target.preset === "1h") {
    start = new Date(planned.at.getTime() + HOUR_MS);
    reschedule = { notBefore: start };
  } else if (target.preset === "after_limit_reset") {
    let at: Date | undefined;
    if (target.resetAt !== undefined) {
      at = target.resetAt instanceof Date ? target.resetAt : new Date(target.resetAt);
      if (Number.isNaN(at.getTime())) return { ok: false, reason: `reset time is not ISO-8601: ${JSON.stringify(target.resetAt)}` };
      if (at.getTime() <= now.getTime()) return { ok: false, reason: `the reset time ${at.toISOString()} is in the past` };
    } else {
      at = reset?.at;
    }
    if (!at) return { ok: false, reason: NEEDS_RESET_TIME };
    start = new Date(Math.max(at.getTime(), now.getTime()) + RESET_MARGIN_MS);
    reschedule = { notBefore: start };
  } else if (target.preset === "tonight" || target.preset === "tomorrow_morning") {
    let end: Date;
    if (target.preset === "tomorrow_morning") {
      start = localAt(now, 1, MORNING_START_H);
      end = localAt(now, 1, MORNING_END_H);
    } else if (now.getHours() < TONIGHT_END_H) {
      start = now;
      end = localAt(now, 0, TONIGHT_END_H);
    } else {
      start = new Date(Math.max(localAt(now, 0, TONIGHT_START_H).getTime(), now.getTime()));
      end = localAt(now, 1, TONIGHT_END_H);
    }
    if (end.getTime() - start.getTime() < HOUR_MS) return { ok: false, reason: "less than one hour of tonight is left" };
    reschedule = { dayStart: start, dayEnd: end };
  } else {
    return { ok: false, reason: `unknown preset ${JSON.stringify((target as { preset?: unknown }).preset)}` };
  }
  const later = planned.future ? start.getTime() > planned.at.getTime() : start.getTime() >= now.getTime();
  if (!later) {
    return { ok: false, reason: `already planned for ${localTimeLabel(planned.at, now)}` };
  }
  return { ok: true, notBefore: start, reschedule };
}

/**
 * The presets for `record` with their resolved earliest start (KTD6), for
 * every surface: the API's `later_options`, the page menu, the clients and
 * the Telegram buttons. `reset` is the known limit reset, or null.
 */
export function postponeOptions(record: TaskRecord<unknown>, now: Date, reset: LimitReset | null): PostponeOption[] {
  return POSTPONE_PRESETS.map((preset) => {
    const res = resolvePostpone(record, { preset }, now, reset);
    const base = { preset, label: POSTPONE_LABELS[preset] };
    return res.ok
      ? { ...base, not_before: res.notBefore.toISOString(), available: true }
      : { ...base, not_before: null, available: false, reason: res.reason };
  });
}
