/**
 * Floating recurring jobs: the job store actions and the job sweep.
 *
 * A job ("at least once a day, check my mail") keeps exactly one live
 * occurrence in the ledger: an ordinary provider-call task with `job_id`
 * set, `repeat = none` and no series. The id is derived, `<job_id>~<seq>`
 * (a retry is `<job_id>~<seq>r`), and inserted once (`insertIfAbsent`).
 *
 * {@link sweepJobs} owns every transition the daemon makes (KTD2). It runs
 * inside `prepareTick`, so every ticker gets it. For each job it reads the
 * tracked occurrence and:
 *
 *   - live occurrence: nothing (R17), except a `running` one whose tick is
 *     gone or whose dispatch is older than its time limits allow, which
 *     fails as interrupted (a Batch row with a batch id goes back to
 *     `submitted` instead);
 *   - finished occurrence: records the outcome (KTD9: ok, a failure with
 *     the retries of the job's retry policy per slot and auto-pause after
 *     three failed slots, or a skip), then materializes the next
 *     occurrence;
 *   - no occurrence on an active job: materializes one.
 *
 * Every job write is a compare-and-set on `revision`. Pause, edit and
 * remove write the job row first, then cancel the tracked occurrence; a
 * sweep whose job write misses leaves its insert to the next pass, which
 * adopts it on an active job and cancels it otherwise (the stop-flag-first
 * rule). The sweep never throws.
 */

import { randomBytes } from "node:crypto";

import { DEFAULT_MODEL_BY_PROVIDER } from "./providers/defaults.js";
import { wakeError } from "./handoff.js";
import { BATCH_SUBMIT_INTERRUPTED_ERROR, deriveTitle, taskResultText } from "./history.js";
import { JOB_WAKE_FORMS, matchWake, wakePatternError, type JobWakeRule } from "./job-wake.js";
import { isCalendarAnchored, JobScheduleError, nextOccurrence, untilBoundMs, untilText, validateJobSchedule, type JobSchedule } from "./job-cadence.js";
import { sleptBetween, type SleepReading } from "./readiness.js";
import type { Scheduler } from "./scheduler.js";
import {
  capValueError,
  classifyFailure,
  FAILURE_CLASSES,
  isRetryableFailure,
  isRunLimitCap,
  loadRunLimitSettings,
  planRetry,
  resolveTaskRunLimits,
  retryPolicyOf,
  runLimitsFromDetails,
  versionedCaps,
  type FailureClass,
  type ResolvedRunLimits,
} from "./run-limits.js";
import { canonicalize } from "./sign.js";
import type { TaskStore } from "./storage/sqlite.js";
import { systemTimeZone } from "./zone-time.js";
import {
  DEFAULT_JOB_CAPS,
  type JobCadence,
  type JobCaps,
  type JobEndReason,
  type JobNoticeReason,
  type JobNotify,
  type JobRecord,
  type JobTemplate,
  type JobTools,
  type JobWindow,
  type ProviderCallSpec,
  type ProviderName,
  type TaskOriginHost,
  type TaskRecord,
  type TaskStatus,
} from "./types.js";

/** Why a job action was refused; `code` maps to an HTTP status in the hosts. */
export class JobActionError extends Error {
  constructor(
    message: string,
    /** `invalid` = bad input (400), `not_found` (404), `conflict` = the state forbids it (409). */
    readonly code: "invalid" | "not_found" | "conflict" = "conflict",
    /**
     * A finer cause for a host that answers it: `stale_revision` = the caller
     * holds an older revision than the stored job ({@link updateJob}).
     */
    readonly reason?: "stale_revision",
  ) {
    super(message);
    this.name = "JobActionError";
  }
}

/** What a caller gives to create a job. */
export interface JobInput {
  title: string;
  cadence: JobCadence;
  window?: JobWindow;
  /** IANA zone; default the system zone. */
  timeZone?: string;
  template: JobTemplate;
  caps?: JobCapsPatch;
  /** Default `every_run`. */
  notify?: JobNotify;
  /** `page`, `cli`, `mcp` or `openclaw`. */
  originHost?: string;
  originCwd?: string;
  /**
   * Deadline of the first occurrence (an agent's `schedule_task` deadline,
   * AS9): it may run from now until then. Later ones follow the cadence.
   */
  deadline?: string | Date;
  /**
   * The end date: `YYYY-MM-DD` (the last local day a slot may start,
   * inclusive) or an ISO instant (a slot must start before it).
   */
  until?: string | null;
  /** Runs from now before the job ends, 1 to {@link JOB_MAX_COUNT}. */
  count?: number | null;
  /**
   * Bind the job to the Claude Code session that sets it (KTD8). Never read
   * from the job JSON: only a host that runs in the session sets it.
   */
  wake?: JobWakeInput;
}

/** A wake rule with the session that sets it; `never` unbinds the job and needs no session. */
export type JobWakeInput = JobWakeRule & {
  /** The session to wake. */
  sessionId?: string;
  /** The origin's agent: a wake needs `claude-code`. */
  agent?: string;
};

/** The fields {@link updateJob} can change; `window: null` removes the window. */
export interface JobPatch {
  title?: string;
  cadence?: JobCadence;
  window?: JobWindow | null;
  timeZone?: string;
  template?: JobTemplate;
  caps?: JobCapsPatch;
  notify?: JobNotify;
  /** A new end date; `null` clears it. */
  until?: string | null;
  /** Runs left from now; `null` clears the bound. */
  count?: number | null;
  /** A new wake binding (to the session that sets it), or `never` to unbind. */
  wake?: JobWakeInput;
}

/**
 * Caps a caller sets: a value sets the key. `null` removes a time limit, so
 * the setting or the default applies at each run, and puts any other cap
 * back to its default.
 */
export type JobCapsPatch = { [K in Exclude<keyof JobCaps, "capsVersion">]?: JobCaps[K] | null };

/** Every caps key a caller may set. */
export const JOB_CAPS_KEYS: ReadonlySet<string> = new Set([
  "commandTimeoutMs",
  "llmTimeoutMs",
  "retries",
  "retryDelayMs",
  ...Object.keys(DEFAULT_JOB_CAPS),
]);

/** Per-call options of the job actions. */
export interface JobActionOptions {
  /** Who the change is recorded as on occurrence events; default `system`. */
  actor?: string;
}

/** Options of {@link updateJob}. */
export interface JobUpdateOptions extends JobActionOptions {
  /**
   * The revision the caller edited. A stored job with another revision
   * refuses the edit with reason `stale_revision`; omitted = last writer wins.
   */
  expectedRevision?: number;
}

/** One occurrence in {@link jobHistory}, newest first. */
export interface JobHistoryEntry {
  taskId: string;
  status: TaskStatus;
  enqueuedAt: string;
  scheduledFor?: string;
  deadline?: string;
  completedAt?: string;
  /** True when the occurrence has a carbon receipt. */
  hasReceipt: boolean;
  /** Actual grams on the receipt, else the schedule-time estimate. */
  carbonG?: number;
  /** First line of the error, for a failed occurrence. */
  error?: string;
}

/** What one {@link sweepJobs} pass did. */
export interface JobSweepResult {
  /** One line per change and per failure, for the tick log. */
  messages: string[];
  /** Occurrence ids inserted this pass (retries included). */
  materialized: string[];
  /** Retry occurrence ids inserted this pass. */
  retried: string[];
  /** Jobs paused after their third failed slot this pass. */
  autoPaused: string[];
  /** Running occurrences failed as interrupted this pass. */
  interrupted: string[];
  /** Jobs that reached their end date or ran their runs this pass. */
  ended: string[];
  /** Runs of bound jobs that became session notices this pass. */
  sessionNotices: string[];
}

/** Providers a prompt or summarize step may use (`command` is the shell step itself). */
const LLM_PROVIDERS: ReadonlySet<string> = new Set(["anthropic", "openai", "gemini", "ollama", "claude-code"]);
const TOOLS: Record<JobTools, string[]> = {
  none: [],
  files: ["Read", "Grep", "Glob"],
  web: ["WebSearch", "WebFetch"],
};
const NOTIFY: ReadonlySet<string> = new Set(["every_run", "failures", "summary"]);
const ORIGIN_HOSTS: ReadonlySet<string> = new Set(["page", "cli", "mcp", "openclaw"]);
const TASK_ORIGIN_HOSTS: ReadonlySet<string> = new Set(["cli", "mcp", "openclaw"]);
/** A job secret name: what the command sees as an environment variable. */
export const JOB_SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

const LIVE_STATUSES: readonly TaskStatus[] = ["queued", "scheduled", "running", "submitted"];
const PENDING_STATUSES: readonly TaskStatus[] = ["queued", "scheduled"];
const LIVE: ReadonlySet<TaskStatus> = new Set(LIVE_STATUSES);
const PENDING: ReadonlySet<TaskStatus> = new Set(PENDING_STATUSES);
/** Cancel reasons a job action writes; any other cancel of an occurrence is a skip. */
const ACTION_CANCEL_REASONS: ReadonlySet<string> = new Set(["paused", "edited", "removed", "duplicate", "ended"]);

const MINUTE_MS = 60_000;
/** The most runs a job's `count` may ask for. */
export const JOB_MAX_COUNT = 1000;
/** Failed slots in a row that pause a job. */
export const JOB_AUTO_PAUSE_FAILURES = 3;

/** How `pauseReason` starts when the third failed slot paused the job: `auto: <first error line>`. */
export const JOB_AUTO_PAUSE_PREFIX = "auto: ";

/** The error line of an auto-pause reason, or undefined when the job was not paused by its failures. */
export function jobAutoPauseReason(pauseReason: string | undefined): string | undefined {
  return pauseReason?.startsWith(JOB_AUTO_PAUSE_PREFIX) ? pauseReason.slice(JOB_AUTO_PAUSE_PREFIX.length).trim() : undefined;
}
/** Grace on top of the caps before a running occurrence counts as interrupted. */
const INTERRUPT_GRACE_MS = 5 * MINUTE_MS;
export const JOB_INTERRUPTED_ERROR = "interrupted: the tick stopped during the run";
// The Batch submit marker lives in history.ts (`taskActions` reads it), so history.ts imports nothing from this module.
export { BATCH_SUBMIT_INTERRUPTED_ERROR };
const CORRUPT = "corrupt template";

function ledgerOf(scheduler: Scheduler): TaskStore {
  const store = scheduler.ledger();
  if (!store) throw new JobActionError("jobs need a ledger (a scheduler with dbPath)", "invalid");
  return store;
}

function nonEmpty(v: unknown, what: string): string {
  if (typeof v !== "string" || v.trim() === "") throw new JobActionError(`${what} must be a non-empty string`, "invalid");
  return v;
}

function optionalString(v: unknown, what: string): string | undefined {
  if (v === undefined) return undefined;
  return nonEmpty(v, what);
}

function llmProvider(v: unknown, what: string): ProviderName {
  if (typeof v !== "string" || !LLM_PROVIDERS.has(v)) {
    throw new JobActionError(`${what} must be one of ${[...LLM_PROVIDERS].join(", ")}`, "invalid");
  }
  return v as ProviderName;
}

function validTemplate(t: JobTemplate): JobTemplate {
  if (t?.runner === "prompt") {
    const tools = t.tools ?? "none";
    if (!(tools in TOOLS)) throw new JobActionError("tools must be none, files or web", "invalid");
    return {
      runner: "prompt",
      prompt: nonEmpty(t.prompt, "prompt"),
      provider: llmProvider(t.provider, "provider"),
      model: optionalString(t.model, "model"),
      cwd: optionalString(t.cwd, "cwd"),
      tools,
    };
  }
  if (t?.runner === "command") {
    const secrets = Array.isArray(t.secrets) ? t.secrets : [];
    for (const name of secrets) {
      if (typeof name !== "string" || !JOB_SECRET_NAME.test(name)) {
        throw new JobActionError(`secret name ${JSON.stringify(name)} must match ${JOB_SECRET_NAME.source}`, "invalid");
      }
    }
    const s = t.summarize;
    return {
      runner: "command",
      command: nonEmpty(t.command, "command"),
      cwd: optionalString(t.cwd, "cwd"),
      secrets: [...new Set(secrets)],
      summarize: s
        ? { prompt: nonEmpty(s.prompt, "summarize prompt"), provider: llmProvider(s.provider, "summarize provider"), model: optionalString(s.model, "summarize model") }
        : undefined,
    };
  }
  throw new JobActionError('runner must be "prompt" or "command"', "invalid");
}

/**
 * The caps to store: `base` with `patch` applied. The result holds only the
 * time limits a caller set (old stored defaults dropped) and `capsVersion: 2`.
 */
function validCaps(base: Partial<JobCaps>, patch: JobCapsPatch | undefined): JobCaps {
  const out: Record<string, unknown> = { ...DEFAULT_JOB_CAPS, ...versionedCaps(base) };
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (!JOB_CAPS_KEYS.has(key)) throw new JobActionError(`unknown cap "${key}"`, "invalid");
    if (value === undefined) continue;
    if (value === null) {
      if (isRunLimitCap(key)) delete out[key];
      else out[key] = DEFAULT_JOB_CAPS[key as keyof JobCaps];
      continue;
    }
    const error = capValueError(key, value);
    if (error) throw new JobActionError(error, "invalid");
    out[key] = value;
  }
  return out as unknown as JobCaps;
}

function validSchedule(s: JobSchedule): JobSchedule {
  try {
    return validateJobSchedule(s);
  } catch (err) {
    if (err instanceof JobScheduleError) throw new JobActionError(err.message, "invalid");
    throw err;
  }
}

function validTitle(title: unknown): string {
  const text = nonEmpty(title, "title");
  return deriveTitle(text) ?? text;
}

function validNotify(v: unknown): JobNotify {
  if (typeof v !== "string" || !NOTIFY.has(v)) throw new JobActionError("notify must be every_run, failures or summary", "invalid");
  return v as JobNotify;
}

/** A valid `until` for a job in `timeZone`, or undefined for none; a bound already past is refused. */
function validUntil(v: unknown, timeZone: string, nowMs: number): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new JobActionError("until must be a day YYYY-MM-DD or an ISO instant", "invalid");
  const text = v.trim();
  let bound: number;
  try {
    bound = untilBoundMs(text, timeZone);
  } catch (err) {
    if (err instanceof JobScheduleError) throw new JobActionError(err.message, "invalid");
    throw err;
  }
  if (bound <= nowMs) throw new JobActionError(`until "${text}" has passed; give a later day or instant`, "invalid");
  return text;
}

/** A valid `count`, or undefined for none. */
function validCount(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > JOB_MAX_COUNT) {
    throw new JobActionError(`count must be a whole number from 1 to ${JOB_MAX_COUNT}`, "invalid");
  }
  return v;
}

/** What an end reason says: `its end date (<until>) passed` or `its runs are done`. */
export function jobEndText(reason: JobEndReason | undefined, until?: string): string {
  return reason === "until" ? `its end date${until ? ` (${until})` : ""} passed` : "its runs are done";
}

/**
 * A job's end condition in words, or undefined for a job with none:
 * `ends after 2026-11-17 (Europe/Berlin)`, `3 runs left`, or both joined by `; `.
 */
export function jobEndsText(job: Pick<JobRecord, "until" | "runsLeft" | "timeZone">): string | undefined {
  const parts: string[] = [];
  if (job.until !== undefined) parts.push(`ends ${untilText(job.until, job.timeZone)}`);
  if (job.runsLeft !== undefined) parts.push(`${job.runsLeft} ${job.runsLeft === 1 ? "run" : "runs"} left`);
  return parts.length > 0 ? parts.join("; ") : undefined;
}

/**
 * The binding a wake input gives, checked: `never` clears both fields; a
 * rule needs a Claude Code session ({@link wakeError}) and, for `match`, a
 * pattern {@link wakePatternError} accepts. `boundAt` is `now`.
 */
function validWake(input: JobWakeInput, now: Date): Pick<JobRecord, "wake" | "originSessionId"> {
  if (input.on === "never") return { wake: undefined, originSessionId: undefined };
  if (input.on !== "failures" && input.on !== "match") throw new JobActionError(`wake must be ${JOB_WAKE_FORMS}`, "invalid");
  const refused = wakeError(true, { agent: input.agent }, input.sessionId);
  if (refused) throw new JobActionError(refused, "invalid");
  if (input.on === "failures") return { wake: { on: "failures", boundAt: now.toISOString() }, originSessionId: input.sessionId };
  const patternError = wakePatternError(input.pattern);
  if (patternError) throw new JobActionError(patternError, "invalid");
  return { wake: { on: "match", pattern: input.pattern, boundAt: now.toISOString() }, originSessionId: input.sessionId };
}

/** The session a job wakes, or undefined when it is not bound. */
export function jobWakeSession(job: Pick<JobRecord, "wake" | "originSessionId">): string | undefined {
  return job.wake && job.originSessionId ? job.originSessionId : undefined;
}

function newJobId(store: TaskStore): string {
  for (;;) {
    const id = `job-${randomBytes(4).toString("hex")}`;
    if (!store.getJob(id)) return id;
  }
}

/** The occurrence body a job's template runs (Data shapes in the plan). */
function occurrenceBody(job: JobRecord): ProviderCallSpec {
  const t = job.template;
  const session = jobWakeSession(job);
  // A bound job's runs carry the rule and the session, never `origin` (KTD7).
  const jobWake = session ? { jobWake: { on: job.wake!.on, session } } : {};
  if (t.runner === "prompt") {
    return {
      type: "provider_call",
      provider: t.provider,
      model: t.model ?? DEFAULT_MODEL_BY_PROVIDER[t.provider],
      prompt: t.prompt,
      tools: TOOLS[t.tools],
      caps: job.caps,
      ...jobWake,
    };
  }
  return {
    type: "provider_call",
    provider: "command",
    model: t.summarize?.model ?? (t.summarize ? DEFAULT_MODEL_BY_PROVIDER[t.summarize.provider] : "none"),
    prompt: t.summarize?.prompt ?? "",
    command: { run: t.command, cwd: t.cwd, secrets: t.secrets },
    summarize: t.summarize ? { provider: t.summarize.provider, model: t.summarize.model } : undefined,
    caps: job.caps,
    ...jobWake,
  };
}

/**
 * The time limits a run of `job` gets if it starts now, with their sources:
 * the scheduler's settings reader, or without one the settings file.
 */
export function jobRunLimits(job: JobRecord, scheduler?: Scheduler): ResolvedRunLimits {
  const body = occurrenceBody(job);
  return scheduler ? scheduler.runLimitsFor(body) : resolveTaskRunLimits(body, loadRunLimitSettings());
}

function scheduleOf(job: JobRecord): JobSchedule {
  return { cadence: job.cadence, window: job.window, timeZone: job.timeZone };
}

/** Sequence number of an occurrence id `<job>~<seq>`, or of a retry `<job>~<seq>r`, `<job>~<seq>r2`, ... */
function seqOf(taskId: string): number {
  const m = /~(\d+)(?:r\d*)?$/.exec(taskId);
  return m ? Number(m[1]) : 0;
}

/** Which retry of its slot an occurrence id is: 0 for `<job>~<seq>`, 1 for `...r`, k for `...rk`. */
function retryOrdinal(taskId: string): number {
  const m = /~\d+r(\d*)$/.exec(taskId);
  if (!m) return 0;
  return m[1] ? Number(m[1]) : 1;
}

/** The id of retry `k` of the slot of `taskId`: `<job>~<seq>r`, then `r2`, `r3`, ... */
function retryIdOf(taskId: string, k: number): string {
  const base = taskId.replace(/r\d*$/, "");
  return k === 1 ? `${base}r` : `${base}r${k}`;
}

function firstLine(text: string | undefined, max = 200): string {
  return (text ?? "").split("\n")[0]!.slice(0, max);
}

/** The occurrence's last `dispatched` event. */
function dispatchedEvent(scheduler: Scheduler, taskId: string): { at: string; details: Record<string, unknown> } | undefined {
  const events = scheduler.listTaskEvents(taskId);
  for (let i = events.length - 1; i >= 0; i--) if (events[i]!.kind === "dispatched") return events[i]!;
  return undefined;
}

/**
 * The failure class of a failed occurrence: the one its `failed` event
 * records, or, for a row from before classes were recorded, the one its
 * event's steps and its error give (a failure after the command step is
 * `after_command`, the Batch submit marker `batch_submit_interrupted`,
 * anything else `transient`, as those rows always got their one retry).
 */
function failureClassOf(scheduler: Scheduler, row: TaskRecord<unknown>): FailureClass {
  const events = scheduler.listTaskEvents(row.taskId);
  let details: Record<string, unknown> = {};
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.kind !== "failed") continue;
    details = events[i]!.details ?? {};
    break;
  }
  const recorded = details.failure_class;
  if (typeof recorded === "string" && (FAILURE_CLASSES as readonly string[]).includes(recorded)) return recorded as FailureClass;
  const steps = Array.isArray(details.steps) ? (details.steps as unknown[]).filter((s): s is string => typeof s === "string") : undefined;
  return classifyFailure({
    ...(steps?.includes("prompt") ? { steps } : {}),
    ...(row.error === BATCH_SUBMIT_INTERRUPTED_ERROR ? { interrupted: "batch_submit" as const } : {}),
  });
}

/**
 * When the next retry of a failed occurrence's slot starts, or undefined
 * for none: its class must allow a retry, the slot must have retries left
 * by the job's retry policy (its own value, the settings, the default), and
 * retry k starts the retry delay times 2^(k−1) after now, no later than the
 * slot's deadline.
 */
function jobRetryAt(scheduler: Scheduler, job: JobRecord, failed: TaskRecord<unknown>, nowMs: number): number | undefined {
  if (!isRetryableFailure(failureClassOf(scheduler, failed))) return undefined;
  const deadline = Date.parse(failed.deadline ?? "");
  if (!Number.isFinite(deadline)) return undefined;
  const plan = planRetry({
    attempt: job.retryUsed + 1,
    ...retryPolicyOf(jobRunLimits(job, scheduler)),
    failedAt: nowMs,
    deadline,
  });
  return "retryAt" in plan ? plan.retryAt : undefined;
}

/** The sleep counter a `dispatched` event stored (`details.sleep`), or null. */
function sleepAt(raw: unknown): SleepReading | null {
  const r = raw as Partial<SleepReading> | null | undefined;
  return r && Number.isFinite(r.boot_at) && Number.isFinite(r.slept_ms) ? { boot_at: r.boot_at!, slept_ms: r.slept_ms! } : null;
}

/** Reason on the occurrence's `cancelled` event (`paused`, `edited`, ... or none = a skip). */
function cancelReason(scheduler: Scheduler, taskId: string): string | undefined {
  const events = scheduler.listTaskEvents(taskId);
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.kind === "cancelled") {
      const reason = events[i]!.details.reason;
      return typeof reason === "string" ? reason : undefined;
    }
  }
  return undefined;
}

/**
 * Cancel a pending occurrence with a job reason. Pending only: a row a tick
 * claimed meanwhile runs to its end. Returns true when this call cancelled it.
 */
function cancelOccurrence(scheduler: Scheduler, taskId: string, jobId: string, reason: string, actor?: string): boolean {
  const row = scheduler.cancelTask(taskId, { actor, details: { job_id: jobId, reason }, expectedStatus: PENDING_STATUSES });
  return row.status === "cancelled";
}

/** The run fields of an occurrence body: what an edit of the template or the wake binding changes (KTD2, KTD7). */
function runFields(spec: Partial<ProviderCallSpec>): string {
  const { provider, model, prompt, tools, caps, command, summarize, jobWake } = spec;
  return canonicalize({ provider, model, prompt, tools: tools ?? [], caps, command, summarize, jobWake });
}

/** True when a stored occurrence runs what the job's current template gives. */
function runsCurrentTemplate(row: TaskRecord<unknown>, job: JobRecord): boolean {
  try {
    return runFields(JSON.parse(row.bodyJson ?? "null") as Partial<ProviderCallSpec>) === runFields(occurrenceBody(job));
  } catch {
    return false;
  }
}

function emptyResult(): JobSweepResult {
  return { messages: [], materialized: [], retried: [], autoPaused: [], interrupted: [], ended: [], sessionNotices: [] };
}

interface SweepOptions {
  /** Resume: a run-anchored job counts from now, not from its last run (R8). */
  fromNow?: boolean;
  /** Deadline of the first occurrence (AS9). */
  firstDeadline?: number;
  actor?: string;
  /**
   * Fail a `running` occurrence older than its caps (the daemon sweep only;
   * a page or CLI action never fails a run). `sleepNow` is the host's sleep
   * counter now: sleep since the dispatch does not count toward the age.
   */
  interruptCheck?: { sleepNow?: SleepReading | null };
}

/**
 * One job's step of the sweep: record the tracked occurrence's outcome and
 * keep one live occurrence. Retries a few times when another writer moved
 * the job row meanwhile.
 */
async function sweepJob(
  scheduler: Scheduler,
  jobId: string,
  now: Date,
  result: JobSweepResult,
  opts: SweepOptions = {},
): Promise<void> {
  const store = ledgerOf(scheduler);
  const nowMs = now.getTime();
  /** Rows this call inserted: cleaned up when every job write misses. */
  const inserted: string[] = [];
  /** Runs whose notice this call decided: a second attempt does not match the pattern again. */
  const notices = new Set<string>();
  for (let attempt = 0; attempt < 3; attempt++) {
    const job = store.getJob(jobId);
    if (!job || job.pauseReason === CORRUPT) return;
    const tracked = pendingRow(store, job);
    const orphans = store
      .list({ jobId, status: LIVE_STATUSES })
      .filter((t) => t.taskId !== job.pendingTaskId);

    // An inactive job keeps no pending occurrence (stop-flag-first rule).
    if (job.status !== "active") {
      let cancelled = false;
      for (const t of [...orphans, ...(tracked ? [tracked] : [])]) {
        if (!PENDING.has(t.status)) continue;
        cancelOccurrence(scheduler, t.taskId, jobId, job.status === "removed" ? "removed" : "paused", opts.actor);
        cancelled = true;
      }
      if (cancelled) continue;
    }

    if (tracked && LIVE.has(tracked.status)) {
      // Exactly one live occurrence: a second pending one is a duplicate.
      for (const t of orphans) if (PENDING.has(t.status)) cancelOccurrence(scheduler, t.taskId, jobId, "duplicate");
      if (tracked.status === "running" && opts.interruptCheck) {
        const outcome = interrupted(scheduler, store, job, tracked, nowMs, opts.interruptCheck.sleepNow);
        if (outcome === "failed") {
          result.interrupted.push(tracked.taskId);
          result.messages.push(`job ${jobId}: ${tracked.taskId} ${JOB_INTERRUPTED_ERROR}`);
          continue;
        }
        if (outcome === "submitted") {
          result.messages.push(`job ${jobId}: ${tracked.taskId} back to submitted: the tick stopped while it polled the batch`);
        }
      }
      return;
    }
    if (!tracked && job.status !== "active" && !(job.status === "paused" && pausedEndReason(job, nowMs))) return;

    // The tracked occurrence ended (or there is none): record the outcome.
    const next: JobRecord = { ...job, updatedAt: now.toISOString() };
    let successor: "next" | "retry" | "none" = job.status === "active" ? "next" : "none";
    let skippedDeadline: string | undefined;
    let retryAt: number | undefined;
    /** The tracked slot ended for good: completed, or failed with no retry left. */
    let slotEnded = false;
    if (tracked) {
      next.pendingTaskId = undefined;
      next.lastTaskId = tracked.taskId;
      next.lastRunStartedAt = dispatchedEvent(scheduler, tracked.taskId)?.at ?? job.lastRunStartedAt;
      if (tracked.status === "completed") {
        next.lastOutcome = "ok";
        next.consecutiveFailures = 0;
        slotEnded = true;
      } else if (tracked.status === "failed") {
        next.lastOutcome = "failed";
        // A run stopped during its Batch submit may have a batch at the
        // provider, and a failed LLM step ran its command already: neither
        // class retries, nor a permanent failure.
        retryAt = successor === "next" ? jobRetryAt(scheduler, job, tracked, nowMs) : undefined;
        if (retryAt !== undefined) {
          successor = "retry";
        } else {
          slotEnded = true;
          next.consecutiveFailures = job.consecutiveFailures + 1;
          if (successor === "next" && next.consecutiveFailures >= JOB_AUTO_PAUSE_FAILURES) {
            successor = "none";
            next.status = "paused";
            next.pauseReason = `${JOB_AUTO_PAUSE_PREFIX}${firstLine(tracked.error) || "failed"}`;
            next.pausedAt = now.toISOString();
            next.pauseNotifiedAt = undefined;
            result.autoPaused.push(jobId);
          }
        }
      } else if (!ACTION_CANCEL_REASONS.has(cancelReason(scheduler, tracked.taskId) ?? "")) {
        // A plain cancel of an occurrence is a skip: the counter stays.
        next.lastOutcome = "skipped";
        skippedDeadline = tracked.deadline;
      }
    }

    // A live row nobody tracks (a crash between an insert and its job
    // write): adopt it instead of inserting a second one (KTD4). A pending
    // one made from a template an edit has since replaced never runs: it is
    // cancelled as edited and a fresh one is made (follow-ups KTD2). The
    // cancelled row keeps its id, so the fresh one takes a later sequence.
    const adoptable: TaskRecord<unknown>[] = [];
    const edited: string[] = [];
    if (successor !== "none") {
      for (const t of orphans) {
        if (PENDING.has(t.status) && !runsCurrentTemplate(t, next) && cancelOccurrence(scheduler, t.taskId, jobId, "edited", opts.actor)) {
          edited.push(t.taskId);
        } else {
          adoptable.push(t);
        }
      }
    }
    const freeSeq = Math.max(job.nextSeq, ...edited.map((id) => seqOf(id) + 1));
    const retryId = tracked && successor === "retry" ? retryIdOf(tracked.taskId, job.retryUsed + 1) : undefined;
    // The edit replaced the template the retry would run: make a regular
    // occurrence of the new template instead; the failure is not counted.
    if (retryId && edited.includes(retryId)) successor = "next";
    if (slotEnded && next.runsLeft !== undefined) next.runsLeft = Math.max(0, next.runsLeft - 1);
    // The end wins over the auto-pause: a last slot that also paused the job ends it.
    const endReason = successor === "retry" ? undefined : jobEndReason(next, job.status, tracked, nowMs, skippedDeadline, opts);
    if (endReason) {
      successor = "none";
      if (next.status === "paused" && job.status === "active") {
        result.autoPaused = result.autoPaused.filter((id) => id !== jobId);
        next.pauseReason = job.pauseReason;
        next.pausedAt = job.pausedAt;
        next.pauseNotifiedAt = job.pauseNotifiedAt;
      }
      next.status = "ended";
      next.endedAt = now.toISOString();
      next.endReason = endReason;
      next.endNotifiedAt = undefined;
    }
    const adopt = endReason ? undefined : adoptable[adoptable.length - 1];
    let taskId: string | undefined;
    if (adopt) {
      taskId = adopt.taskId;
      next.nextSeq = Math.max(freeSeq, seqOf(adopt.taskId) + 1);
      next.retryUsed = retryOrdinal(adopt.taskId);
      for (const t of adoptable) {
        if (t !== adopt && PENDING.has(t.status)) cancelOccurrence(scheduler, t.taskId, jobId, "duplicate");
      }
    } else if (successor === "retry" && retryId) {
      taskId = retryId;
      next.retryUsed = job.retryUsed + 1;
      if (await materialize(scheduler, next, taskId, retryAt!, Date.parse(tracked!.deadline!), "retry")) {
        inserted.push(taskId);
        result.retried.push(taskId);
        result.materialized.push(taskId);
      }
    } else if (successor === "next") {
      const occ = firstOccurrence(next, tracked, nowMs, skippedDeadline, opts);
      taskId = `${jobId}~${freeSeq}`;
      next.nextSeq = freeSeq + 1;
      next.retryUsed = 0;
      if (await materialize(scheduler, next, taskId, occ.earliest, occ.deadline, occ.anchor)) {
        inserted.push(taskId);
        result.materialized.push(taskId);
      }
    }
    next.pendingTaskId = taskId;
    // The run's session notice goes in before the job write, so a reader
    // never sees the job ended (or moved on) without it (KTD9).
    if (tracked && successor !== "retry") recordJobNotice(store, job, tracked, slotEnded, endReason !== undefined, result, notices);
    // A miss: another writer moved the job meanwhile. The next pass adopts
    // the insert on an active job, or cancels it on an inactive one.
    if (store.updateJobIf(next, job.revision)) {
      if (endReason) {
        result.ended.push(jobId);
        // The sweep skips an ended job, so no later pass cancels a stray pending row.
        for (const t of orphans) if (PENDING.has(t.status)) cancelOccurrence(scheduler, t.taskId, jobId, "ended", opts.actor);
      }
      return;
    }
  }
  result.messages.push(`job ${jobId}: the job row kept changing; left for the next sweep`);
  // No pass is left to cancel this call's insert on a job that stopped
  // meanwhile (stop-flag-first rule), so cancel it here.
  const latest = store.getJob(jobId);
  if (latest?.status === "active") return;
  for (const id of inserted) cancelOccurrence(scheduler, id, jobId, latest?.status === "paused" ? "paused" : "removed", opts.actor);
}

/**
 * The session notice of a finished run of a bound job (KTD9), written as a
 * `session_notice` event when the run has a reason: `failed` when its slot
 * failed for good, `matched` when the job is under `match`, the run
 * completed and its result text matches, `ended` when this outcome ends the
 * job. It wakes the session for `failed` under `failures` and for
 * `matched`, while the job is active. A run of another session (made before a rebind), or of a job
 * no longer bound, gets nothing.
 */
function recordJobNotice(
  store: TaskStore,
  job: JobRecord,
  run: TaskRecord<unknown>,
  slotEnded: boolean,
  ended: boolean,
  result: JobSweepResult,
  decided: Set<string>,
): void {
  const session = jobWakeSession(job);
  if (!session || run.originSessionId !== session || decided.has(run.taskId) || !run.completedAt) return;
  decided.add(run.taskId);
  const reasons: JobNoticeReason[] = [];
  const failed = run.status === "failed" && slotEnded;
  if (failed) reasons.push("failed");
  if (job.wake!.on === "match" && run.status === "completed") {
    const m = matchWake(job.wake!.pattern ?? "", taskResultText(run) ?? "");
    if (m.timedOut) result.messages.push(`job ${job.jobId}: ${run.taskId}: the wake pattern timed out; counted as matched`);
    if (m.broken) result.messages.push(`job ${job.jobId}: ${run.taskId}: the wake pattern does not compile; counted as matched`);
    if (m.matched) reasons.push("matched");
  }
  if (ended) reasons.push("ended");
  if (reasons.length === 0) return;
  // A run that finished after someone paused or removed its job is a notice for the next prompt, not a wake.
  const wake = job.status === "active" && ((failed && job.wake!.on === "failures") || reasons.includes("matched"));
  if (store.recordSessionNotice(run.taskId, { reasons, wake })) result.sessionNotices.push(run.taskId);
}

/** The `until` bound of a job in ms, or undefined when it has none or the stored text does not parse. */
function untilBound(job: JobRecord): number | undefined {
  if (job.until === undefined) return undefined;
  try {
    return untilBoundMs(job.until, job.timeZone);
  } catch {
    return undefined;
  }
}

/** Why a paused job ends with no run: its runs are done, or its end date passed. */
function pausedEndReason(job: JobRecord, nowMs: number): JobEndReason | undefined {
  if (job.runsLeft !== undefined && job.runsLeft <= 0) return "count";
  const bound = untilBound(job);
  return bound !== undefined && bound <= nowMs ? "until" : undefined;
}

/**
 * Why `next` ends instead of getting its next occurrence, or undefined. An
 * active job ends when its runs are done or its next regular occurrence
 * would start at or after the `until` bound; a paused one when its runs are
 * done or the bound passed. `status` is the job's status before this pass.
 */
function jobEndReason(
  next: JobRecord,
  status: JobRecord["status"],
  tracked: TaskRecord<unknown> | undefined,
  nowMs: number,
  skippedDeadline: string | undefined,
  opts: SweepOptions,
): JobEndReason | undefined {
  if (status === "paused") return pausedEndReason(next, nowMs);
  if (status !== "active") return undefined;
  if (next.runsLeft !== undefined && next.runsLeft <= 0) return "count";
  const bound = untilBound(next);
  if (bound === undefined) return undefined;
  return firstOccurrence(next, tracked, nowMs, skippedDeadline, opts).earliest >= bound ? "until" : undefined;
}

/** `[earliest, deadline]` of the next regular occurrence, in ms. */
function firstOccurrence(
  job: JobRecord,
  tracked: TaskRecord<unknown> | undefined,
  nowMs: number,
  skippedDeadline: string | undefined,
  opts: SweepOptions,
): { earliest: number; deadline: number; anchor: string } {
  if (opts.firstDeadline !== undefined && !tracked) {
    return { earliest: nowMs, deadline: opts.firstDeadline, anchor: "deadline" };
  }
  const schedule = scheduleOf(job);
  const calendar = isCalendarAnchored(schedule);
  // Resume counts from now only for a run-anchored job. A calendar job
  // keeps its last run, so a slot it already ran in is not run again; no
  // backfill follows anyway, as a slot must end after now.
  const fromNow = opts.fromNow === true && !calendar;
  let lastRunStart = fromNow ? undefined : job.lastRunStartedAt;
  // A calendar slot is used once, run or not: an occurrence that finished
  // without running (failed before dispatch) still moves on to the next
  // slot. A job action's cancel (edit, pause) used nothing. Run now clears
  // `notBefore`; the last minute before the deadline then marks the slot.
  const used = tracked?.status === "completed" || tracked?.status === "failed";
  const slotMark = tracked?.notBefore ?? (tracked?.deadline ? new Date(Date.parse(tracked.deadline) - MINUTE_MS).toISOString() : undefined);
  if (calendar && used && slotMark && !fromNow) {
    if (!lastRunStart || Date.parse(slotMark) > Date.parse(lastRunStart)) lastRunStart = slotMark;
  }
  const occ = nextOccurrence(schedule, { now: nowMs, lastRunStart, skippedDeadline });
  return { earliest: Date.parse(occ.earliest), deadline: Date.parse(occ.deadline), anchor: occ.anchor };
}

async function materialize(
  scheduler: Scheduler,
  job: JobRecord,
  taskId: string,
  earliest: number,
  deadline: number,
  anchor: string,
): Promise<boolean> {
  const t = job.template;
  return scheduler.materializeOccurrence(
    {
      taskId,
      jobId: job.jobId,
      earliest: new Date(earliest).toISOString(),
      deadline: new Date(deadline).toISOString(),
      title: job.title,
      bodyJson: JSON.stringify(occurrenceBody(job)),
      originHost: job.originHost && TASK_ORIGIN_HOSTS.has(job.originHost) ? (job.originHost as TaskOriginHost) : undefined,
      originCwd: t.cwd,
      originSessionId: jobWakeSession(job),
    },
    { job_id: job.jobId, seq: seqOf(taskId), anchor },
  );
}

/**
 * How long a run may last before the time rule frees it: its time limits
 * plus a grace period, so the limit is generous. The limits are the ones
 * its `dispatched` event recorded; a run dispatched before they were
 * recorded gets the ones it would get now. Undefined when a limit is
 * `none`: such a run is freed only by the tick lock rule. A row with no
 * usable `dispatched` event (a Batch row) counts from its deadline, and no
 * LLM time limit applies to a Batch run, so there a `none` limit adds
 * nothing instead.
 */
function runTimeAllowance(
  scheduler: Scheduler,
  row: TaskRecord<unknown>,
  dispatched: { details: Record<string, unknown> } | undefined,
): number | undefined {
  let limits: ResolvedRunLimits | undefined = runLimitsFromDetails(dispatched?.details);
  if (!limits) {
    let spec: ProviderCallSpec | undefined;
    try {
      spec = JSON.parse(row.bodyJson ?? "null") as ProviderCallSpec | undefined;
    } catch {
      spec = undefined;
    }
    if (!spec || typeof spec.provider !== "string") return INTERRUPT_GRACE_MS;
    limits = scheduler.runLimitsFor(spec);
  }
  let total = INTERRUPT_GRACE_MS;
  for (const limit of [limits.command_timeout, limits.llm_timeout]) {
    if (!limit) continue;
    if (limit.value === "none") {
      if (dispatched) return undefined;
      continue;
    }
    total += limit.value;
  }
  return total;
}

/**
 * The time rule of a running occurrence: its dispatch is older than its
 * time limits plus a grace period ({@link runTimeAllowance}). A run with a
 * `none` limit never counts as too old, unless its age counts from the
 * deadline (below).
 *
 * The age counts from the last `dispatched` event. Two `running` rows have
 * no usable one and count from the deadline instead: a Batch row being
 * polled (its event is the submit, hours old) and a row whose tick died
 * between the claim and the event (Batch submit). Neither can run past
 * its deadline legitimately (Batch rows have a deadline over a day ahead).
 */
function olderThanLimits(
  scheduler: Scheduler,
  row: TaskRecord<unknown>,
  nowMs: number,
  sleepNow: SleepReading | null | undefined,
): boolean {
  const dispatched = row.batchId ? undefined : dispatchedEvent(scheduler, row.taskId);
  const started = Date.parse(dispatched?.at ?? row.deadline ?? "");
  if (!Number.isFinite(started)) return false;
  const limit = runTimeAllowance(scheduler, row, dispatched);
  if (limit === undefined) return false;
  const wallAge = nowMs - started;
  const sleepThen = sleepAt(dispatched?.details.sleep);
  if (sleepThen && !sleepNow) {
    // This host cannot read the sleep counter, but the run's ticker could:
    // the run may have slept. Wait for its deadline plus the limits, so a
    // host that reads the counter decides first, and a dead tick still
    // frees the job at the latest then.
    const deadline = Date.parse(row.deadline ?? "");
    return nowMs - (Number.isFinite(deadline) ? Math.max(deadline, started) : started) > limit;
  }
  // Awake time only: a run the machine slept through is still running.
  const slept = sleptBetween(sleepThen, sleepNow, wallAge);
  return wallAge - slept > limit;
}

/**
 * A running occurrence whose tick died. Fail it by compare-and-set from
 * `running`; a completion that lands after this write is dropped. A row with
 * a batch id was being polled: its batch is live at the provider, so it goes
 * back to `submitted` (compare-and-set from `running`) and the next tick
 * polls it again. Returns what this call wrote: "failed", "submitted", or
 * undefined for nothing.
 *
 * Under the tick lock, a run whose dispatch carries tick details follows the
 * tick lock rule ({@link Scheduler.deadTickRun}): it is freed as soon as the
 * tick that ran it is gone, and never while that tick's process runs. Any
 * other run, a run whose tick the host cannot judge included, is freed when
 * it is older than its time limits plus a grace period ({@link olderThanLimits}).
 */
function interrupted(
  scheduler: Scheduler,
  store: TaskStore,
  job: JobRecord,
  row: TaskRecord<unknown>,
  nowMs: number,
  sleepNow: SleepReading | null | undefined,
): "failed" | "submitted" | undefined {
  const deadTick = scheduler.deadTickRun(row);
  if (deadTick === false) return undefined;
  if (deadTick === undefined && !olderThanLimits(scheduler, row, nowMs, sleepNow)) return undefined;
  if (row.batchId) {
    return store.transitionIf({ ...row, status: "submitted", completedAt: undefined, error: undefined }, ["running"]) ? "submitted" : undefined;
  }
  const failed = store.transitionIf(
    { ...row, status: "failed", completedAt: new Date(nowMs).toISOString(), error: JOB_INTERRUPTED_ERROR },
    ["running"],
    undefined,
    // A job run fails for good here; the sweep's next pass makes its slot's retry row by the retry policy.
    { kind: "failed", actor: "system", details: { job_id: job.jobId, reason: "interrupted", attempts: 1, failure_class: "interrupted" } },
  );
  return failed ? "failed" : undefined;
}

/**
 * The job sweep (KTD2): for every job, record the outcome of its finished
 * occurrence and keep one live occurrence per active job. Never throws.
 */
export async function sweepJobs(
  scheduler: Scheduler,
  now: Date = new Date(),
  opts: { sleepNow?: SleepReading | null } = {},
): Promise<JobSweepResult> {
  const result = emptyResult();
  let jobs: JobRecord[];
  try {
    const store = scheduler.ledger();
    if (!store) return result;
    jobs = store.listJobs({ status: ["active", "paused", "removed"] }).filter((j) => j.status !== "removed" || j.pendingTaskId !== undefined);
  } catch (err) {
    result.messages.push(`job sweep: cannot read the ledger: ${errMessage(err)}`);
    return result;
  }
  for (const job of jobs) {
    try {
      await sweepJob(scheduler, job.jobId, now, result, { interruptCheck: { sleepNow: opts.sleepNow } });
    } catch (err) {
      result.messages.push(`job sweep: ${job.jobId}: ${errMessage(err)}`);
    }
  }
  for (const id of result.materialized) result.messages.push(`materialized job occurrence ${id}`);
  for (const id of result.autoPaused) result.messages.push(`paused job ${id} after ${JOB_AUTO_PAUSE_FAILURES} failed runs`);
  for (const id of result.ended) result.messages.push(`ended job ${id}`);
  return result;
}

/** Create a job and its first occurrence. Throws {@link JobActionError} on bad input. */
export async function createJob(scheduler: Scheduler, input: JobInput, opts: JobActionOptions = {}): Promise<JobRecord> {
  const store = ledgerOf(scheduler);
  const now = new Date();
  const schedule = validSchedule({ cadence: input.cadence, window: input.window, timeZone: input.timeZone ?? systemTimeZone() });
  let firstDeadline: number | undefined;
  if (input.deadline !== undefined) {
    firstDeadline = new Date(input.deadline).getTime();
    if (!Number.isFinite(firstDeadline) || firstDeadline <= now.getTime()) {
      throw new JobActionError("deadline must be a future instant", "invalid");
    }
  }
  if (input.originHost !== undefined && !ORIGIN_HOSTS.has(input.originHost)) {
    throw new JobActionError("originHost must be page, cli, mcp or openclaw", "invalid");
  }
  const job: JobRecord = {
    jobId: newJobId(store),
    title: validTitle(input.title),
    status: "active",
    cadence: schedule.cadence,
    window: schedule.window,
    timeZone: schedule.timeZone,
    template: validTemplate(input.template),
    caps: validCaps({}, input.caps),
    notify: input.notify === undefined ? "every_run" : validNotify(input.notify),
    originHost: input.originHost,
    originCwd: input.originCwd,
    createdBy: opts.actor,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    revision: 1,
    nextSeq: 1,
    consecutiveFailures: 0,
    retryUsed: 0,
    until: validUntil(input.until, schedule.timeZone, now.getTime()),
    runsLeft: validCount(input.count),
    ...(input.wake ? validWake(input.wake, now) : {}),
  };
  // A job that would end before its first run is a mistake, not a job.
  const bound = untilBound(job);
  if (bound !== undefined) {
    const first = firstOccurrence(job, undefined, now.getTime(), undefined, { firstDeadline }).earliest;
    if (first >= bound) {
      throw new JobActionError(`until "${job.until}" comes before the first run (${new Date(first).toISOString()}); give a later day or instant`, "invalid");
    }
  }
  store.insertJob(job);
  try {
    await sweepJob(scheduler, job.jobId, now, emptyResult(), { firstDeadline, actor: opts.actor });
  } catch (err) {
    // All or nothing (follow-ups KTD3): a create that reports failure
    // leaves no job and no occurrence behind, so a retry makes one job.
    abandonJob(scheduler, store, job.jobId, opts.actor);
    throw err;
  }
  return store.getJob(job.jobId)!;
}

/** Undo a create whose first sweep threw: mark the job removed, cancel its pending rows. Best effort. */
function abandonJob(scheduler: Scheduler, store: TaskStore, jobId: string, actor?: string): void {
  try {
    writeJob(store, jobId, (job) => ({ ...job, status: "removed", pendingTaskId: undefined }));
  } catch {
    // The rows below are still cancelled; a later sweep skips a removed job.
  }
  try {
    for (const t of store.list({ jobId, status: PENDING_STATUSES })) cancelOccurrence(scheduler, t.taskId, jobId, "removed", actor);
  } catch {
    // Same ledger error as the sweep's: the sweep cancels these rows of a removed job.
  }
}

function requireJob(store: TaskStore, jobId: string): JobRecord {
  const job = store.getJob(jobId);
  if (!job) throw new JobActionError(`job ${JSON.stringify(jobId)} not found`, "not_found");
  return job;
}

/** The job's tracked occurrence row, if it has one. */
function pendingRow(store: TaskStore, job: JobRecord): TaskRecord<unknown> | undefined {
  return job.pendingTaskId ? store.get(job.pendingTaskId) : undefined;
}

/** Refuse every action but remove on a removed or ended job, or one whose stored template does not parse. */
function requireEditable(job: JobRecord): void {
  if (job.status === "removed") throw new JobActionError("job was removed");
  if (job.status === "ended") throw new JobActionError(`job ended (${jobEndText(job.endReason, job.until)}); add a new job`);
  if (job.pauseReason === CORRUPT) throw new JobActionError(`job ${job.jobId} has a corrupt template; remove it and create it again`);
}

/**
 * Write `change(job)` with a compare-and-set, re-reading once on a miss.
 * `change` throws {@link JobActionError} to refuse.
 */
function writeJob(store: TaskStore, jobId: string, change: (job: JobRecord) => JobRecord): { before: JobRecord; after: JobRecord } {
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = requireJob(store, jobId);
    const after = { ...change(before), updatedAt: new Date().toISOString() };
    if (store.updateJobIf(after, before.revision)) return { before, after };
  }
  throw new JobActionError(`job ${jobId} changed meanwhile; try again`);
}

/** Cancel the job's pending occurrence, if it has one, with a job-action reason. */
function cancelPending(scheduler: Scheduler, store: TaskStore, job: JobRecord, reason: string, actor?: string): void {
  const row = pendingRow(store, job);
  if (row && PENDING.has(row.status)) cancelOccurrence(scheduler, row.taskId, job.jobId, reason, actor);
}

/**
 * Change a job; the pending occurrence is replaced by one on the new rule (a
 * running one keeps its template). With `expectedRevision`, a job another
 * writer changed since is refused with reason `stale_revision`.
 */
export async function updateJob(scheduler: Scheduler, jobId: string, patch: JobPatch, opts: JobUpdateOptions = {}): Promise<JobRecord> {
  const store = ledgerOf(scheduler);
  const { before } = writeJob(store, jobId, (job) => {
    requireEditable(job);
    if (opts.expectedRevision !== undefined && job.revision !== opts.expectedRevision) {
      throw new JobActionError(`job changed meanwhile (revision ${job.revision}); reload it and try again`, "conflict", "stale_revision");
    }
    const schedule = validSchedule({
      cadence: patch.cadence ?? job.cadence,
      window: patch.window === null ? undefined : (patch.window ?? job.window),
      timeZone: patch.timeZone ?? job.timeZone,
    });
    return {
      ...job,
      title: patch.title !== undefined ? validTitle(patch.title) : job.title,
      cadence: schedule.cadence,
      window: schedule.window,
      timeZone: schedule.timeZone,
      template: patch.template !== undefined ? validTemplate(patch.template) : job.template,
      caps: validCaps(job.caps, patch.caps),
      notify: patch.notify !== undefined ? validNotify(patch.notify) : job.notify,
      // A new zone moves a day bound, so the kept `until` is checked again.
      until:
        patch.until !== undefined || schedule.timeZone !== job.timeZone
          ? validUntil(patch.until !== undefined ? patch.until : job.until, schedule.timeZone, Date.now())
          : job.until,
      runsLeft: patch.count !== undefined ? validCount(patch.count) : job.runsLeft,
      // A wake edit rebinds the job to the session that makes it; a page edit keeps the binding.
      ...(patch.wake !== undefined ? validWake(patch.wake, new Date()) : {}),
    };
  });
  cancelPending(scheduler, store, before, "edited", opts.actor);
  await sweepJob(scheduler, jobId, new Date(), emptyResult(), { actor: opts.actor });
  return store.getJob(jobId)!;
}

/** Pause an active job; its pending occurrence is cancelled, a running one finishes with no successor. */
export async function pauseJob(scheduler: Scheduler, jobId: string, opts: JobActionOptions = {}): Promise<JobRecord> {
  const store = ledgerOf(scheduler);
  const now = new Date();
  const { after } = writeJob(store, jobId, (job) => {
    requireEditable(job);
    if (job.status === "paused") throw new JobActionError("job is already paused");
    return { ...job, status: "paused", pauseReason: "manual", pausedAt: now.toISOString(), pauseNotifiedAt: undefined };
  });
  cancelPending(scheduler, store, after, "paused", opts.actor);
  await sweepJob(scheduler, jobId, now, emptyResult(), { actor: opts.actor });
  return store.getJob(jobId)!;
}

/** Resume a paused job: counter reset, one occurrence from now, no backfill (R8). */
export async function resumeJob(scheduler: Scheduler, jobId: string, opts: JobActionOptions = {}): Promise<JobRecord> {
  const store = ledgerOf(scheduler);
  writeJob(store, jobId, (job) => {
    requireEditable(job);
    if (job.status === "active") throw new JobActionError("job is not paused");
    return {
      ...job,
      status: "active",
      consecutiveFailures: 0,
      retryUsed: 0,
      pauseReason: undefined,
      pausedAt: undefined,
      pauseNotifiedAt: undefined,
    };
  });
  await sweepJob(scheduler, jobId, new Date(), emptyResult(), { fromNow: true, actor: opts.actor });
  return store.getJob(jobId)!;
}

/**
 * Run a job at the next tick (AS10): its pending occurrence is expedited
 * (no second row). Refused while an occurrence runs or the job is paused.
 * Returns the expedited occurrence.
 */
export async function runJobNow(scheduler: Scheduler, jobId: string, opts: JobActionOptions = {}): Promise<TaskRecord<unknown>> {
  const store = ledgerOf(scheduler);
  let job = requireJob(store, jobId);
  requireEditable(job);
  refuseIfPaused(job);
  let row = pendingRow(store, job);
  if (!row || !LIVE.has(row.status)) {
    await sweepJob(scheduler, jobId, new Date(), emptyResult(), { actor: opts.actor });
    job = requireJob(store, jobId);
    // The sweep may have just ended the job or auto-paused it (its third failed slot).
    requireEditable(job);
    refuseIfPaused(job);
    row = pendingRow(store, job);
  }
  if (row && (row.status === "running" || row.status === "submitted")) {
    throw new JobActionError("an occurrence is already running");
  }
  if (!row || !PENDING.has(row.status)) throw new JobActionError(`job ${jobId} has no occurrence to run`);
  return scheduler.runNow(row.taskId, { actor: opts.actor });
}

/** Refuse run now on a paused job, naming the failure when the job paused itself. */
function refuseIfPaused(job: JobRecord): void {
  if (job.status !== "paused") return;
  const auto = jobAutoPauseReason(job.pauseReason);
  throw new JobActionError(auto ? `job is paused after ${JOB_AUTO_PAUSE_FAILURES} failures: ${auto}` : "job is paused");
}

/** Remove a job: it stops and is hidden; its rows and history stay (AS11). */
export async function removeJob(scheduler: Scheduler, jobId: string, opts: JobActionOptions = {}): Promise<JobRecord> {
  const store = ledgerOf(scheduler);
  const { after } = writeJob(store, jobId, (job) => {
    if (job.status === "removed") throw new JobActionError("job was removed");
    return { ...job, status: "removed" };
  });
  cancelPending(scheduler, store, after, "removed", opts.actor);
  await sweepJob(scheduler, jobId, new Date(), emptyResult(), { actor: opts.actor });
  return store.getJob(jobId)!;
}

/** One job, removed ones included; undefined when the id is unknown. */
export function getJob(scheduler: Scheduler, jobId: string): JobRecord | undefined {
  return ledgerOf(scheduler).getJob(jobId);
}

/** Jobs, oldest first; removed and ended jobs are hidden unless asked for. */
export function listJobs(scheduler: Scheduler, opts: { includeRemoved?: boolean } = {}): JobRecord[] {
  return ledgerOf(scheduler).listJobs(opts.includeRemoved ? {} : { status: ["active", "paused"] });
}

/** A job's occurrences, newest first. */
export function jobHistory(scheduler: Scheduler, jobId: string, limit = 20): JobHistoryEntry[] {
  const store = ledgerOf(scheduler);
  requireJob(store, jobId);
  return store
    .list({ jobId, newestFirst: true, limit: Math.max(0, limit) })
    .map((t) => ({
      taskId: t.taskId,
      status: t.status,
      enqueuedAt: t.enqueuedAt,
      scheduledFor: t.scheduledFor,
      deadline: t.deadline,
      completedAt: t.completedAt,
      hasReceipt: t.receipt !== undefined,
      carbonG: t.receipt?.actualCarbonGCo2 ?? t.receipt?.estimatedCarbonGCo2 ?? t.estimatedCarbonGCo2,
      error: t.status === "failed" ? firstLine(t.error) : undefined,
    }));
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
