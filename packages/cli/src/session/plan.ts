/**
 * Fork or fresh (KTD8): the one rule the MCP reply (at queue time) and the
 * claude-code adapter (at the clean hour) both apply. Pure apart from the
 * injected file-system reader.
 */

import {
  DEFAULT_ORIGIN_TOOLS,
  freshReasonText,
  includesWebTool,
  shortSessionId,
  tokensLabel,
  type FreshReason,
  type RunSessionMode,
} from "@tidegap/core";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { derivedTranscriptPath, estimateContextTokens, nodeSessionFs, type SessionFs } from "./estimate.js";

/** Default context cap of a resumed run (`TIDEGAP_RESUME_MAX_TOKENS`). */
export const DEFAULT_RESUME_MAX_TOKENS = 150_000;

/** The session a task came from. */
export interface RunOrigin {
  sessionId?: string;
  /** The session's project directory. */
  cwd?: string;
  /** `claude-code` for a Claude Code session; other agents never resume here. */
  agent?: string;
  transcriptPath?: string;
}

/** `TIDEGAP_RESUME` and `TIDEGAP_RESUME_MAX_TOKENS`, parsed. */
export interface ResumeSettings {
  enabled: boolean;
  maxTokens: number;
  /** `CLAUDE_CONFIG_DIR`, for the derived transcript path. */
  claudeConfigDir?: string;
  /** Home directory for the derived transcript path (tests). */
  home?: string;
}

/** Parse the resume variables; an invalid cap falls back to the default with a warning. */
export function resumeSettings(raw: {
  resume?: string;
  maxTokens?: string;
  claudeConfigDir?: string;
}): ResumeSettings & { warning?: string } {
  const enabled = !/^(0|false|off|no)$/i.test(raw.resume?.trim() ?? "");
  const base = { enabled, ...(raw.claudeConfigDir ? { claudeConfigDir: raw.claudeConfigDir } : {}) };
  if (raw.maxTokens === undefined || raw.maxTokens.trim() === "") {
    return { ...base, maxTokens: DEFAULT_RESUME_MAX_TOKENS };
  }
  const n = Number(raw.maxTokens);
  if (Number.isInteger(n) && n > 0) return { ...base, maxTokens: n };
  return {
    ...base,
    maxTokens: DEFAULT_RESUME_MAX_TOKENS,
    warning: `!! WARNING: TIDEGAP_RESUME_MAX_TOKENS=${JSON.stringify(raw.maxTokens)} is not a positive integer; using ${DEFAULT_RESUME_MAX_TOKENS}.`,
  };
}

/**
 * A Claude Code session id: a UUID. Stricter than the stored-id pattern, so
 * `--resume <id>` can never receive a value that starts with `-`.
 */
const CLAUDE_SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when `origin` is a Claude Code session a run can resume. */
export function isClaudeOrigin(origin: RunOrigin | undefined): origin is RunOrigin & { sessionId: string } {
  return origin?.agent === "claude-code" && typeof origin.sessionId === "string" && CLAUDE_SESSION_UUID.test(origin.sessionId);
}

/**
 * Whether a run may use `cwd` as its working directory, where its file
 * tools read without asking: `missing` unless it is an absolute path to an
 * existing directory; `unsafe` when it is `/`, the home directory, or a
 * directory another user owns.
 */
export function originDirCheck(
  cwd: string | undefined,
  fs: SessionFs,
  home: string = homedir(),
): "ok" | "missing" | "unsafe" {
  if (!cwd || !isAbsolute(cwd) || !fs.isDirectory(cwd)) return "missing";
  const info = fs.dirInfo?.(cwd);
  const real = info?.realPath ?? resolve(cwd);
  const realHome = fs.dirInfo?.(home)?.realPath ?? resolve(home);
  if (real === "/" || real === realHome || resolve(cwd) === resolve(home)) return "unsafe";
  const uid = process.getuid?.();
  if (info && uid !== undefined && info.uid !== uid) return "unsafe";
  return "ok";
}

/**
 * The tools of a run (KTD7): the task's own set when it names one, else
 * Read, Grep and Glob for a task from a Claude Code session, else the
 * host's default.
 */
export function effectiveTools(
  taskTools: readonly string[] | undefined,
  origin: RunOrigin | undefined,
  hostDefault: readonly string[],
): string[] {
  return [...(taskTools ?? (isClaudeOrigin(origin) ? DEFAULT_ORIGIN_TOOLS : hostDefault))];
}

export interface PlanInput {
  /** The task's provider (`claude-code`, `anthropic`, ...). */
  provider: string;
  origin?: RunOrigin;
  /** The run's tool set, from {@link effectiveTools}. */
  tools: readonly string[];
  settings: ResumeSettings;
  fs?: SessionFs;
}

export interface RunPlan {
  mode: RunSessionMode;
  reason?: FreshReason;
  contextTokens?: number;
}

/** KTD8, first match wins. */
export function planRun(input: PlanInput): RunPlan {
  const fs = input.fs ?? nodeSessionFs;
  const { origin, settings } = input;
  if (!settings.enabled) return { mode: "fresh", reason: "disabled" };
  if (!isClaudeOrigin(origin)) return { mode: "fresh", reason: "no-origin" };
  if (input.provider !== "claude-code") return { mode: "fresh", reason: "api-provider" };
  if (includesWebTool(input.tools)) return { mode: "fresh", reason: "web-tools" };
  const dir = originDirCheck(origin.cwd, fs, settings.home);
  if (dir !== "ok") return { mode: "fresh", reason: dir === "missing" ? "cwd-missing" : "cwd-unsafe" };
  if (origin.transcriptPath && !fs.exists(origin.transcriptPath)) return { mode: "fresh", reason: "session-missing" };
  const transcript =
    origin.transcriptPath ??
    derivedTranscriptPath(origin.sessionId, origin.cwd!, {
      ...(settings.claudeConfigDir ? { claudeConfigDir: settings.claudeConfigDir } : {}),
      ...(settings.home ? { home: settings.home } : {}),
    });
  const contextTokens = transcript ? estimateContextTokens(transcript, fs) : undefined;
  if (contextTokens !== undefined && contextTokens > settings.maxTokens) {
    return { mode: "fresh", reason: "too-large", contextTokens };
  }
  return { mode: "fork", ...(contextTokens !== undefined ? { contextTokens } : {}) };
}

/** `cap 150k`. */
function capLabel(maxTokens: number): string {
  return maxTokens >= 1000 ? `cap ${Math.round(maxTokens / 1000)}k` : `cap ${maxTokens}`;
}

/**
 * The `runs_in:` value of the MCP reply (R10): `a copy of this Claude Code
 * session (d76db676) in /work/app, file tools Read, Grep, Glob`, or
 * `a fresh session (web tools)`.
 */
export function describeRunsIn(plan: RunPlan, origin: RunOrigin | undefined, tools: readonly string[], settings: ResumeSettings): string {
  if (plan.mode === "fork" && isClaudeOrigin(origin)) {
    const toolText = tools.length > 0 ? `file tools ${tools.join(", ")}` : "no tools";
    return `a copy of this Claude Code session (${shortSessionId(origin.sessionId)}) in ${origin.cwd}, ${toolText}`;
  }
  const reason = plan.reason ?? "no-origin";
  const detail =
    reason === "too-large" && plan.contextTokens !== undefined
      ? `${freshReasonText(reason)}, ${tokensLabel(plan.contextTokens)}, ${capLabel(settings.maxTokens)}`
      : freshReasonText(reason);
  return `a fresh session (${detail})`;
}
