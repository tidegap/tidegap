/**
 * "The limit reset" (KTD5), one rule for every caller. A window is exhausted
 * at `pct >= 100`. Any exhausted: the latest reset among them. None: the
 * reset of the window with the highest `pct` (5-hour on a tie). No state: no
 * target, and the caller refuses with "limit state unavailable: <cause>".
 */

import type { ClaudeLimitState, LimitWindow } from "./types.js";

export interface ResetTarget {
  at: Date;
  /** `five_hour`, `seven_day`, or a scoped model name. */
  window: string;
  exhausted: boolean;
  pct: number;
}

export type TargetResult = { ok: true; target: ResetTarget } | { ok: false; reason: string };

/** True when a scoped window's model is the task's model ("Fable" matches `fable`, `claude-fable-5`). */
function scopeMatches(scope: string, model: string | undefined): boolean {
  return model !== undefined && model.toLowerCase().includes(scope.toLowerCase());
}

/**
 * The target from one state, without the past-reset refetch. `model` adds
 * the scoped window of that model (the claude-code adapter, KTD13).
 */
export function resetTarget(state: ClaudeLimitState, model?: string): ResetTarget | undefined {
  if (state.status !== "ok") return undefined;
  const windows: Array<[string, LimitWindow]> = [];
  if (state.five_hour) windows.push(["five_hour", state.five_hour]);
  if (state.seven_day) windows.push(["seven_day", state.seven_day]);
  for (const s of state.scoped) if (scopeMatches(s.model, model)) windows.push([s.model, s]);
  if (windows.length === 0) return undefined;
  const exhausted = windows.filter(([, w]) => w.pct >= 100);
  if (exhausted.length > 0) {
    const [name, w] = exhausted.reduce((a, b) => (Date.parse(b[1].resets_at) > Date.parse(a[1].resets_at) ? b : a));
    return { at: new Date(w.resets_at), window: name, exhausted: true, pct: w.pct };
  }
  const [name, w] = windows.reduce((a, b) => (b[1].pct > a[1].pct ? b : a));
  return { at: new Date(w.resets_at), window: name, exhausted: false, pct: w.pct };
}

/** "limit state unavailable: <cause>" for a state with no target. */
export function unavailableReason(state: ClaudeLimitState): string {
  if (state.status === "disabled") return "limit state unavailable: limit reads are off (TIDEGAP_USAGE=off)";
  if (state.error) return `limit state unavailable: ${state.error.message}`;
  return "limit state unavailable: no limit window reported";
}

/**
 * KTD5 with the past-reset rule: a reset already in the past triggers one
 * fresh read (`reread`); still in the past, the target is now, and not
 * exhausted (the reading is older than its own reset).
 */
export async function resolveResetTarget(
  state: ClaudeLimitState,
  opts: { now?: Date; model?: string; reread?: () => Promise<ClaudeLimitState> } = {},
): Promise<TargetResult> {
  const now = opts.now ?? new Date();
  let target = resetTarget(state, opts.model);
  if (!target) return { ok: false, reason: unavailableReason(state) };
  if (target.at.getTime() <= now.getTime() && opts.reread) {
    const fresh = await opts.reread();
    target = resetTarget(fresh, opts.model) ?? target;
  }
  if (target.at.getTime() <= now.getTime()) target = { ...target, at: now, exhausted: false };
  return { ok: true, target };
}
