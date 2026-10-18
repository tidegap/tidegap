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
