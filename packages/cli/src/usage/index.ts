/**
 * `@tidegap/cli/usage`: Claude subscription limit state for every Tidegap
 * host (CLI, MCP server, tick). Read-only towards Claude Code.
 */

export type {
  ClaudeLimits,
  ClaudeLimitState,
  LimitCause,
  LimitWindow,
  ScopedWindow,
  UsageEnv,
  UsageSettings,
} from "./types.js";
export { resolveUsageSettings } from "./settings.js";
export { readUsageCache, usageCachePath, writeUsageCache } from "./cache.js";
export type { UsageCacheFile } from "./cache.js";
export { limitsFromStatusline, recordStatusline, runStatuslineHook } from "./statusline.js";
export { keychainServiceNames, readClaudeToken } from "./credentials.js";
export type { CredentialDeps, SecurityRunner } from "./credentials.js";
export { fetchClaudeUsage, normalizeUsage, USAGE_URL } from "./claude-limits.js";
export type { FetchLike } from "./claude-limits.js";
export { CAUSE_TEXT, EXPLICIT_TTL_S, readClaudeLimits } from "./limits.js";
export type { ReadLimitsOptions } from "./limits.js";
export { resetTarget, resolveResetTarget, unavailableReason } from "./target.js";
export type { ResetTarget, TargetResult } from "./target.js";
export { buildUsageDocument, clockLabel, formatLine, windowLabel } from "./document.js";
export type { UsageDocument } from "./document.js";
export { hostResetTarget, readHostLimits } from "./host.js";
export type { HostLimitsOptions } from "./host.js";
