/**
 * Which agent session queues a task (KTD1), first hit wins:
 *
 *   1. `origin_session_id` from the tool call, when it is a valid id (the
 *      `/tidegap:defer` command substitutes it).
 *   2. The plugin hook's capture file of the Claude Code process that runs
 *      this server. Current after `/clear` and `/resume`.
 *   3. `CLAUDE_CODE_SESSION_ID` from this server's environment. Observed, not
 *      documented, and fixed at server start.
 *   4. None: the task is queued as before (R3).
 */

import { isValidSessionId, type ProviderCallOrigin } from "@tidegap/core";
import type { CapturedSession, RunOrigin } from "@tidegap/cli/session";

import type { OriginEnv } from "./env.js";

/** Where the origin facts come from. Tests inject every one. */
export interface OriginSources {
  env: OriginEnv;
  /** The ancestor `claude` pid (looked up once per process), or undefined. */
  claudePid: () => number | undefined;
  readCapture: (pid: number) => CapturedSession | undefined;
  /** The working directory to record when the session names none. */
  fallbackCwd: () => string | undefined;
}

export interface ResolvedOrigin {
  /** For the `origin_session_id` column. */
  sessionId?: string;
  /** For the `origin_cwd` column: the session's project directory when known. */
  cwd?: string;
  /** For `ProviderCallSpec.origin`; absent when no agent session was found. */
  spec?: ProviderCallOrigin;
  /** The same facts in the shape the run plan takes. */
  run?: RunOrigin;
}

function resolved(
  sessionId: string,
  cwd: string | undefined,
  via: ProviderCallOrigin["via"],
  claudeCode: boolean,
  transcriptPath?: string,
): ResolvedOrigin {
  const out: ResolvedOrigin = { sessionId, ...(cwd ? { cwd } : {}) };
  if (!claudeCode) return out;
  out.spec = { agent: "claude-code", via, ...(transcriptPath ? { transcriptPath } : {}) };
  out.run = { sessionId, agent: "claude-code", ...(cwd ? { cwd } : {}), ...(transcriptPath ? { transcriptPath } : {}) };
  return out;
}

/** KTD1 over `sources`; `arg` is the tool call's `origin_session_id`. */
export function resolveOrigin(arg: unknown, sources: OriginSources): ResolvedOrigin {
  const { env } = sources;
  const pid = sources.claudePid();
  const captured = pid !== undefined ? sources.readCapture(pid) : undefined;
  const capturedCwd = captured ? (captured.projectDir ?? captured.cwd) : undefined;
  if (isValidSessionId(arg)) {
    // The capture file belongs to this process, so its directory holds even
    // when the argument names another session; its transcript does not.
    const same = captured?.sessionId === arg ? captured : undefined;
    return resolved(
      arg,
      capturedCwd ?? env.projectDir ?? sources.fallbackCwd(),
      "arg",
      captured !== undefined || env.claudeCode,
      same?.transcriptPath,
    );
  }
  if (captured) {
    return resolved(captured.sessionId, capturedCwd ?? sources.fallbackCwd(), "hook", true, captured.transcriptPath);
  }
  if (isValidSessionId(env.sessionId)) {
    return resolved(env.sessionId, env.projectDir ?? sources.fallbackCwd(), "env", true);
  }
  const cwd = sources.fallbackCwd();
  return cwd ? { cwd } : {};
}
