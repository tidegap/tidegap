/**
 * The origin-session fields of `GET /api/tasks/:id` (R11): which agent
 * session queued the task and how its run used it. Kept apart from
 * `api.ts` so the detail route only spreads them in.
 */

import { freshReasonText, resumeCommand, taskOrigin, type TaskRecord } from "@tidegap/core";

export function taskSessionFields(r: TaskRecord<unknown>): Record<string, unknown> {
  const session = r.receipt?.session;
  const fork =
    session?.mode === "fork" && session.sessionId
      ? resumeCommand({ originCwd: r.originCwd, originSessionId: session.sessionId })
      : undefined;
  return {
    origin_agent: taskOrigin(r)?.agent ?? null,
    run_session: session
      ? {
          mode: session.mode,
          session_id: session.sessionId ?? null,
          origin_session_id: session.originSessionId ?? null,
          reason: session.reason ?? null,
          reason_text: session.reason ? freshReasonText(session.reason) : null,
          context_tokens: session.contextTokens ?? null,
        }
      : null,
    fork_command: fork ?? null,
  };
}
