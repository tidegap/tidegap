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

import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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

/**
 * Home folders macOS guards with a privacy prompt (iCloud Drive is
 * `Library/Mobile Documents`). A daemon whose `node` or entry script sits in
 * one can hang on that prompt with nobody to answer it, and so can the page
 * server on a settings file that links into one.
 */
export const MACOS_GUARDED_DIRS: readonly string[] = ["Documents", "Desktop", "Downloads", "Library/Mobile Documents"];

/** Where the guarded-link check looks; tests pass a fake home and `darwin`. */
export interface GuardOptions {
  /** Default: this user's home. */
  home?: string;
  /** Default: this process's platform. Only `darwin` guards folders. */
  platform?: NodeJS.Platform;
}

/** Most links followed before the walk gives up (the kernel's own limit is about as large). */
const MAX_LINKS = 40;

/**
 * The guarded folder `path` lies in, by its own components and the links on
 * its way; undefined when none, and always off macOS. Links are followed by
 * `lstat` and `readlink` only, and a component inside a guarded folder is
 * never touched: the walk stops before it. So it never opens, stats through
 * or lists a target macOS would ask about. A missing component ends the
 * link walk; the rest of the path is still compared.
 */
export function guardedFolder(path: string, opts: GuardOptions = {}): string | undefined {
  return walkToGuarded(path, opts)?.folder;
}

/**
 * Whether the page server may open `path`: false when `guard` is set and
 * `path` lies in or links into a guarded folder. A reader that gets false
 * takes its "no file" answer (the environment, then the defaults) instead of
 * waiting on a privacy prompt.
 */
export function openable(path: string, guard: GuardOptions | undefined): boolean {
  return !guard || guardedFolder(path, guard) === undefined;
}

function walkToGuarded(path: string, opts: GuardOptions): { folder: string; linked: boolean } | undefined {
  if ((opts.platform ?? process.platform) !== "darwin") return undefined;
  const home = opts.home ?? homedir();
  if (!home || home === "/") return undefined;
  const homes = [...new Set([home, realOr(home)])];
  const guardedIn = (p: string) =>
    MACOS_GUARDED_DIRS.find((d) => homes.some((h) => p === join(h, d) || p.startsWith(`${join(h, d)}/`)));
  const pending = path.split("/").filter(Boolean);
  let cur = "/";
  let links = 0;
  let missing = false;
  while (pending.length > 0) {
    const name = pending.shift()!;
    if (name === ".") continue;
    if (name === "..") {
      cur = dirname(cur);
      continue;
    }
    const next = join(cur, name);
    const folder = guardedIn(next);
    if (folder) return { folder, linked: links > 0 };
    if (!missing) {
      let link: string | undefined;
      try {
        if (lstatSync(next).isSymbolicLink()) link = readlinkSync(next);
      } catch {
        missing = true;
      }
      if (link !== undefined) {
        if (++links > MAX_LINKS) return undefined;
        pending.unshift(...link.split("/").filter(Boolean));
        if (link.startsWith("/")) cur = "/";
        continue;
      }
    }
    cur = next;
  }
  return undefined;
}

function realOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** A settings or secrets file the page server will not open: it lies in, or links into, a guarded folder. */
export class GuardedFolderError extends Error {
  readonly code = "guarded_folder" as const;
  constructor(
    readonly file: string,
    readonly folder: string,
    linked: boolean,
    home: string,
  ) {
    const shown = folder === "Library/Mobile Documents" ? "iCloud Drive (~/Library/Mobile Documents)" : `~/${folder}`;
    const where = linked ? `links into ${shown}` : `is in ${shown}`;
    const fix = linked ? `Move the file back to ${tildeHome(dirname(file), home)}, or remove the link.` : `Move the file out of ${shown}.`;
    super(`${tildeHome(file, home)} ${where}, a folder macOS guards with a privacy prompt, so Tidegap does not open it here. ${fix}`);
  }
}

/** The refusal for the first of `paths` in or linked into a guarded folder; undefined when none is. */
export function guardedLinkError(paths: readonly string[], opts: GuardOptions = {}): GuardedFolderError | undefined {
  for (const file of paths) {
    const hit = walkToGuarded(file, opts);
    if (hit) return new GuardedFolderError(file, hit.folder, hit.linked, opts.home ?? homedir());
  }
  return undefined;
}

/** The page server's answer to a {@link GuardedFolderError}. */
export function guardedFolderResponse(err: GuardedFolderError): { status: 409; body: { error: string; code: "guarded_folder" } } {
  return { status: 409, body: { error: err.message, code: err.code } };
}
