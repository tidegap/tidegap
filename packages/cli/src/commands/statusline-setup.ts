/**
 * Offer to register `tidegap usage hook` as the Claude Code statusLine
 * command (D1). Writes `~/.claude/settings.json` only after the user's yes;
 * an existing statusLine command is kept and wrapped (`usage hook -- sh -c
 * '<old command>'`), so the user's statusline still prints. The old file is
 * copied to `settings.json.tidegap.bak` first, and the new one keeps its mode
 * (it can hold `env` secrets) and replaces the target of a symlink, not the
 * link.
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Shell-quote one token. */
function shq(s: string): string {
  return /^[A-Za-z0-9_./:@%+=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export function claudeSettingsPath(home: string = homedir()): string {
  return join(home, ".claude", "settings.json");
}

/** The statusLine command: the hook, wrapping `existing` when there is one. */
export function statuslineCommand(launcher: string[], existing?: string): string {
  const hook = `${launcher.map(shq).join(" ")} usage hook`;
  return existing ? `${hook} -- sh -c ${shq(existing)}` : hook;
}

/** The manual snippet for `~/.claude/settings.json`. */
export function statuslineSnippet(launcher: string[] = ["tidegap"]): string {
  return JSON.stringify({ statusLine: { type: "command", command: statuslineCommand(launcher) } }, null, 2);
}

export type StatuslineSetupResult =
  | { status: "registered"; command: string }
  | { status: "already" }
  | { status: "declined" }
  | { status: "unreadable"; reason: string };

export async function offerStatuslineHook(opts: {
  launcher: string[];
  confirm: (question: string) => Promise<boolean>;
  settingsPath?: string;
}): Promise<StatuslineSetupResult> {
  const path = opts.settingsPath ?? claudeSettingsPath();
  let settings: Record<string, unknown> = {};
  const readRaw = () => (existsSync(path) ? readFileSync(path, "utf8") : undefined);
  const raw = readRaw();
  if (raw !== undefined) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not a JSON object");
      settings = parsed as Record<string, unknown>;
    } catch (err) {
      return { status: "unreadable", reason: `${path}: ${(err as Error).message}` };
    }
  }
  const current = settings.statusLine as { type?: unknown; command?: unknown } | undefined;
  const existing = typeof current?.command === "string" && current.command.trim() ? current.command : undefined;
  if (existing && /\busage hook\b/.test(existing)) return { status: "already" };
  const command = statuslineCommand(opts.launcher, existing);
  const action = existing
    ? "Wrap your Claude Code statusLine in `tidegap usage hook`"
    : "Register `tidegap usage hook` as the Claude Code statusLine";
  const question = `${action} so Tidegap sees your subscription limits?\n  ${path}: ${command}\n[y/N] `;
  if (!(await opts.confirm(question))) return { status: "declined" };
  // Claude Code may have rewritten the file while the question waited.
  if (readRaw() !== raw) return { status: "unreadable", reason: `${path}: changed while waiting for the answer` };
  const next = { ...settings, statusLine: { ...(current ?? {}), type: "command", command } };
  writeSettings(path, `${JSON.stringify(next, null, 2)}\n`);
  return { status: "registered", command };
}

/** Backup, then an atomic write that keeps the file's mode and symlink. */
function writeSettings(path: string, text: string): void {
  let target = path;
  let mode = 0o600;
  if (existsSync(path)) {
    target = realpathSync(path);
    mode = statSync(target).mode & 0o777;
    copyFileSync(target, `${target}.tidegap.bak`);
    chmodSync(`${target}.tidegap.bak`, mode);
  } else {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }
  const tmp = `${target}.tidegap.tmp`;
  writeFileSync(tmp, text, { encoding: "utf8", mode });
  chmodSync(tmp, mode);
  renameSync(tmp, target);
}

/**
 * After `tidegap install`: ask (terminal only) whether to register the
 * statusLine hook; otherwise print the manual snippet. Never fails install.
 */
export async function offerStatuslineInteractive(launcher: string[]): Promise<void> {
  const manual = `\nClaude Code limits: to let Tidegap see them, add to ~/.claude/settings.json:\n${statuslineSnippet()}`;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    // eslint-disable-next-line no-console
    console.log(manual);
    return;
  }
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let text: string;
  try {
    const r = await offerStatuslineHook({
      launcher,
      confirm: async (q) => /^y(es)?$/i.test((await rl.question(`\n${q}`)).trim()),
    });
    switch (r.status) {
      case "registered":
        text = "Registered the statusLine hook. Tidegap reads your limits after Claude Code's next reply.";
        break;
      case "already":
        text = "The statusLine hook is already registered.";
        break;
      case "unreadable":
        text = `Could not read ${r.reason}; left it unchanged.${manual}`;
        break;
      default:
        text = `Skipped.${manual}`;
    }
  } catch (err) {
    text = `Could not update the Claude Code settings: ${(err as Error).message}${manual}`;
  } finally {
    rl.close();
  }
  // eslint-disable-next-line no-console
  console.log(text);
}
