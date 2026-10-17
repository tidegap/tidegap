/**
 * The two calls a host makes: read the limit state with its settings, and
 * resolve "after the limit reset" (KTD5) with the one past-reset re-read.
 */

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
