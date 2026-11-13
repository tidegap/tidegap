/**
 * Wake rules of a job bound to a Claude Code session (KTD7, KTD9): the rule
 * text the hosts take, the pattern checks on add and edit, and the bounded
 * match the job sweep runs on a completed run's result text.
 *
 * The pattern is a JavaScript regular expression with the `m` flag (`^`
 * and `$` match at each line). The match reads at most
 * {@link JOB_WAKE_TEXT_MAX_CHARS} of the text and runs inside `vm` with a
 * {@link JOB_WAKE_MATCH_TIMEOUT_MS} limit, so a pattern that backtracks
 * without end cannot hold the tick. A match that times out counts as
 * matched: a broken pattern wakes once rather than missing an alert.
 */

import { createContext, runInContext } from "node:vm";

/** The longest wake pattern. */
export const JOB_WAKE_PATTERN_MAX_CHARS = 200;
/** How much of a run's result text the pattern reads (64 KiB of characters). */
export const JOB_WAKE_TEXT_MAX_CHARS = 64 * 1024;
/** How long one match may run. */
export const JOB_WAKE_MATCH_TIMEOUT_MS = 50;

/** A wake rule as a host gives it: `never` unbinds the job. */
export type JobWakeRule = { on: "never" } | { on: "failures" } | { on: "match"; pattern: string };

/** Why a wake rule or pattern was refused. */
export class JobWakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobWakeError";
  }
}

/** What `--wake` takes. */
export const JOB_WAKE_FORMS = "never, failures or match=<pattern>";

/**
 * Why a wake pattern is refused, or undefined when it is fine: it must be
 * a string of 1 to {@link JOB_WAKE_PATTERN_MAX_CHARS} characters that
 * compiles with the `m` flag and does not match the empty string (it would
 * wake on every run).
 */
export function wakePatternError(pattern: unknown): string | undefined {
  if (typeof pattern !== "string" || pattern === "") return "the wake pattern must be a non-empty string";
  if (pattern.length > JOB_WAKE_PATTERN_MAX_CHARS) return `the wake pattern is longer than ${JOB_WAKE_PATTERN_MAX_CHARS} characters`;
  // The pattern is the user's own text: it compiles and runs only inside the bounded vm match.
  const empty = boundedTest(pattern, "", JOB_WAKE_MATCH_TIMEOUT_MS);
  if (empty.error !== undefined) return `the wake pattern is not a valid regular expression: ${empty.error}`;
  if (empty.timedOut) return `the wake pattern takes longer than ${JOB_WAKE_MATCH_TIMEOUT_MS} ms on an empty output; make it simpler`;
  if (empty.matched) return "the wake pattern matches an empty output, so it would wake on every run; make it name what to look for";
  return undefined;
}

/** Compile `pattern` (flag `m`) and test it on `text` in a fresh `vm` context with a time limit. Never throws. */
function boundedTest(pattern: string, text: string, timeoutMs: number): { matched: boolean; timedOut?: boolean; error?: string } {
  const context = createContext({ pattern, text });
  try {
    return { matched: runInContext(`new RegExp(pattern, "m").test(text)`, context, { timeout: timeoutMs }) === true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") return { matched: false, timedOut: true };
    // An error from inside the context is not an instance of this realm's Error.
    const message = (err as { message?: unknown })?.message;
    return { matched: false, error: typeof message === "string" ? message : String(err) };
  }
}

/** The rule `--wake never|failures|match=<pattern>` names. Throws {@link JobWakeError}. */
export function parseWakeRule(text: string): JobWakeRule {
  const value = text.trim();
  if (value === "never" || value === "failures") return { on: value };
  if (value.startsWith("match=")) {
    const pattern = value.slice("match=".length);
    const error = wakePatternError(pattern);
    if (error) throw new JobWakeError(error);
    return { on: "match", pattern };
  }
  throw new JobWakeError(`--wake must be ${JOB_WAKE_FORMS}`);
}

/** What one bounded match found: `timedOut` (or `broken`, a stored pattern that no longer compiles) counts as matched. */
export interface WakeMatch {
  matched: boolean;
  timedOut?: boolean;
  broken?: boolean;
}

/**
 * Test `pattern` (flag `m`) against the first {@link JOB_WAKE_TEXT_MAX_CHARS}
 * of `text`, in a fresh `vm` context with a {@link JOB_WAKE_MATCH_TIMEOUT_MS}
 * limit. Never throws.
 */
export function matchWake(pattern: string, text: string, timeoutMs: number = JOB_WAKE_MATCH_TIMEOUT_MS): WakeMatch {
  const r = boundedTest(pattern, text.slice(0, JOB_WAKE_TEXT_MAX_CHARS), timeoutMs);
  if (r.timedOut) return { matched: true, timedOut: true };
  if (r.error !== undefined) return { matched: true, broken: true };
  return { matched: r.matched };
}
