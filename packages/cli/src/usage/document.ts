/**
 * The `usage/v1` document (KTD10) and its one-line summary, built in one
 * place so every surface shows the same text. `codex` is present when the
 * host read the Codex logs; `claude_spend` only on request (the scan costs
 * seconds).
 */

import type { ClaudeSpend } from "./claude-spend.js";
import type { CodexUsage } from "./codex.js";
import { resetTarget } from "./target.js";
import type { ClaudeLimitState, LimitWindow } from "./types.js";

export interface UsageDocument {
  schema: "usage/v1";
  generated_at: string;
  claude: ClaudeLimitState;
  claude_spend?: ClaudeSpend;
  codex?: CodexUsage;
  target_reset?: { at: string; window: string; exhausted: boolean };
  line: string;
}

/** `/api/summary.limits`: the line and the window it names. */
export interface SummaryLimits {
  line: string;
  status: ClaudeLimitState["status"];
  /** The window the line names (`five_hour`, `seven_day`), null when the line names none. */
  window: string | null;
  pct: number | null;
  resets_at: string | null;
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

/** The current window with the highest percent (5-hour on a tie): the one the line names. */
function lineWindow(state: ClaudeLimitState, now: Date): [string, LimitWindow] | undefined {
  if (state.status !== "ok") return undefined;
  const windows: Array<[string, LimitWindow]> = [];
  const five = current(state.five_hour, now);
  const seven = current(state.seven_day, now);
  if (five) windows.push(["five_hour", five]);
  if (seven) windows.push(["seven_day", seven]);
  return windows.length ? windows.reduce((a, b) => (b[1].pct > a[1].pct ? b : a)) : undefined;
}

/**
 * `Claude 5h: 72%, resets 16:30` for the window with the highest percent.
 * Passed windows are left out; a stale value appends `(as of HH:MM)`;
 * unavailable state names the cause; `disabled` gives "".
 */
export function formatLine(state: ClaudeLimitState, now: Date = new Date()): string {
  if (state.status === "disabled") return "";
  if (state.status === "unavailable") return `Claude: limits unavailable (${state.error?.cause ?? "no_data"})`;
  const asOf = state.stale && state.fetched_at ? ` (as of ${clockLabel(new Date(state.fetched_at), now)})` : "";
  const named = lineWindow(state, now);
  if (!named) return `Claude: limits reset since last seen${asOf}`;
  const [name, w] = named;
  return `Claude ${windowLabel(name)}: ${Math.round(w.pct)}%, resets ${clockLabel(new Date(w.resets_at), now)}${asOf}`;
}

export function buildUsageDocument(
  state: ClaudeLimitState,
  now: Date = new Date(),
  extra: { claudeSpend?: ClaudeSpend; codex?: CodexUsage } = {},
): UsageDocument {
  const found = resetTarget(state);
  // Same past-reset rule as resolveResetTarget, without the re-read.
  const target = found && found.at.getTime() <= now.getTime() ? { ...found, at: now, exhausted: false } : found;
  return {
    schema: "usage/v1",
    generated_at: now.toISOString(),
    claude: state,
    ...(extra.claudeSpend ? { claude_spend: extra.claudeSpend } : {}),
    ...(extra.codex ? { codex: extra.codex } : {}),
    ...(target
      ? { target_reset: { at: target.at.toISOString(), window: target.window, exhausted: target.exhausted } }
      : {}),
    line: formatLine(state, now),
  };
}

/**
 * The compact form `/api/summary` carries (KTD10). `disabled` and `no_data`
 * (no reading ever, e.g. no status line hook) give an empty line, so the
 * menu bar and the popup show nothing.
 */
export function summaryLimits(state: ClaudeLimitState, now: Date = new Date()): SummaryLimits {
  const named = lineWindow(state, now);
  const noData = state.status === "unavailable" && state.error?.cause === "no_data";
  return {
    line: noData ? "" : formatLine(state, now),
    status: state.status,
    window: named?.[0] ?? null,
    pct: named ? named[1].pct : null,
    resets_at: named?.[1].resets_at ?? null,
  };
}
