/**
 * Where a `claude-code` task ran: in a copy (fork) of the Claude Code
 * session that queued it, or in a fresh session, and why. The adapter in
 * the `tidegap` CLI decides; the scheduler copies the result onto the
 * receipt, and every surface words it with the helpers below.
 */

import type { ProviderCallOrigin, TaskRecord } from "./types.js";

/** `fork`: a copy of the origin session. `fresh`: a new session with no history. */
export type RunSessionMode = "fork" | "fresh";

/** Why a task with (or without) an origin ran fresh. */
export type FreshReason =
  | "disabled"
  | "no-origin"
  | "api-provider"
  | "web-tools"
  | "cwd-missing"
  | "session-missing"
  | "too-large";

/** The session facts of one run, on `DispatchResult.session` and `CarbonReceipt.session`. */
export interface RunSession {
  mode: RunSessionMode;
  /** The session that ran: the fork's id, or the fresh session's id. */
  sessionId?: string;
  /** The session the task came from, when it had one. */
  originSessionId?: string;
  /** Why the run was fresh. Absent for a fork. */
  reason?: FreshReason;
  /** The context estimate of the origin session, when one was made. */
  contextTokens?: number;
}

/** The first 8 characters of a session id, for display. */
export function shortSessionId(id: string): string {
  return id.slice(0, 8);
}

/** `about 620k tokens`. */
export function tokensLabel(tokens: number): string {
  if (tokens >= 1000) return `about ${Math.round(tokens / 1000)}k tokens`;
  return `about ${tokens} tokens`;
}

/** A fresh-run reason in words: `session too large`, `web tools`, ... */
export function freshReasonText(reason: FreshReason): string {
  switch (reason) {
    case "disabled":
      return "session resume is off (TIDEGAP_RESUME=off)";
    case "no-origin":
      return "no session found";
    case "api-provider":
      return "the API provider has no session";
    case "web-tools":
      return "web tools";
    case "cwd-missing":
      return "the session directory is gone";
    case "session-missing":
      return "the session transcript is gone";
    case "too-large":
      return "session too large";
  }
}

/** The origin facts of a task's spec (`ProviderCallSpec.origin`), or undefined. */
export function taskOrigin(record: Pick<TaskRecord<unknown>, "bodyJson">): ProviderCallOrigin | undefined {
  if (!record.bodyJson) return undefined;
  try {
    const origin = (JSON.parse(record.bodyJson) as { origin?: unknown }).origin;
    if (!origin || typeof origin !== "object") return undefined;
    const agent = (origin as { agent?: unknown }).agent;
    return agent === "claude-code" || agent === "codex" ? (origin as ProviderCallOrigin) : undefined;
  } catch {
    return undefined;
  }
}

/** `fork f1a2b3c4 of d76db676` or `fresh (too-large, about 620k tokens)`. */
export function runSessionSummary(session: RunSession): string {
  if (session.mode === "fork") {
    const fork = session.sessionId ? shortSessionId(session.sessionId) : "?";
    return session.originSessionId ? `fork ${fork} of ${shortSessionId(session.originSessionId)}` : `fork ${fork}`;
  }
  const parts = [session.reason, session.contextTokens !== undefined ? tokensLabel(session.contextTokens) : undefined].filter(Boolean);
  return parts.length > 0 ? `fresh (${parts.join(", ")})` : "fresh";
}
