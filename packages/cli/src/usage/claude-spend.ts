/**
 * Claude Code spend in the current 5-hour window (KTD8, R5), from the local
 * JSONL session logs. Computed only on request: the scan reads every log
 * file touched since the window start, newest first.
 *
 * Each log is append-only and in time order, so a binary search skips the
 * part written before the window; the per-line timestamp test still holds.
 *
 * Window start: `five_hour.resets_at - 5 h` when that window is known and
 * current, else the last 5 hours ("trailing 5 h"). Cost is an API
 * list-price estimate from `prices.json`, not what the subscription bills.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { priceForModel } from "@tidegap/core";

import { firstOffsetAtOrAfter, markedLines, nodeUsageFs, type UsageFs } from "./files.js";
import type { ClaudeLimitState } from "./types.js";

const FIVE_H_MS = 5 * 3_600_000;
/** Sessions listed, most recent first. */
const SESSIONS_MAX = 5;
/** Anthropic's published cache multipliers on the input rate. */
const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2;
const CACHE_READ = 0.1;

export const SPEND_NOTE = "API list-price estimate, not billed";

export interface TokenCounts {
  input: number;
  output: number;
  cache_write: number;
  cache_read: number;
}

/** Tokens and their cost; `cost_usd` is null when no token of the row has a price. */
export interface SpendRow extends TokenCounts {
  cost_usd: number | null;
}

export interface ClaudeSpend {
  window: { start: string; basis: "five_hour" | "trailing_5h"; label: string };
  total: SpendRow;
  by_model: Array<SpendRow & { model: string }>;
  sessions: Array<SpendRow & { session_id: string; project: string; last_activity: string }>;
  /** Models with tokens but no price: their tokens count, their cost does not. */
  unpriced_models: string[];
  files_scanned: number;
  note: typeof SPEND_NOTE;
}

export interface SpendOptions {
  now?: Date;
  /** `CLAUDE_CONFIG_DIR`: when set, only `<it>/projects` is scanned. */
  claudeConfigDir?: string;
  home?: string;
  fs?: UsageFs;
}

/** The window the spend counts: from the 5-hour limit when known, else the last 5 hours. */
export function spendWindow(state: ClaudeLimitState, now: Date): ClaudeSpend["window"] {
  const reset = state.status === "ok" && state.five_hour ? Date.parse(state.five_hour.resets_at) : Number.NaN;
  if (Number.isFinite(reset) && reset > now.getTime()) {
    return { start: new Date(reset - FIVE_H_MS).toISOString(), basis: "five_hour", label: "current 5 h window" };
  }
  return { start: new Date(now.getTime() - FIVE_H_MS).toISOString(), basis: "trailing_5h", label: "trailing 5 h" };
}

function projectRoots(opts: SpendOptions): string[] {
  const dir = opts.claudeConfigDir?.trim();
  if (dir) return [join(dir, "projects")];
  const home = opts.home ?? homedir();
  return [join(home, ".claude", "projects"), join(home, ".config", "claude", "projects")];
}

interface LogFile {
  path: string;
  mtimeMs: number;
  size: number;
  session: string;
  project: string;
}

/** Session logs and their subagent logs touched at or after `startMs`, newest first. */
function logFiles(fs: UsageFs, roots: string[], startMs: number): LogFile[] {
  const out: LogFile[] = [];
  const add = (path: string, session: string, project: string) => {
    const st = fs.stat(path);
    if (st && !st.dir && st.mtimeMs >= startMs) out.push({ path, mtimeMs: st.mtimeMs, size: st.size, session, project });
  };
  for (const root of roots) {
    for (const project of fs.readdir(root)) {
      const pdir = join(root, project);
      for (const name of fs.readdir(pdir)) {
        if (name.endsWith(".jsonl")) {
          add(join(pdir, name), name.slice(0, -".jsonl".length), project);
          continue;
        }
        // `<sessionId>/subagents/*.jsonl` counts under its parent session.
        const sub = join(pdir, name, "subagents");
        for (const f of fs.readdir(sub)) if (f.endsWith(".jsonl")) add(join(sub, f), name, project);
      }
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

interface Acc extends TokenCounts {
  cost: number;
  priced: boolean;
}

const emptyAcc = (): Acc => ({ input: 0, output: 0, cache_write: 0, cache_read: 0, cost: 0, priced: false });

function addTo(acc: Acc, t: TokenCounts, cost: number | null): void {
  acc.input += t.input;
  acc.output += t.output;
  acc.cache_write += t.cache_write;
  acc.cache_read += t.cache_read;
  if (cost !== null) {
    acc.cost += cost;
    acc.priced = true;
  }
}

function row(acc: Acc): SpendRow {
  return {
    input: acc.input,
    output: acc.output,
    cache_write: acc.cache_write,
    cache_read: acc.cache_read,
    cost_usd: acc.priced ? Math.round(acc.cost * 1e6) / 1e6 : null,
  };
}

/** One line's tokens and list-price cost (null for a model with no price). */
export function lineCost(model: string, u: Usage): { tokens: TokenCounts; cost: number | null } {
  const write = num(u.cache_creation_input_tokens);
  const w1h = Math.min(write, num(u.cache_creation?.ephemeral_1h_input_tokens));
  const tokens = {
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cache_write: write,
    cache_read: num(u.cache_read_input_tokens),
  };
  const price = model ? priceForModel(model) : undefined;
  if (!price) return { tokens, cost: null };
  const inRate = price.inUsdPerMtok / 1e6;
  const cost =
    tokens.input * inRate +
    tokens.output * (price.outUsdPerMtok / 1e6) +
    (write - w1h) * inRate * CACHE_WRITE_5M +
    w1h * inRate * CACHE_WRITE_1H +
    tokens.cache_read * inRate * CACHE_READ;
  return { tokens, cost };
}

interface AssistantLine {
  type?: string;
  timestamp?: string;
  requestId?: string;
  message?: { id?: string; model?: string; usage?: Usage };
}

export async function readClaudeSpend(state: ClaudeLimitState, opts: SpendOptions = {}): Promise<ClaudeSpend> {
  const now = opts.now ?? new Date();
  const fs = opts.fs ?? nodeUsageFs;
  const window = spendWindow(state, now);
  const startMs = Date.parse(window.start);
  const files = logFiles(fs, projectRoots(opts), startMs);
  const total = emptyAcc();
  const models = new Map<string, Acc>();
  const sessions = new Map<string, Acc & { project: string; last: number }>();
  const unpriced = new Set<string>();
  const seen = new Set<string>();

  for (const file of files) {
    // Logs are append-only: skip the part written before the window.
    const from = firstOffsetAtOrAfter(fs, file.path, file.size, startMs);
    // Only lines with a usage object are decoded; most bytes are tool output.
    for (const text of markedLines(fs, file.path, '"usage":{', from)) {
      if (!text.includes('"assistant"')) continue;
      let line: AssistantLine;
      try {
        line = JSON.parse(text) as AssistantLine;
      } catch {
        continue;
      }
      const u = line.message?.usage;
      if (line.type !== "assistant" || !u) continue;
      const ts = Date.parse(line.timestamp ?? "");
      if (!Number.isFinite(ts) || ts < startMs) continue;
      // One API response is written once per content block: count it once.
      if (line.message?.id && line.requestId) {
        const key = `${line.message.id}\u0000${line.requestId}`;
        if (seen.has(key)) continue;
        seen.add(key);
      }
      const model = line.message?.model ?? "unknown";
      // Claude Code's own placeholder replies: no API call, no tokens.
      if (model === "<synthetic>") continue;
      const { tokens, cost } = lineCost(model, u);
      if (cost === null) unpriced.add(model);
      addTo(total, tokens, cost);
      if (!models.has(model)) models.set(model, emptyAcc());
      addTo(models.get(model)!, tokens, cost);
      let s = sessions.get(file.session);
      if (!s) sessions.set(file.session, (s = { ...emptyAcc(), project: file.project, last: ts }));
      addTo(s, tokens, cost);
      s.last = Math.max(s.last, ts);
    }
  }

  return {
    window,
    total: row(total),
    by_model: [...models]
      .map(([model, acc]) => ({ model, ...row(acc) }))
      .sort((a, b) => (b.cost_usd ?? 0) - (a.cost_usd ?? 0) || b.output - a.output),
    sessions: [...sessions]
      .sort((a, b) => b[1].last - a[1].last)
      .slice(0, SESSIONS_MAX)
      .map(([id, s]) => ({
        session_id: id,
        project: s.project,
        last_activity: new Date(s.last).toISOString(),
        ...row(s),
      })),
    unpriced_models: [...unpriced].sort(),
    files_scanned: files.length,
    note: SPEND_NOTE,
  };
}
