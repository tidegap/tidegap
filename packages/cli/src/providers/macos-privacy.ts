/**
 * The macOS privacy hint for a run that stopped at its time limit (batch 34
 * KTD6-KTD8). A launchd daemon whose child opens a file under ~/Documents,
 * ~/Desktop or ~/Downloads waits on the Files & Folders check for the
 * daemon's `node` until the user answers it; the run prints nothing and
 * stops at its time limit. The hint never claims that cause: many commands
 * are quiet by design, so it says what to do if the script reads such a
 * folder. Tidegap never opens a protected folder to decide (R9): the rule
 * reads only the platform, the stop, the quiet time and the run's text.
 *
 * The command runner and the `claude-code` runner share the texts. Each
 * keeps its own trigger: `claude -p` writes stdout only at its end, so the
 * `claude-code` runner gives the hint to any timed-out run with no stderr.
 */

import { homedir } from "node:os";

/** Folders whose access macOS asks about, named in a cwd or a command text. */
export const PROTECTED_DIRS = /(^|[\s'"=:])(~|\$HOME|\/Users\/[^/\s]+)\/(Documents|Desktop|Downloads)(\/|$|[\s'"])/;

/** The hint on the first line of the reason, which one-line surfaces show (cut to 140 characters). */
export const MACOS_PRIVACY_HINT = "macOS: if it reads a protected folder, allow node in Files & Folders";

/**
 * Quiet time before the stop that triggers the hint, or the whole time limit
 * when that is shorter. A diagnostic threshold, not a run limit.
 */
export const QUIET_HINT_MS = 2 * 60_000;

export interface CommandHintInput {
  platform: NodeJS.Platform;
  /** True when the run stopped at its time limit; an exit, a signal or a cancel gets no hint. */
  timedOut: boolean;
  /** Time from the last stdout or stderr byte (or the spawn) to the stop. */
  quietMs: number;
  /** The run's time limit in ms. */
  limitMs: number;
  /** True when the run wrote nothing to stderr. */
  noStderr: boolean;
  cwd: string;
  command: string;
}

/** True when the run was quiet for the final `min(QUIET_HINT_MS, limit)` before its stop. */
export function quietBeforeStop(quietMs: number, limitMs: number): boolean {
  return quietMs >= Math.min(QUIET_HINT_MS, limitMs);
}

/**
 * The command runner's rule (KTD6): on `darwin`, a time-limit stop gets the
 * hint when the run was quiet for the final quiet window, or when it wrote
 * no stderr and its cwd or command text names a protected folder.
 */
export function commandHintApplies(input: CommandHintInput): boolean {
  if (input.platform !== "darwin" || !input.timedOut) return false;
  if (quietBeforeStop(input.quietMs, input.limitMs)) return true;
  return input.noStderr && (PROTECTED_DIRS.test(` ${input.cwd}`) || PROTECTED_DIRS.test(` ${input.command}`));
}

/** `ms` as its two largest units: `45s`, `4m 30s`, `1h 59m`, `2d 3h`. */
export function formatQuiet(ms: number): string {
  const s = Math.floor(ms / 1000);
  const units: [number, string][] = [
    [Math.floor(s / 86_400), "d"],
    [Math.floor(s / 3_600) % 24, "h"],
    [Math.floor(s / 60) % 60, "m"],
    [s % 60, "s"],
  ];
  const first = units.findIndex(([n]) => n > 0);
  if (first < 0) return "0s";
  return units
    .slice(first, first + 2)
    .filter(([n]) => n > 0)
    .map(([n, u]) => `${n}${u}`)
    .join(" ");
}

/** `path` with the home folder written as `~`. */
function tildeHome(path: string, home: string): string {
  if (!home || home === "/") return path;
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** The full next step, the line after the first one: where to allow the daemon's node, or how to avoid the check. */
export function privacyNextStep(execPath: string = process.execPath, home: string = homedir()): string {
  return (
    `System Settings › Privacy & Security › Files & Folders: allow ${tildeHome(execPath, home)}, ` +
    "or keep the folder outside ~/Documents, ~/Desktop and ~/Downloads."
  );
}
