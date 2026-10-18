/**
 * The calls a host makes: read the limit state with its settings, build the
 * whole `usage/v1` document, and resolve "after the limit reset" (KTD5)
 * with the one past-reset re-read.
 */

import { readClaudeSpend } from "./claude-spend.js";
import { readCodexUsage } from "./codex.js";
import { buildUsageDocument, type UsageDocument } from "./document.js";
import type { UsageFs } from "./files.js";
import { readClaudeLimits, type ReadLimitsOptions } from "./limits.js";
import { resolveUsageSettings } from "./settings.js";
import { resolveResetTarget, type TargetResult } from "./target.js";
import type { ClaudeLimitState, UsageEnv } from "./types.js";

export interface HostLimitsOptions extends Omit<ReadLimitsOptions, "settings" | "env"> {
  env?: UsageEnv;
  /** `~/.tidegap/config` override (tests). */
  configPath?: string;
}

export function readHostLimits(opts: HostLimitsOptions = {}): Promise<ClaudeLimitState> {
  const { configPath, env = {}, ...rest } = opts;
  return readClaudeLimits({ ...rest, env, settings: resolveUsageSettings(env, configPath) });
}

export async function hostResetTarget(opts: HostLimitsOptions & { model?: string } = {}): Promise<TargetResult> {
  const { model, ...read } = opts;
  const now = read.now ?? new Date();
  const state = await readHostLimits({ ...read, now });
  return resolveResetTarget(state, { now, model, reread: () => readHostLimits({ ...read, now, force: true }) });
}

export interface UsageDocumentOptions extends HostLimitsOptions {
  /** Add `claude_spend` and the Codex sessions' tokens (the JSONL scan). */
  spend?: boolean;
  /** Read the Codex logs. Default true. */
  codex?: boolean;
  /** Home directory of the log scans (tests). */
  home?: string;
  fs?: UsageFs;
}

/** The `usage/v1` document of this machine: Claude limits, Codex, and spend on request. */
export async function readUsageDocument(opts: UsageDocumentOptions = {}): Promise<UsageDocument> {
  const { spend = false, codex = true, home, fs, ...read } = opts;
  const now = read.now ?? new Date();
  const env = read.env ?? {};
  const state = await readHostLimits({ ...read, now });
  const [claudeSpend, codexUsage] = await Promise.all([
    spend ? readClaudeSpend(state, { now, claudeConfigDir: env.claudeConfigDir, home, fs }) : undefined,
    codex ? readCodexUsage({ now, codexHome: env.codexHome, home, fs, spend }) : undefined,
  ]);
  return buildUsageDocument(state, now, { claudeSpend, codex: codexUsage });
}

/** One call in flight at a time: concurrent callers share it; the next call after it settles starts a new one. */
export function singleFlight<T>(read: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | undefined;
  return () =>
    (inFlight ??= read().finally(() => {
      inFlight = undefined;
    }));
}

/**
 * A read that answers within `deadlineMs` (the `/api/summary` path): one
 * read in flight at a time, shared by concurrent callers, and on the
 * deadline the last finished result. A Keychain prompt or a slow usage API
 * then never holds a poll; the read finishes in the background and the next
 * poll gets it. A failed read also falls back to the last result; with none,
 * it rejects.
 */
export function deadlineReader<T>(read: () => Promise<T>, deadlineMs: number): () => Promise<T> {
  let last: { value: T } | undefined;
  const shared = singleFlight(() =>
    read().then((value) => {
      last = { value };
      return value;
    }),
  );
  return () => {
    const current = shared().catch((err: unknown) => {
      if (last) return last.value;
      throw err;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => (last ? resolve(last.value) : reject(new Error("usage read timed out"))), deadlineMs);
      timer.unref?.();
    });
    // A read that loses the race keeps running; its rejection is handled by the race.
    return Promise.race([current, late]).finally(() => clearTimeout(timer));
  };
}

/** What `tidegap ui` serves: `/api/summary` reads and `/api/usage` reads (spend on request). */
export type UsageProvider = (opts: { spend: boolean; summary: boolean }) => Promise<UsageDocument>;

/**
 * The `tidegap ui` usage reads. `/api/summary` is polled: its read skips
 * Codex, waits at most `summaryDeadlineMs` (a Keychain read alone can take
 * 5 s) and otherwise gets the last finished reading. `/api/usage` reads share
 * one read in flight per kind, so repeated clicks or polls never start
 * overlapping log scans.
 */
export function usageProvider(base: UsageDocumentOptions, summaryDeadlineMs: number): UsageProvider {
  const summary = deadlineReader(
    // The usage API gets 3/4 of the deadline, so its own timeout still yields the cached last good value.
    () => readUsageDocument({ ...base, spend: false, codex: false, timeoutMs: Math.floor(summaryDeadlineMs * 0.75) }),
    summaryDeadlineMs,
  );
  const plain = singleFlight(() => readUsageDocument({ ...base, spend: false }));
  const withSpend = singleFlight(() => readUsageDocument({ ...base, spend: true }));
  return (opts) => (opts.summary ? summary() : opts.spend ? withSpend() : plain());
}
