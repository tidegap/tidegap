/**
 * Codex limits and tokens from the local Codex session logs (KTD9, R3, R6).
 * Read-only, and only `<CODEX_HOME>/sessions/`: `auth.json` is never opened.
 *
 * Limits: the last `token_count` event with non-null `rate_limits` in the
 * most recently modified rollout file that has one, whatever its age; `primary` is the
 * 5-hour window, `secondary` the weekly one. Tokens (on request): per
 * rollout file touched in the current 5-hour window, its last
 * `info.total_token_usage`.
 */

import { homedir } from "node:os";
import { basename, join } from "node:path";

import { markedLines, nodeUsageFs, type UsageFs } from "./files.js";

const FIVE_H_MS = 5 * 3_600_000;
const DAY_MS = 86_400_000;
/** Rollout files read for limits before giving up. */
const LIMIT_FILES_MAX = 10;
/** Newest rollout files by path that are ordered by modification time before the read. */
const LIMIT_CANDIDATES = 50;
const SESSIONS_MAX = 5;
/**
 * Only the end of a rollout file is read: the last `token_count` event is
 * what counts, and it is near the end. Bounds the work on a huge log.
 */
const TAIL_BYTES = 32 * 1024 * 1024;

export interface CodexWindow {
  /** Percent used; null once the window has reset since the reading. */
  pct: number | null;
  resets_at: string;
  window_minutes?: number;
  state?: "reset_since_seen";
}

export interface CodexTokens {
  input: number;
  cached_input: number;
  output: number;
  reasoning_output: number;
  total: number;
}

export interface CodexUsage {
  /** `not_found`: no Codex sessions directory or no rollout file; `no_limits`: logs without a limit reading. */
  status: "ok" | "not_found" | "no_limits";
  /** Time of the event the limits come from. */
  as_of?: string;
  plan_type?: string;
  five_hour?: CodexWindow;
  seven_day?: CodexWindow;
  /** With spend only: sessions active in the current 5-hour window, newest first. */
  sessions?: Array<{ session_id: string; last_activity: string; tokens: CodexTokens }>;
}

export interface CodexOptions {
  now?: Date;
  /** `CODEX_HOME`, else `~/.codex`. */
  codexHome?: string;
  home?: string;
  fs?: UsageFs;
  /** Also list the sessions' tokens (the spend scan). */
  spend?: boolean;
}

interface RawWindow {
  used_percent?: unknown;
  resets_at?: unknown;
  window_minutes?: unknown;
}

interface TokenCountEvent {
  timestamp?: string;
  payload?: {
    type?: string;
    info?: { total_token_usage?: Record<string, unknown> } | null;
    rate_limits?: { primary?: RawWindow | null; secondary?: RawWindow | null; plan_type?: unknown } | null;
  };
}

/** Rollout files, newest first by their dated path (`sessions/YYYY/MM/DD/rollout-*.jsonl`). */
function* rolloutFiles(fs: UsageFs, sessions: string, notBeforeDay?: string): Generator<string> {
  const desc = (names: string[]) => names.filter((n) => /^\d+$/.test(n)).sort().reverse();
  for (const y of desc(fs.readdir(sessions))) {
    for (const m of desc(fs.readdir(join(sessions, y)))) {
      for (const d of desc(fs.readdir(join(sessions, y, m)))) {
        if (notBeforeDay && `${y}-${m}-${d}` < notBeforeDay) return;
        const dir = join(sessions, y, m, d);
        const files = fs.readdir(dir).filter((f) => f.startsWith("rollout-") && f.endsWith(".jsonl"));
        for (const f of files.sort().reverse()) yield join(dir, f);
      }
    }
  }
}

function window(raw: RawWindow | null | undefined, now: Date): CodexWindow | undefined {
  if (!raw || typeof raw.resets_at !== "number" || typeof raw.used_percent !== "number") return undefined;
  const resets = new Date(raw.resets_at * 1000);
  if (!Number.isFinite(resets.getTime())) return undefined;
  const minutes = typeof raw.window_minutes === "number" ? { window_minutes: raw.window_minutes } : {};
  if (resets.getTime() <= now.getTime()) {
    return { pct: null, resets_at: resets.toISOString(), ...minutes, state: "reset_since_seen" };
  }
  return { pct: raw.used_percent, resets_at: resets.toISOString(), ...minutes };
}

function parseEvent(text: string): TokenCountEvent | undefined {
  try {
    const ev = JSON.parse(text) as TokenCountEvent;
    return ev.payload?.type === "token_count" ? ev : undefined;
  } catch {
    return undefined;
  }
}

/** The `token_count` lines in the last {@link TAIL_BYTES} of a rollout file. */
function tailTokenCounts(fs: UsageFs, path: string): AsyncIterable<string> {
  const size = fs.stat(path)?.size ?? 0;
  return markedLines(fs, path, '"token_count"', Math.max(0, size - TAIL_BYTES), TAIL_BYTES);
}

const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** `rollout-<time>-<uuid>.jsonl` → the uuid, else the file name. */
function sessionId(path: string): string {
  const name = basename(path, ".jsonl");
  return /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(name)?.[1] ?? name;
}

async function sessionTokens(
  fs: UsageFs,
  sessions: string,
  startMs: number,
): Promise<NonNullable<CodexUsage["sessions"]>> {
  // A session that started a day before the window can still be active in it.
  const firstDay = new Date(startMs - DAY_MS).toISOString().slice(0, 10);
  const active: Array<{ path: string; mtimeMs: number }> = [];
  for (const path of rolloutFiles(fs, sessions, firstDay)) {
    const st = fs.stat(path);
    if (st && st.mtimeMs >= startMs) active.push({ path, mtimeMs: st.mtimeMs });
  }
  active.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const out: NonNullable<CodexUsage["sessions"]> = [];
  for (const f of active.slice(0, SESSIONS_MAX)) {
    let last: Record<string, unknown> | undefined;
    for await (const text of tailTokenCounts(fs, f.path)) {
      const t = parseEvent(text)?.payload?.info?.total_token_usage;
      if (t) last = t;
    }
    if (!last) continue;
    out.push({
      session_id: sessionId(f.path),
      last_activity: new Date(f.mtimeMs).toISOString(),
      tokens: {
        input: n(last.input_tokens),
        cached_input: n(last.cached_input_tokens),
        output: n(last.output_tokens),
        reasoning_output: n(last.reasoning_output_tokens),
        total: n(last.total_tokens),
      },
    });
  }
  return out;
}

export async function readCodexUsage(opts: CodexOptions = {}): Promise<CodexUsage> {
  const now = opts.now ?? new Date();
  const fs = opts.fs ?? nodeUsageFs;
  const root = opts.codexHome?.trim() || join(opts.home ?? homedir(), ".codex");
  const sessions = join(root, "sessions");
  if (!fs.stat(sessions)?.dir) return { status: "not_found" };

  // The path dates a session by its start; a long session started earlier can
  // hold the latest reading, so the newest candidates go by modification time.
  const candidates: Array<{ path: string; mtimeMs: number }> = [];
  for (const path of rolloutFiles(fs, sessions)) {
    if (candidates.length >= LIMIT_CANDIDATES) break;
    candidates.push({ path, mtimeMs: fs.stat(path)?.mtimeMs ?? 0 });
  }
  if (candidates.length === 0) return { status: "not_found" };
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  let found: TokenCountEvent | undefined;
  for (const { path } of candidates.slice(0, LIMIT_FILES_MAX)) {
    for await (const text of tailTokenCounts(fs, path)) {
      const ev = parseEvent(text);
      if (ev?.payload?.rate_limits) found = ev;
    }
    if (found) break;
  }

  const out: CodexUsage = { status: found ? "ok" : "no_limits" };
  if (found) {
    const rl = found.payload!.rate_limits!;
    if (found.timestamp) out.as_of = found.timestamp;
    if (typeof rl.plan_type === "string") out.plan_type = rl.plan_type;
    const five = window(rl.primary, now);
    const seven = window(rl.secondary, now);
    if (five) out.five_hour = five;
    if (seven) out.seven_day = seven;
  }
  if (opts.spend) {
    // The current primary window when the reading still covers it, else the last 5 hours.
    const p = out.five_hour;
    const minutes = p?.window_minutes ?? 300;
    const startMs = p && p.pct !== null ? Date.parse(p.resets_at) - minutes * 60_000 : now.getTime() - FIVE_H_MS;
    out.sessions = await sessionTokens(fs, sessions, startMs);
  }
  return out;
}
