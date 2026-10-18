/**
 * `@tidegap/cli/usage`: Claude subscription limit state, Claude Code spend
 * and Codex limits for every Tidegap host (CLI, MCP server, tick, `tidegap
 * ui`). Read-only towards Claude Code and Codex.
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
export { buildUsageDocument, clockLabel, formatLine, summaryLimits, windowLabel } from "./document.js";
export type { SummaryLimits, UsageDocument } from "./document.js";
export { deadlineReader, hostResetTarget, readHostLimits, readUsageDocument } from "./host.js";
export type { HostLimitsOptions, UsageDocumentOptions } from "./host.js";
export { lineCost, readClaudeSpend, spendWindow, SPEND_NOTE } from "./claude-spend.js";
export type { ClaudeSpend, SpendOptions, SpendRow, TokenCounts } from "./claude-spend.js";
export { readCodexUsage } from "./codex.js";
export type { CodexOptions, CodexTokens, CodexUsage, CodexWindow } from "./codex.js";
export { nodeUsageFs } from "./files.js";
export type { UsageFs } from "./files.js";
export { usageLimitResetSource } from "./reset-source.js";
