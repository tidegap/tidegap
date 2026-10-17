/**
 * The `usage/v1` document (KTD10) and its one-line summary, built in one
 * place so every surface shows the same text. PR 1 carries the Claude limit
 * block; spend and Codex join with U3.
 */

import { resetTarget } from "./target.js";
import type { ClaudeLimitState, LimitWindow } from "./types.js";

export interface UsageDocument {
  schema: "usage/v1";
  generated_at: string;
  claude: ClaudeLimitState;
  target_reset?: { at: string; window: string; exhausted: boolean };
  line: string;
}

const LABEL: Record<string, string> = { five_hour: "5h", seven_day: "7d" };

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** `16:30` today (local time), else `Mon 16:30`. */
export function clockLabel(at: Date, now: Date): string {
  const hm = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  if (at.toDateString() === now.toDateString()) return hm;
  return `${at.toLocaleDateString("en-US", { weekday: "short" })} ${hm}`;
}

/** Label of a window name: `5h`, `7d`, or the scoped model name. */
export function windowLabel(name: string): string {
  return LABEL[name] ?? name;
}

function current(w: LimitWindow | undefined, now: Date): LimitWindow | undefined {
  return w && Date.parse(w.resets_at) > now.getTime() ? w : undefined;
}

/**
 * `Claude 5h: 72%, resets 16:30` for the window with the highest percent.
 * Passed windows are left out; a stale value appends `(as of HH:MM)`;
 * unavailable state names the cause; `disabled` gives "".
 */
export function formatLine(state: ClaudeLimitState, now: Date = new Date()): string {
  if (state.status === "disabled") return "";
  if (state.status === "unavailable") return `Claude: limits unavailable (${state.error?.cause ?? "no_data"})`;
  const windows: Array<[string, LimitWindow]> = [];
  const five = current(state.five_hour, now);
  const seven = current(state.seven_day, now);
  if (five) windows.push(["five_hour", five]);
  if (seven) windows.push(["seven_day", seven]);
  const asOf = state.stale && state.fetched_at ? ` (as of ${clockLabel(new Date(state.fetched_at), now)})` : "";
  if (windows.length === 0) return `Claude: limits reset since last seen${asOf}`;
  const [name, w] = windows.reduce((a, b) => (b[1].pct > a[1].pct ? b : a));
  return `Claude ${windowLabel(name)}: ${Math.round(w.pct)}%, resets ${clockLabel(new Date(w.resets_at), now)}${asOf}`;
}

export function buildUsageDocument(state: ClaudeLimitState, now: Date = new Date()): UsageDocument {
  const found = resetTarget(state);
  // Same past-reset rule as resolveResetTarget, without the re-read.
  const target = found && found.at.getTime() <= now.getTime() ? { ...found, at: now, exhausted: false } : found;
  return {
    schema: "usage/v1",
    generated_at: now.toISOString(),
    claude: state,
    ...(target
      ? { target_reset: { at: target.at.toISOString(), window: target.window, exhausted: target.exhausted } }
      : {}),
    line: formatLine(state, now),
  };
}
