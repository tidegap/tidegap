/**
 * The Claude Code statusLine registration, shared by `tidegap install` (a
 * terminal yes), `tidegap usage install-hook` and the page's Connect button.
 * Nothing else writes `~/.claude/settings.json`, and each of those writes
 * only on the user's explicit act.
 *
 * Three steps: inspect (classify the `statusLine`), plan (the command to
 * store), write (backup, mode kept, a symlink's target replaced, atomic
 * rename, after a re-read shows the file unchanged). An existing statusLine
 * command is wrapped, never replaced, and `removeHook` restores it exactly.
 *
 * The stored command is guarded: one `sh -c` program, with the launcher
 * paths and the user's command as positional arguments, so no path or user
 * text is spliced into the program. When every launcher path exists it runs
 * `<launcher> usage hook -- sh -c <user command>`; otherwise it runs the
 * user's command alone (or prints nothing), so a moved or removed Tidegap
 * never blanks the user's status line.
 *
 * Error reasons are fixed phrases: a JSON parser's message quotes the file
 * near the error, and the file can hold secrets in `env`.
 */

import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";

/** The settings file as every message names it. */
export const SETTINGS_SHOWN = "~/.claude/settings.json";

const SAFE_WORD = /^[A-Za-z0-9_./:@%+=-]+$/;

/** Shell-quote one word: bare when safe, else single-quoted with the `'\''` escape. */
function shq(s: string): string {
  return SAFE_WORD.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** One bare safe word, or one single-quoted word with `'\''` escapes. */
const WORD = /[A-Za-z0-9_./:@%+=-]+|'[^']*'(?:\\''[^']*')*/y;

/**
 * The words of a command that `shq` wrote, joined by single spaces; undefined
 * for anything else (other quoting, double spaces, a trailing space).
 */
function shellWords(cmd: string): string[] | undefined {
  const words: string[] = [];
  let i = 0;
  while (i < cmd.length) {
    WORD.lastIndex = i;
    const raw = WORD.exec(cmd)?.[0];
    if (!raw) return undefined;
    const word = raw.startsWith("'") ? raw.slice(1, -1).replace(/'\\''/g, "'") : raw;
    if (shq(word) !== raw) return undefined;
    words.push(word);
    i += raw.length;
    if (i === cmd.length) break;
    if (cmd[i] !== " " || i + 1 === cmd.length) return undefined;
    i++;
  }
  return words;
}

/** `$0` of the guarded program; the parser keys on it. */
const HOOK_NAME = "tidegap-usage-hook";

/**
 * The guard. Its arguments: the launcher paths, `--`, then the user's command
 * when there is one. The loop moves the launcher paths to the end of `$@`
 * (each is checked) and keeps the word after `--` in `c`. The parser matches
 * this exact text, so a change to it must keep the old text recognized as
 * `legacy` (an older shape that Reconnect updates): every installed hook
 * stores it.
 */
const GUARD =
  'm=; c=; s=; for a in "$@"; do shift; if [ -n "$s" ]; then c=$a; elif [ "$a" = -- ]; then s=1; ' +
  'else [ -e "$a" ] || m=1; set -- "$@" "$a"; fi; done; ' +
  'if [ -z "$m" ]; then if [ -n "$c" ]; then exec "$@" usage hook -- sh -c "$c"; fi; exec "$@" usage hook; fi; ' +
  'if [ -n "$c" ]; then exec sh -c "$c"; fi; exit 0';

/** The guarded statusLine command for `launcher` (one or two absolute paths), wrapping `userCommand`. */
export function guardedCommand(launcher: string[], userCommand?: string): string {
  if (launcher.length < 1 || launcher.length > 2) throw new Error("the hook needs a launcher of one or two paths");
  if (!launcher.every((p) => isAbsolute(p))) throw new Error("the hook needs absolute launcher paths");
  const words = ["sh", "-c", GUARD, HOOK_NAME, ...launcher, "--", ...(userCommand === undefined ? [] : [userCommand])];
  return words.map(shq).join(" ");
}

/** The launcher and the wrapped command of a command `guardedCommand` wrote; undefined for any other text. */
export function parseGuardedCommand(cmd: string): { launcher: string[]; userCommand?: string } | undefined {
  const w = shellWords(cmd);
  if (!w || w[0] !== "sh" || w[1] !== "-c" || w[2] !== GUARD || w[3] !== HOOK_NAME) return undefined;
  const sep = w.indexOf("--", 4);
  const launcher = w.slice(4, sep);
  const rest = w.slice(sep + 1);
  if (sep < 0 || launcher.length < 1 || launcher.length > 2 || !launcher.every((p) => isAbsolute(p)) || rest.length > 1) return undefined;
  return rest.length ? { launcher, userCommand: rest[0]! } : { launcher };
}

/** The unguarded shape older versions stored: `<launcher> usage hook [-- sh -c '<command>']`. */
function parseLegacyCommand(cmd: string): { userCommand?: string } | undefined {
  const w = shellWords(cmd);
  if (!w) return undefined;
  const at = w.findIndex((x, i) => i > 0 && x === "usage" && w[i + 1] === "hook");
  if (at < 1 || at > 2) return undefined;
  const rest = w.slice(at + 2);
  if (rest.length === 0) return {};
  return rest.length === 4 && rest[0] === "--" && rest[1] === "sh" && rest[2] === "-c" ? { userCommand: rest[3]! } : undefined;
}

export function claudeSettingsPath(home: string = homedir()): string {
  return join(home, ".claude", "settings.json");
}

/**
 * `absent`: no statusLine command. `other`: the user's own command.
 * `connected`: the guarded hook with every path present, or a command with
 * `usage hook` that Tidegap did not write (`foreign`, never rewritten).
 * `legacy`: the older, unguarded hook. `stale`: a guarded hook whose node or
 * script path is gone. `unreadable`: see `reason`.
 */
export type StatuslineState = "absent" | "other" | "connected" | "legacy" | "stale" | "unreadable";

export interface StatuslineInspection {
  path: string;
  state: StatuslineState;
  /** `unreadable` only: a fixed phrase, never file content. */
  reason?: string;
  /** The user's own command: the one `other` holds, or the one a Tidegap hook wraps. */
  userCommand?: string;
  /** `connected` through a command Tidegap did not write. */
  foreign?: boolean;
  /** The file's text at inspection (undefined: no file), for the unchanged check before a write. */
  raw?: string;
  /** The parsed file (readable states only). */
  settings?: Record<string, unknown>;
}

type StatusLineValue = { type?: unknown; command?: unknown; [k: string]: unknown };

function readRaw(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/** Read and classify the statusLine of `path`. Never throws. */
export function inspectStatusline(path: string = claudeSettingsPath()): StatuslineInspection {
  let raw: string | undefined;
  try {
    raw = readRaw(path);
  } catch (err) {
    return { path, state: "unreadable", reason: `cannot be read (${(err as NodeJS.ErrnoException).code ?? "error"})` };
  }
  if (raw === undefined) return { path, state: "absent", settings: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { path, state: "unreadable", reason: "is not valid JSON", raw };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { path, state: "unreadable", reason: "is not a JSON object", raw };
  }
  const settings = parsed as Record<string, unknown>;
  const sl = settings.statusLine;
  const base = { path, raw, settings };
  if (sl === undefined) return { ...base, state: "absent" };
  const command = (sl as StatusLineValue | null)?.command;
  if (!sl || typeof sl !== "object" || Array.isArray(sl) || (command !== undefined && typeof command !== "string")) {
    return { path, state: "unreadable", reason: "has a statusLine in another format", raw };
  }
  if (typeof command !== "string" || !command.trim()) return { ...base, state: "absent" };
  const wrap = (userCommand: string | undefined) => (userCommand === undefined ? {} : { userCommand });
  const guarded = parseGuardedCommand(command);
  if (guarded) {
    return { ...base, ...wrap(guarded.userCommand), state: guarded.launcher.every((p) => existsSync(p)) ? "connected" : "stale" };
  }
  const legacy = parseLegacyCommand(command);
  if (legacy) return { ...base, ...wrap(legacy.userCommand), state: "legacy" };
  if (/\busage hook\b/.test(command)) return { ...base, state: "connected", foreign: true };
  return { ...base, state: "other", userCommand: command };
}

export type HookResult = "registered" | "wrapped" | "updated" | "already";

export type Refusal = { ok: false; result: "unreadable" | "changed" | "foreign"; rule: string };

export type RegisterOutcome = { ok: true; result: HookResult; command?: string; backup?: string } | Refusal;

export type RemoveOutcome = { ok: true; result: "removed"; restored?: string; backup?: string } | { ok: true; result: "none" } | Refusal;

function unreadable(insp: StatuslineInspection): Refusal {
  return { ok: false, result: "unreadable", rule: `Tidegap cannot read ${SETTINGS_SHOWN}, so it cannot connect: ${insp.reason}.` };
}

const CHANGED: Refusal = {
  ok: false,
  result: "changed",
  rule: `${SETTINGS_SHOWN} changed while Tidegap was updating it; nothing was written. Try again.`,
};

/** What a register over `insp` does, and the command it stores; undefined when the file is unreadable. */
export function planHook(insp: StatuslineInspection, launcher: string[]): { result: HookResult; command?: string } | undefined {
  switch (insp.state) {
    case "unreadable":
      return undefined;
    case "connected":
      return { result: "already" };
    case "absent":
      return { result: "registered", command: guardedCommand(launcher) };
    case "other":
      return { result: "wrapped", command: guardedCommand(launcher, insp.userCommand) };
    default:
      return { result: "updated", command: guardedCommand(launcher, insp.userCommand) };
  }
}

/** Write `settings` back, unless the file changed since `insp` read it. */
function commit(insp: StatuslineInspection, settings: Record<string, unknown>): { backup?: string } | undefined {
  if (readRaw(insp.path) !== insp.raw) return undefined;
  return { backup: writeSettings(insp.path, `${JSON.stringify(settings, null, 2)}\n`) };
}

/**
 * Register the hook for `launcher`. `inspection` is the state the user saw
 * (the terminal question); the write is refused when the file changed since.
 */
export function registerHook(opts: { launcher: string[]; settingsPath?: string; inspection?: StatuslineInspection }): RegisterOutcome {
  const insp = opts.inspection ?? inspectStatusline(opts.settingsPath);
  const plan = planHook(insp, opts.launcher);
  if (!plan) return unreadable(insp);
  if (!plan.command) return { ok: true, result: plan.result };
  const current = (insp.settings!.statusLine ?? {}) as StatusLineValue;
  const written = commit(insp, { ...insp.settings, statusLine: { ...current, type: "command", command: plan.command } });
  if (!written) return CHANGED;
  return { ok: true, result: plan.result, command: plan.command, ...written };
}

/**
 * Remove a hook Tidegap wrote: restore the wrapped command, or, with none,
 * drop the `type` and `command` the hook added (and the key when nothing
 * else is left). Every other key and field stays.
 */
export function removeHook(opts: { settingsPath?: string; inspection?: StatuslineInspection } = {}): RemoveOutcome {
  const insp = opts.inspection ?? inspectStatusline(opts.settingsPath);
  if (insp.state === "unreadable") return unreadable(insp);
  if (insp.state === "absent" || insp.state === "other") return { ok: true, result: "none" };
  if (insp.foreign) {
    return {
      ok: false,
      result: "foreign",
      rule: `The statusLine in ${SETTINGS_SHOWN} runs \`usage hook\` in a form Tidegap did not write; edit it by hand.`,
    };
  }
  const { statusLine, ...rest } = insp.settings!;
  const { type: _type, command: _command, ...fields } = statusLine as StatusLineValue;
  const next =
    insp.userCommand !== undefined
      ? { ...insp.settings, statusLine: { ...(statusLine as StatusLineValue), command: insp.userCommand } }
      : Object.keys(fields).length
        ? { ...insp.settings, statusLine: fields }
        : rest;
  const written = commit(insp, next);
  if (!written) return CHANGED;
  return { ok: true, result: "removed", ...(insp.userCommand === undefined ? {} : { restored: insp.userCommand }), ...written };
}

/**
 * Backup, then an atomic write that keeps the file's mode and replaces the
 * target of a symlink, not the link. A link at the backup or temp path is
 * removed first, never written through. Returns the backup path.
 */
function writeSettings(path: string, text: string): string | undefined {
  let target = path;
  let mode = 0o600;
  let backup: string | undefined;
  if (existsSync(path)) {
    target = realpathSync(path);
    mode = statSync(target).mode & 0o777;
    backup = `${target}.tidegap.bak`;
    rmSync(backup, { force: true });
    copyFileSync(target, backup, constants.COPYFILE_EXCL);
    chmodSync(backup, mode);
  } else {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }
  const tmp = `${target}.tidegap.tmp`;
  rmSync(tmp, { force: true });
  try {
    writeFileSync(tmp, text, { encoding: "utf8", mode, flag: "wx" });
    chmodSync(tmp, mode);
    renameSync(tmp, target);
  } catch (err) {
    // The settings file is untouched; leave no temp file beside it.
    rmSync(tmp, { force: true });
    throw err;
  }
  return backup;
}

/** The first `name` on `pathEnv` whose real path is `real`. */
function onPath(name: string, real: string, pathEnv: string): string | undefined {
  for (const d of pathEnv.split(delimiter)) {
    if (!d) continue;
    const p = join(d, name);
    try {
      if (realpathSync(p) === real) return p;
    } catch {
      // Not there.
    }
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

/**
 * The launcher to store in the hook: the running node is named by the first
 * `node` on PATH that resolves to it, so an upgrade that moves the versioned
 * binary (Homebrew) leaves the stored path valid. Other launchers stay.
 */
export function hookLauncher(
  launcher: string[],
  opts: { pathEnv?: string; execPath?: string } = {},
): string[] {
  const execPath = opts.execPath ?? process.execPath;
  if (launcher.length !== 2 || launcher[0] !== execPath) return launcher;
  const node = onPath("node", realOr(execPath), opts.pathEnv ?? process.env.PATH ?? "");
  return node ? [node, launcher[1]!] : launcher;
}

/** `<launcher> <args>`, shell-quoted: a command that works from any shell. */
export function launcherCommand(launcher: string[], args: string): string {
  return `${launcher.map(shq).join(" ")} ${args}`;
}

/** The command to print: `tidegap usage install-hook` when the `tidegap` on PATH is this install, else the absolute form. */
export function installHookCommand(launcher: string[], opts: { pathEnv?: string } = {}): string {
  const script = launcher[launcher.length - 1];
  if (script && onPath("tidegap", realOr(script), opts.pathEnv ?? process.env.PATH ?? "")) return "tidegap usage install-hook";
  return launcherCommand(launcher, "usage install-hook");
}

/** One line on what this machine's statusLine does for Tidegap, and the command that fixes it. */
export function statuslineStatus(insp: StatuslineInspection, command: string): string {
  switch (insp.state) {
    case "connected":
      return "connected (the statusLine runs the Tidegap usage hook).";
    case "absent":
      return `not connected (no statusLine in ${SETTINGS_SHOWN}). To connect, run: ${command}`;
    case "other":
      return `not connected (your own statusLine; the hook wraps it, so it keeps working). To connect, run: ${command}`;
    case "legacy":
      return `the Tidegap hook is from an older version. To reconnect, run: ${command}`;
    case "stale":
      return `the Tidegap hook points at an old install. To reconnect, run: ${command}`;
    default:
      return `Tidegap cannot read ${SETTINGS_SHOWN}: ${insp.reason}. Fix the file, then run: ${command}`;
  }
}

export type OfferOutcome = RegisterOutcome | { ok: true; result: "declined" };

/** The terminal question of `tidegap install`: it shows what will change, and only a yes writes. */
export async function offerStatuslineHook(opts: {
  launcher: string[];
  confirm: (question: string) => Promise<boolean>;
  settingsPath?: string;
}): Promise<OfferOutcome> {
  const insp = inspectStatusline(opts.settingsPath);
  const plan = planHook(insp, opts.launcher);
  if (!plan) return unreadable(insp);
  if (!plan.command) return { ok: true, result: plan.result };
  const action =
    plan.result === "wrapped"
      ? "Wrap your Claude Code statusLine in the Tidegap usage hook (your status line keeps working)"
      : plan.result === "updated"
        ? "Update the Tidegap usage hook in your Claude Code statusLine"
        : "Register the Tidegap usage hook as the Claude Code statusLine";
  const question = `${action} so Tidegap sees your subscription limits?\n  ${insp.path}: ${plan.command}\n[y/N] `;
  if (!(await opts.confirm(question))) return { ok: true, result: "declined" };
  // Claude Code may have rewritten the file while the question waited.
  return registerHook({ launcher: opts.launcher, inspection: insp });
}

const DONE: Record<HookResult, string> = {
  registered: "Registered the Tidegap usage hook as the Claude Code statusLine.",
  wrapped: "Wrapped your Claude Code statusLine in the Tidegap usage hook; it keeps working.",
  updated: "Updated the Tidegap usage hook in your Claude Code statusLine.",
  already: "The Tidegap usage hook is already the Claude Code statusLine.",
};

/** The one-line answer for a register result. */
export function registeredText(r: { result: HookResult; backup?: string }): string {
  const after = r.result === "already" ? "" : " Tidegap reads your limits after Claude Code's next reply.";
  return `${DONE[r.result]}${after}${r.backup ? ` Backup: ${r.backup}` : ""}`;
}

/**
 * After `tidegap install`: in a terminal, ask whether to register the hook;
 * without one, print the state and the command, and write nothing. Never
 * fails install.
 */
export async function offerStatuslineInteractive(
  launcher: string[],
  opts: { settingsPath?: string; pathEnv?: string } = {},
): Promise<void> {
  const insp = inspectStatusline(opts.settingsPath);
  const command = installHookCommand(launcher, opts);
  const status = `Claude Code limits: ${statuslineStatus(insp, command)}`;
  if (!process.stdin.isTTY || !process.stdout.isTTY || insp.state === "connected" || insp.state === "unreadable") {
    // eslint-disable-next-line no-console
    console.log(status);
    return;
  }
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let text: string;
  try {
    const r = await offerStatuslineHook({
      launcher,
      ...(opts.settingsPath ? { settingsPath: opts.settingsPath } : {}),
      confirm: async (q) => /^y(es)?$/i.test((await rl.question(`\n${q}`)).trim()),
    });
    if (!r.ok) text = `${r.rule} Run later: ${command}`;
    else if (r.result === "declined") text = `Skipped. To connect later, run: ${command}`;
    else text = registeredText(r);
  } catch {
    text = `Could not update the Claude Code settings. Run later: ${command}`;
  } finally {
    rl.close();
  }
  // eslint-disable-next-line no-console
  console.log(text);
}
