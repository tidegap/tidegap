/**
 * The daily summary (`digest`, integrations plan U15): when it is due and
 * what it says. Pure: the host reads the ledger, calls {@link digestDue} and
 * {@link buildDigest}, and sends the event through the normal channel path.
 *
 * Rules: one summary per local day at `digest_at` (default 09:00, the end of
 * the quiet hours); a day with nothing to report sends nothing; the window
 * starts at the previous summary and covers at most 48 hours.
 */

import { localTimeLabel, MORNING_START_H } from "../postpone.js";
import { problemLine, type ReadinessProblem } from "../readiness.js";
import type { TaskRecord } from "../types.js";
import { messageTitle } from "./format.js";
import type { ChannelEvent, CleanWindowEvent } from "./types.js";

/** Ledger meta key: ISO-8601 time of the last summary sent. */
export const DIGEST_LAST_META_KEY = "notified:digest";

/** Ledger meta key: the local send time `HH:MM` (absent = {@link DEFAULT_DIGEST_AT}). */
export const DIGEST_AT_META_KEY = "digest_at";

/** The default send time: the end of the quiet hours. */
export const DEFAULT_DIGEST_AT = `${String(MORNING_START_H).padStart(2, "0")}:00`;

/** The longest window one summary covers (a machine asleep for days sends one summary, not several). */
export const DIGEST_MAX_WINDOW_MS = 48 * 3_600_000;

/** The window of the first summary, when no summary was sent before. */
export const DIGEST_FIRST_WINDOW_MS = 24 * 3_600_000;

/** Titles listed per section before "and N more". */
export const DIGEST_LIST_MAX = 10;

/** `{h, m}` of a valid `HH:MM` (00:00–23:59), else null. */
export function parseDigestAt(value: unknown): { h: number; m: number } | null {
  if (typeof value !== "string") return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  return m ? { h: Number(m[1]), m: Number(m[2]) } : null;
}

/** The stored send time, or the default when it is absent or invalid. */
export function digestAt(stored: string | undefined): string {
  return parseDigestAt(stored) ? stored!.trim() : DEFAULT_DIGEST_AT;
}

/**
 * Whether a summary is due at `now` and the window it covers. Due when the
 * local time is at or after today's send time and the last summary was sent
 * before it. A spring-forward gap moves the send time to the first valid
 * local minute after it (the `Date` constructor's rule).
 */
export function digestDue(now: Date, lastIso: string | undefined, at: string = DEFAULT_DIGEST_AT): { due: boolean; since: Date } {
  const t = parseDigestAt(digestAt(at))!;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), t.h, t.m);
  const last = lastIso !== undefined ? Date.parse(lastIso) : NaN;
  const floor = now.getTime() - DIGEST_MAX_WINDOW_MS;
  const since = new Date(Number.isFinite(last) ? Math.max(last, floor) : now.getTime() - DIGEST_FIRST_WINDOW_MS);
  const due = now.getTime() >= today.getTime() && !(Number.isFinite(last) && last >= today.getTime());
  return { due, since };
}

export interface DigestInput {
  since: Date;
  now: Date;
  /** Tasks that completed in the window. */
  done: readonly TaskRecord<unknown>[];
  /** Tasks that failed in the window. */
  failed: readonly TaskRecord<unknown>[];
  /** Tasks postponed in the window (once each). */
  postponed: readonly TaskRecord<unknown>[];
  /** Readiness problems still open at send time. */
  problems: readonly ReadinessProblem[];
  /** Tasks still waiting to run (queued or scheduled). */
  queued: number;
  /** The next clean window, when the host knows it. */
  window?: CleanWindowEvent | null;
}

/** The digest event, with what it covers so per-task alerts can fold into it. */
export type DigestEvent = Extract<ChannelEvent, { kind: "digest" }>;

function section(name: string, records: readonly TaskRecord<unknown>[]): string[] {
  if (records.length === 0) return [];
  const lines = [`${name} (${records.length}):`, ...records.slice(0, DIGEST_LIST_MAX).map((r) => `- ${messageTitle(r)}`)];
  if (records.length > DIGEST_LIST_MAX) lines.push(`- and ${records.length - DIGEST_LIST_MAX} more`);
  return lines;
}

function grams(records: readonly TaskRecord<unknown>[]): number {
  let sum = 0;
  for (const r of records) {
    const g = r.receipt?.actualCarbonGCo2 ?? r.receipt?.estimatedCarbonGCo2;
    if (typeof g === "number" && Number.isFinite(g)) sum += g;
  }
  return sum;
}

/**
 * The summary event, or null for an empty day: nothing finished, failed or
 * postponed in the window and no open problem. Queued work alone does not
 * make a summary.
 */
export function buildDigest(input: DigestInput): DigestEvent | null {
  const { done, failed, postponed, problems, now } = input;
  if (done.length + failed.length + postponed.length + problems.length === 0) return null;
  const counts = [
    done.length > 0 ? `${done.length} done` : "",
    failed.length > 0 ? `${failed.length} failed` : "",
    postponed.length > 0 ? `${postponed.length} postponed` : "",
  ].filter(Boolean);
  const title = `Tidegap daily summary${counts.length > 0 ? `: ${counts.join(", ")}` : ""}`;
  const lines = [`Since ${localTimeLabel(input.since, now)}.`];
  lines.push(...section("Done", done), ...section("Failed", failed), ...section("Postponed", postponed));
  const g = grams(done);
  if (g > 0) lines.push(`Carbon of done tasks: ${g < 10 ? g.toFixed(1) : Math.round(g)} g CO2e.`);
  if (problems.length > 0) lines.push("Cannot run yet:", ...problems.map(problemLine));
  const w = input.window;
  if (input.queued > 0) {
    const at = w ? ` Next clean window: ${localTimeLabel(new Date(w.start), now)} to ${localTimeLabel(new Date(w.end), now)}.` : "";
    lines.push(`Planned: ${input.queued} queued ${input.queued === 1 ? "task" : "tasks"}.${at}`);
  }
  return {
    kind: "digest",
    title,
    text: lines.join("\n"),
    covers: {
      taskIds: [...done, ...failed].map((r) => r.taskId),
      notReady: problems.length > 0,
      ...(w ? { cleanWindow: w.start } : {}),
    },
  };
}
