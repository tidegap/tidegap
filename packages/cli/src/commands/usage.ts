/**
 * `tidegap usage [--json] [--spend]`: Claude subscription limits (5-hour,
 * weekly, per-model) with their resets, the Codex limits from its local
 * logs, and with `--spend` the current window's tokens and cost estimate. `tidegap usage hook [-- <command>...]`: the
 * Claude Code statusLine command that records them (D1). `tidegap usage
 * install-hook [--dry-run] [--remove]`: register that hook (wrapping the
 * user's own statusLine) or remove it. Always exits 0 for a read: an
 * unavailable state is reported, not an error.
 */

import { stripControlChars } from "@tidegap/core";

import { readUsageEnv } from "../env.js";
import { resolveLauncher } from "./install.js";
import {
  claudeSettingsPath,
  hookLauncher,
  inspectStatusline,
  installHookCommand,
  planHook,
  registeredText,
  registerHook,
  removeHook,
  statuslineStatus,
} from "./statusline-setup.js";
import {
  clockLabel,
  readUsageDocument,
  resolveUsageSettings,
  runStatuslineHook,
  windowLabel,
  type ClaudeSpend,
  type CodexUsage,
  type CodexWindow,
  type LimitWindow,
  type SpendRow,
  type UsageDocument,
  type UsageDocumentOptions,
} from "../usage/index.js";

export interface UsageCommandOptions extends UsageDocumentOptions {
  json?: boolean;
  /** Claude Code's settings file, for the next step after no reading; default `~/.claude/settings.json`. */
  settingsPath?: string;
  /** The launcher the next step's command names; default this install's. */
  launcher?: string[];
}

/** This install's launcher, as the hook stores it. */
function thisLauncher(): string[] {
  return hookLauncher(resolveLauncher(undefined, []));
}

function ago(s: number | undefined): string {
  if (s === undefined) return "";
  const min = Math.round(s / 60);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

function claudeLines(doc: UsageDocument, now: Date): string[] {
  const state = doc.claude;
  if (state.status === "disabled") return ["Claude limits: off (TIDEGAP_USAGE=off)"];
  if (state.status === "unavailable") return [`Claude limits: unavailable: ${state.error?.message ?? "no data"}`];
  const lines: string[] = [];
  const asOf = state.fetched_at ? `${clockLabel(new Date(state.fetched_at), now)}, ${ago(state.age_s)}` : "";
  lines.push(`Claude limits (source: ${state.source}, as of ${asOf})`);
  if (state.error) lines.push(`last good value; ${state.error.message}`);
  const rows: Array<[string, LimitWindow]> = [];
  if (state.five_hour) rows.push(["five_hour", state.five_hour]);
  if (state.seven_day) rows.push(["seven_day", state.seven_day]);
  for (const s of state.scoped) rows.push([s.model, s]);
  lines.push(`${"window".padEnd(10)}${"used".padEnd(7)}resets`);
  for (const [name, w] of rows) {
    const passed = Date.parse(w.resets_at) <= now.getTime();
    const resets = passed ? "reset since seen" : clockLabel(new Date(w.resets_at), now);
    lines.push(`${stripControlChars(windowLabel(name)).padEnd(10)}${`${Math.round(w.pct)}%`.padEnd(7)}${resets}`);
  }
  if (doc.target_reset) {
    const t = doc.target_reset;
    lines.push(
      `after limit reset: ${clockLabel(new Date(t.at), now)} (${windowLabel(t.window)} window${t.exhausted ? ", exhausted" : ""})`,
    );
  }
  return lines;
}

function codexLines(codex: CodexUsage | undefined, now: Date): string[] {
  if (!codex || codex.status === "not_found") return [];
  if (codex.status === "no_limits") return ["Codex limits: no reading in the Codex logs yet"];
  const at = codex.as_of ? new Date(codex.as_of) : undefined;
  const plan = codex.plan_type ? stripControlChars(codex.plan_type) : "plan unknown";
  const windows: Array<[string, CodexWindow]> = [];
  if (codex.five_hour) windows.push(["5h", codex.five_hour]);
  if (codex.seven_day) windows.push(["7d", codex.seven_day]);
  const lines: string[] = [];
  if (windows.length && windows.every(([, w]) => w.pct === null)) {
    // Every window has reset since the reading: one line with its age, no rows (KTD3).
    const ageS = at ? Math.round((now.getTime() - at.getTime()) / 1000) : NaN;
    const age = ageS >= 60 ? ago(ageS) : "";
    lines.push(`Codex limits (${plan}): ${age ? `no reading for ${age.slice(0, -" ago".length)}` : "no current reading"}`);
  } else {
    lines.push(`Codex limits (${plan}, as of ${at ? clockLabel(at, now) : "?"})`);
    for (const [label, w] of windows) {
      const used = w.pct === null ? "?" : `${Math.round(w.pct)}%`;
      const resets = w.state === "reset_since_seen" ? "reset since seen" : clockLabel(new Date(w.resets_at), now);
      lines.push(`${label.padEnd(10)}${used.padEnd(7)}${resets}`);
    }
  }
  for (const s of codex.sessions ?? []) {
    lines.push(`  session ${s.session_id.slice(0, 8)}  ${tokens(s.tokens.total)} tokens, last ${clockLabel(new Date(s.last_activity), now)}`);
  }
  return lines;
}

function tokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

function cost(r: SpendRow): string {
  return r.cost_usd === null ? "no price" : `$${r.cost_usd.toFixed(2)}`;
}

function spendRow(label: string, r: SpendRow): string {
  return `${label.padEnd(22)}in ${tokens(r.input).padEnd(7)}out ${tokens(r.output).padEnd(7)}cache w ${tokens(r.cache_write).padEnd(7)}r ${tokens(r.cache_read).padEnd(7)}${cost(r)}`;
}

function spendLines(spend: ClaudeSpend, now: Date): string[] {
  const lines = [`Claude spend since ${clockLabel(new Date(spend.window.start), now)} (${spend.window.label}; ${spend.note})`];
  lines.push(spendRow("total", spend.total));
  for (const m of spend.by_model) lines.push(spendRow(`  ${stripControlChars(m.model)}`, m));
  for (const s of spend.sessions) {
    lines.push(spendRow(`  ${s.session_id.slice(0, 8)} ${clockLabel(new Date(s.last_activity), now)}`, s));
  }
  if (spend.truncated) lines.push(`partial: the scan stopped at its ${spend.truncated} cap; the oldest logs are not counted`);
  if (spend.unpriced_models.length) lines.push(`no price for: ${spend.unpriced_models.map((m) => stripControlChars(m)).join(", ")}`);
  return lines;
}

export async function runUsage(opts: UsageCommandOptions = {}): Promise<string> {
  const { json, ...read } = opts;
  const now = read.now ?? new Date();
  const doc = await readUsageDocument({ env: readUsageEnv(), ...read, now });
  if (json) return JSON.stringify(doc, null, 2);
  const lines = claudeLines(doc, now);
  if (doc.claude.status === "unavailable" && doc.claude.error?.cause === "no_data") {
    // No reading at all: say what this machine's statusLine is missing, and the fix.
    const insp = inspectStatusline(opts.settingsPath ?? claudeSettingsPath());
    lines.push(`Claude Code status line: ${statuslineStatus(insp, installHookCommand(opts.launcher ?? thisLauncher()))}`);
  }
  const codex = codexLines(doc.codex, now);
  if (codex.length) lines.push("", ...codex);
  if (doc.claude_spend) lines.push("", ...spendLines(doc.claude_spend, now));
  return lines.join("\n");
}

/** A statusline input arrives at once; never wait longer than this for it. */
const STDIN_WAIT_MS = 2_000;

/** All of stdin, or what arrived before EOF, an error or the wait ran out. */
function readStdin(waitMs: number = STDIN_WAIT_MS): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise((done) => {
    const chunks: Buffer[] = [];
    const finish = () => {
      clearTimeout(timer);
      process.stdin.off("data", onData).off("end", finish).off("error", finish);
      process.stdin.pause();
      done(Buffer.concat(chunks).toString("utf8"));
    };
    const onData = (chunk: Buffer) => chunks.push(chunk);
    const timer = setTimeout(() => {
      finish();
      process.stdin.destroy();
    }, waitMs);
    process.stdin.on("data", onData).once("end", finish).once("error", finish);
  });
}

/**
 * `tidegap usage hook [-- <command> [args...]]`. Resolves to the exit code.
 * Never throws: a bad input, an unreadable config or a stdin error still
 * runs the wrapped command, so the user's statusline keeps printing.
 */
export async function runUsageHook(wrapped: string[]): Promise<number> {
  let stdin = "";
  let settings = { disabled: true, oauth: false };
  try {
    stdin = await readStdin();
    settings = resolveUsageSettings(readUsageEnv());
  } catch {
    // Record nothing; still run the wrapped command.
  }
  return runStatuslineHook(stdin, wrapped, { settings });
}

export interface InstallHookOptions {
  dryRun?: boolean;
  remove?: boolean;
  /** Default this install's launcher. */
  launcher?: string[];
  /** Default `~/.claude/settings.json`. */
  settingsPath?: string;
}

/**
 * `tidegap usage install-hook [--dry-run] [--remove]`. One line per outcome;
 * exit 0 when it registered, wrapped, updated, found it already there or
 * had nothing to remove; 1 when the file is unreadable or changed meanwhile.
 */
export function runUsageInstallHook(opts: InstallHookOptions = {}): { out: string; exitCode: number } {
  const path = opts.settingsPath ?? claudeSettingsPath();
  try {
    return installHook(path, opts);
  } catch (err) {
    // A failed write leaves the file as it was; the errno code, never a stack.
    return { out: `Tidegap could not update ${path} (${(err as NodeJS.ErrnoException).code ?? "error"}); it is unchanged.`, exitCode: 1 };
  }
}

function installHook(path: string, opts: InstallHookOptions): { out: string; exitCode: number } {
  const insp = inspectStatusline(path);
  if (opts.remove) {
    const r = removeHook({ inspection: insp });
    if (!r.ok) return { out: r.rule, exitCode: 1 };
    if (r.result === "none") return { out: `No Tidegap usage hook in ${path}; nothing to remove.`, exitCode: 0 };
    const restored = r.restored === undefined ? "" : "; your own statusLine command is back";
    return { out: `Removed the Tidegap usage hook from ${path}${restored}.${r.backup ? ` Backup: ${r.backup}` : ""}`, exitCode: 0 };
  }
  const launcher = opts.launcher ?? thisLauncher();
  if (opts.dryRun) {
    const plan = planHook(insp, launcher);
    const state = `statusLine in ${path}: ${insp.state}${insp.reason ? ` (${insp.reason})` : ""}`;
    if (!plan) return { out: state, exitCode: 1 };
    return { out: `${state}\n${plan.command ? `would store: ${plan.command}` : "nothing to change"}`, exitCode: 0 };
  }
  const r = registerHook({ launcher, inspection: insp });
  if (!r.ok) return { out: r.rule, exitCode: 1 };
  return { out: registeredText({ ...r, path }), exitCode: 0 };
}
