/**
 * IANA zone helpers shared by the quota-reset and the job cadence code.
 *
 * Import-free on purpose: `quota.ts` imports `jobs.ts` (the job sweep runs
 * in `prepareTick`), and `jobs.ts` and `job-cadence.ts` need these helpers,
 * so they cannot live in `quota.ts` without an import cycle.
 */

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** True when `tz` is an IANA zone this runtime knows. */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The system's IANA zone, or `UTC` when the runtime reports none or one it cannot use (`TZ=` gives `Etc/Unknown`). */
export function systemTimeZone(): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return tz && isValidTimeZone(tz) ? tz : "UTC";
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

/** Local wall time of an instant in `tz`, as epoch ms of that wall time read as UTC. */
export function localTime(ms: number, tz: string): number {
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
