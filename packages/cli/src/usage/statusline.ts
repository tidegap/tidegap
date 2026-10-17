/**
 * Limit source #1: the JSON Claude Code passes to its statusLine command.
 * `rate_limits.five_hour` / `seven_day` carry `used_percentage` (0-100) and
 * `resets_at` (Unix epoch seconds) for Pro/Max logins, after the first API
 * response of a session (https://code.claude.com/docs/en/statusline).
 *
 * `tidegap usage hook [-- <command> [args...]]` is that statusLine command:
 * it stores the windows in `~/.tidegap/usage.json` and prints nothing, or
 * hands the same stdin to the wrapped statusline command and passes its
 * output through. No token is involved.
 */

import { spawn } from "node:child_process";

import { readUsageCache, usageCachePath, writeUsageCache } from "./cache.js";
import type { ClaudeLimits, LimitWindow, UsageSettings } from "./types.js";

/** An unchanged reading is rewritten at most this often. */
const REWRITE_MS = 30_000;

function epochWindow(v: unknown): LimitWindow | undefined {
  if (!v || typeof v !== "object") return undefined;
  const w = v as { used_percentage?: unknown; resets_at?: unknown };
  if (typeof w.used_percentage !== "number" || !Number.isFinite(w.used_percentage)) return undefined;
  if (typeof w.resets_at !== "number" || !Number.isFinite(w.resets_at)) return undefined;
  return { pct: w.used_percentage, resets_at: new Date(w.resets_at * 1000).toISOString() };
}

/** The limit windows in a statusline input, or undefined when it has none. */
export function limitsFromStatusline(input: unknown): ClaudeLimits | undefined {
  const rl = (input as { rate_limits?: unknown } | null)?.rate_limits;
  if (!rl || typeof rl !== "object") return undefined;
  const o = rl as { five_hour?: unknown; seven_day?: unknown };
  const out: ClaudeLimits = { scoped: [] };
  const five = epochWindow(o.five_hour);
  const seven = epochWindow(o.seven_day);
  if (five) out.five_hour = five;
  if (seven) out.seven_day = seven;
  return five || seven ? out : undefined;
}

/** Store a statusline reading. Returns true when the file was written. */
export function recordStatusline(
  stdin: string,
  opts: { settings: UsageSettings; cachePath?: string; now?: Date },
): boolean {
  if (opts.settings.disabled) return false;
  let input: unknown;
  try {
    input = JSON.parse(stdin);
  } catch {
    return false;
  }
  const data = limitsFromStatusline(input);
  if (!data) return false;
  const path = opts.cachePath ?? usageCachePath();
  const now = opts.now ?? new Date();
  const file = readUsageCache(path);
  const prev = file.claude.statusline;
  if (
    prev &&
    JSON.stringify(prev.data) === JSON.stringify(data) &&
    now.getTime() - Date.parse(prev.fetched_at) < REWRITE_MS
  ) {
    return false;
  }
  file.claude.statusline = { fetched_at: now.toISOString(), data };
  writeUsageCache(file, path);
  return true;
}

/**
 * The hook body: record the reading (never fails the statusline), then run
 * the wrapped command, if any, with the same stdin and inherited stdout.
 * Resolves to the exit code to use.
 */
export async function runStatuslineHook(
  stdin: string,
  wrapped: string[],
  opts: { settings: UsageSettings; cachePath?: string; now?: Date },
): Promise<number> {
  try {
    recordStatusline(stdin, opts);
  } catch {
    // A read-only home or a full disk must not blank the user's statusline.
  }
  const [cmd, ...args] = wrapped;
  if (!cmd) return 0;
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "inherit", "inherit"] });
    child.on("error", () => resolve(1));
    child.on("close", (code) => resolve(code ?? 1));
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  });
}
