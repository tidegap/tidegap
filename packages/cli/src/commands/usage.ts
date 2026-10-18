/**
 * `tidegap usage [--json] [--spend]`: Claude subscription limits (5-hour,
 * weekly, per-model) with their resets, the Codex limits from its local
 * logs, and with `--spend` the current window's tokens and cost estimate. `tidegap usage hook [-- <command>...]`: the
 * Claude Code statusLine command that records them (D1). Always exits 0 for
 * a read: an unavailable state is reported, not an error.
 */

import { stripControlChars } from "@tidegap/core";

import { readUsageEnv } from "../env.js";
import {
  clockLabel,
  readUsageDocument,
  resolveUsageSettings,
  runStatuslineHook,
  windowLabel,
  type ClaudeSpend,
  type CodexUsage,
  type LimitWindow,
  type SpendRow,
  type UsageDocument,
  type UsageDocumentOptions,
} from "../usage/index.js";

export interface UsageCommandOptions extends UsageDocumentOptions {
  json?: boolean;
}

function ago(s: number | undefined): string {
  if (s === undefined) return "";
  if (s < 90) return `${s} s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
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
  const lines = [`Codex limits (${codex.plan_type ? stripControlChars(codex.plan_type) : "plan unknown"}, as of ${at ? clockLabel(at, now) : "?"})`];
  for (const [label, w] of [["5h", codex.five_hour], ["7d", codex.seven_day]] as const) {
    if (!w) continue;
    const used = w.pct === null ? "?" : `${Math.round(w.pct)}%`;
    const resets = w.state === "reset_since_seen" ? "reset since seen" : clockLabel(new Date(w.resets_at), now);
    lines.push(`${label.padEnd(10)}${used.padEnd(7)}${resets}`);
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
