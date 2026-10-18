/**
 * `@tidegap/cli/session`: which Claude Code session queued a task, and
 * whether its run can resume a copy of that session. Shared by the MCP
 * server (capture and the `runs_in:` reply) and the claude-code adapter.
 */

export { defaultPs, findAncestorPid, readCapture, sessionsDir } from "./capture.js";
export type { AncestorOptions, CapturedSession, PsEntry, PsRunner } from "./capture.js";
export { derivedTranscriptPath, estimateContextTokens, nodeSessionFs, TAIL_BYTES } from "./estimate.js";
export type { SessionFs } from "./estimate.js";
export {
  DEFAULT_RESUME_MAX_TOKENS,
  describeRunsIn,
  effectiveTools,
  isClaudeOrigin,
  planRun,
  resumeSettings,
} from "./plan.js";
export type { PlanInput, ResumeSettings, RunOrigin, RunPlan } from "./plan.js";
