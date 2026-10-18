/**
 * Which agent session queues a task (KTD1), first hit wins:
 *
 *   1. `origin_session_id` from the tool call, when it is a valid id that
 *      names this process's session: the capture file's or the
 *      environment's (the `/tidegap:defer` command substitutes it). An id
 *      that names another session is ignored with a warning, so an agent
 *      cannot queue a run into a session it is not in. With nothing to
 *      check it against, the id is kept for display only and never resumed.
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
  /** Why `origin_session_id` was not used as given, for the reply. */
  warning?: string;
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
  const envId = isValidSessionId(env.sessionId) ? env.sessionId : undefined;
  let warning: string | undefined;
  if (isValidSessionId(arg)) {
    if (captured?.sessionId === arg || envId === arg) {
      // The capture file belongs to this process, so its directory holds even
      // when the argument names the environment's session; its transcript does not.
      const same = captured?.sessionId === arg ? captured : undefined;
      return resolved(arg, capturedCwd ?? env.projectDir ?? sources.fallbackCwd(), "arg", true, same?.transcriptPath);
    }
    if (captured || envId) {
      warning = `origin_session_id ${arg} is not this Claude Code session; it is ignored and the current session is used.`;
    } else {
      const cwd = sources.fallbackCwd();
      return {
        sessionId: arg,
        ...(cwd ? { cwd } : {}),
        ...(env.claudeCode
          ? { warning: `origin_session_id ${arg} could not be checked against this Claude Code session; the task runs in a fresh session.` }
          : {}),
      };
    }
  }
  const out = captured
    ? resolved(captured.sessionId, capturedCwd ?? sources.fallbackCwd(), "hook", true, captured.transcriptPath)
    : envId
      ? resolved(envId, env.projectDir ?? sources.fallbackCwd(), "env", true)
      : undefined;
  if (out) return warning ? { ...out, warning } : out;
  const cwd = sources.fallbackCwd();
  return cwd ? { cwd } : {};
}
