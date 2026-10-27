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
 *   - live occurrence: nothing (R17), except a `running` one whose dispatch
 *     is older than its caps allow, which fails as interrupted;
 *   - finished occurrence: records the outcome (KTD9: ok, a failure with
 *     one retry per slot and auto-pause after three failed slots, or a
 *     skip), then materializes the next occurrence;
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
import { deriveTitle } from "./history.js";
import { isCalendarAnchored, JobScheduleError, nextOccurrence, validateJobSchedule, type JobSchedule } from "./job-cadence.js";
import { sleptBetween, type SleepReading } from "./readiness.js";
import type { Scheduler } from "./scheduler.js";
import { canonicalize } from "./sign.js";
import type { TaskStore } from "./storage/sqlite.js";
import { systemTimeZone } from "./zone-time.js";
import {
  DEFAULT_JOB_CAPS,
  type JobCadence,
  type JobCaps,
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
  caps?: Partial<JobCaps>;
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
}

/** The fields {@link updateJob} can change; `window: null` removes the window. */
export interface JobPatch {
  title?: string;
  cadence?: JobCadence;
  window?: JobWindow | null;
  timeZone?: string;
  template?: JobTemplate;
  caps?: Partial<JobCaps>;
  notify?: JobNotify;
}

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
const ACTION_CANCEL_REASONS: ReadonlySet<string> = new Set(["paused", "edited", "removed", "duplicate"]);

const MINUTE_MS = 60_000;
/** Delay before the one retry of a failed slot. */
export const JOB_RETRY_DELAY_MS = 30 * MINUTE_MS;
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

function validCaps(base: JobCaps, patch: Partial<JobCaps> | undefined): JobCaps {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (!(key in DEFAULT_JOB_CAPS)) throw new JobActionError(`unknown cap "${key}"`, "invalid");
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new JobActionError(`cap ${key} must be a positive number`, "invalid");
    }
    out[key as keyof JobCaps] = value;
  }
  return out;
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

function newJobId(store: TaskStore): string {
  for (;;) {
    const id = `job-${randomBytes(4).toString("hex")}`;
    if (!store.getJob(id)) return id;
  }
}

/** The occurrence body a job's template runs (Data shapes in the plan). */
function occurrenceBody(job: JobRecord): ProviderCallSpec {
  const t = job.template;
  if (t.runner === "prompt") {
    return {
      type: "provider_call",
      provider: t.provider,
      model: t.model ?? DEFAULT_MODEL_BY_PROVIDER[t.provider],
      prompt: t.prompt,
      tools: TOOLS[t.tools],
      caps: job.caps,
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
  };
}

function scheduleOf(job: JobRecord): JobSchedule {
  return { cadence: job.cadence, window: job.window, timeZone: job.timeZone };
}

/** Sequence number of an occurrence id `<job>~<seq>` or `<job>~<seq>r`. */
function seqOf(taskId: string): number {
  const m = /~(\d+)r?$/.exec(taskId);
  return m ? Number(m[1]) : 0;
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
 * True when the occurrence failed after its command step ran: the `failed`
 * event lists the `prompt` step (the summarize step failed). A slot retry
 * would run the command again, so there is none.
 */
function failedAfterCommand(scheduler: Scheduler, taskId: string): boolean {
  const events = scheduler.listTaskEvents(taskId);
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.kind !== "failed") continue;
    const steps = events[i]!.details?.steps;
    return Array.isArray(steps) && steps.includes("prompt");
  }
  return false;
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

/** The run fields of an occurrence body: what an edit of the template changes (KTD2). */
function runFields(spec: Partial<ProviderCallSpec>): string {
  const { provider, model, prompt, tools, caps, command, summarize } = spec;
  return canonicalize({ provider, model, prompt, tools: tools ?? [], caps, command, summarize });
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
  return { messages: [], materialized: [], retried: [], autoPaused: [], interrupted: [] };
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
      if (tracked.status === "running" && opts.interruptCheck && interrupted(scheduler, store, job, tracked, nowMs, opts.interruptCheck.sleepNow)) {
        result.interrupted.push(tracked.taskId);
        result.messages.push(`job ${jobId}: ${tracked.taskId} ${JOB_INTERRUPTED_ERROR}`);
        continue;
      }
      return;
    }
    if (!tracked && job.status !== "active") return;

    // The tracked occurrence ended (or there is none): record the outcome.
    const next: JobRecord = { ...job, updatedAt: now.toISOString() };
    let successor: "next" | "retry" | "none" = job.status === "active" ? "next" : "none";
    let skippedDeadline: string | undefined;
    if (tracked) {
      next.pendingTaskId = undefined;
      next.lastTaskId = tracked.taskId;
      next.lastRunStartedAt = dispatchedEvent(scheduler, tracked.taskId)?.at ?? job.lastRunStartedAt;
      if (tracked.status === "completed") {
        next.lastOutcome = "ok";
        next.consecutiveFailures = 0;
      } else if (tracked.status === "failed") {
        next.lastOutcome = "failed";
        const left = tracked.deadline ? Date.parse(tracked.deadline) - nowMs : 0;
        if (successor === "next" && !job.retryUsed && left >= JOB_RETRY_DELAY_MS && !failedAfterCommand(scheduler, tracked.taskId)) {
          successor = "retry";
        } else {
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
    const retryId = tracked && successor === "retry" ? `${tracked.taskId.replace(/r$/, "")}r` : undefined;
    // The edit replaced the template the retry would run: make a regular
    // occurrence of the new template instead; the failure is not counted.
    if (retryId && edited.includes(retryId)) successor = "next";
    const adopt = adoptable[adoptable.length - 1];
    let taskId: string | undefined;
    if (adopt) {
      taskId = adopt.taskId;
      next.nextSeq = Math.max(freeSeq, seqOf(adopt.taskId) + 1);
      next.retryUsed = adopt.taskId.endsWith("r");
      for (const t of adoptable) {
        if (t !== adopt && PENDING.has(t.status)) cancelOccurrence(scheduler, t.taskId, jobId, "duplicate");
      }
    } else if (successor === "retry" && retryId) {
      taskId = retryId;
      next.retryUsed = true;
      if (await materialize(scheduler, next, taskId, nowMs + JOB_RETRY_DELAY_MS, Date.parse(tracked!.deadline!), "retry")) {
        inserted.push(taskId);
        result.retried.push(taskId);
        result.materialized.push(taskId);
      }
    } else if (successor === "next") {
      const occ = firstOccurrence(next, tracked, nowMs, skippedDeadline, opts);
      taskId = `${jobId}~${freeSeq}`;
      next.nextSeq = freeSeq + 1;
      next.retryUsed = false;
      if (await materialize(scheduler, next, taskId, occ.earliest, occ.deadline, occ.anchor)) {
        inserted.push(taskId);
        result.materialized.push(taskId);
      }
    }
    next.pendingTaskId = taskId;
    // A miss: another writer moved the job meanwhile. The next pass adopts
    // the insert on an active job, or cancels it on an inactive one.
    if (store.updateJobIf(next, job.revision)) return;
  }
  result.messages.push(`job ${jobId}: the job row kept changing; left for the next sweep`);
  // No pass is left to cancel this call's insert on a job that stopped
  // meanwhile (stop-flag-first rule), so cancel it here.
  const latest = store.getJob(jobId);
  if (latest?.status === "active") return;
  for (const id of inserted) cancelOccurrence(scheduler, id, jobId, latest?.status === "paused" ? "paused" : "removed", opts.actor);
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
    },
    { job_id: job.jobId, seq: seqOf(taskId), anchor },
  );
}

/**
 * A running occurrence whose dispatch is older than its caps plus a grace
 * period: the tick that ran it died. Fail it by compare-and-set from
 * `running`; a completion that lands after this write is dropped, so the
 * limit is generous. Returns true when this call failed it.
 *
 * The age counts from the last `dispatched` event. Two `running` rows have
 * no usable one and count from the deadline instead: a Batch row being
 * polled (its event is the submit, hours old) and a row whose tick died
 * between the claim and the event (Batch submit). Neither can run past
 * its deadline legitimately (Batch rows have a deadline over a day ahead).
 */
function interrupted(
  scheduler: Scheduler,
  store: TaskStore,
  job: JobRecord,
  row: TaskRecord<unknown>,
  nowMs: number,
  sleepNow: SleepReading | null | undefined,
): boolean {
  const dispatched = row.batchId ? undefined : dispatchedEvent(scheduler, row.taskId);
  const started = Date.parse(dispatched?.at ?? row.deadline ?? "");
  if (!Number.isFinite(started)) return false;
  const limit = job.caps.commandTimeoutMs + job.caps.llmTimeoutMs + INTERRUPT_GRACE_MS;
  const wallAge = nowMs - started;
  const sleepThen = sleepAt(dispatched?.details.sleep);
  if (sleepThen && !sleepNow) {
    // This host cannot read the sleep counter, but the run's ticker could:
    // the run may have slept. Wait for its deadline plus the caps, so a
    // host that reads the counter decides first, and a dead tick still
    // frees the job at the latest then.
    const deadline = Date.parse(row.deadline ?? "");
    if (nowMs - (Number.isFinite(deadline) ? Math.max(deadline, started) : started) <= limit) return false;
  } else {
    // Awake time only: a run the machine slept through is still running.
    const slept = sleptBetween(sleepThen, sleepNow, wallAge);
    if (wallAge - slept <= limit) return false;
  }
  return store.transitionIf(
    { ...row, status: "failed", completedAt: new Date(nowMs).toISOString(), error: JOB_INTERRUPTED_ERROR },
    ["running"],
    undefined,
    { kind: "failed", actor: "system", details: { job_id: job.jobId, reason: "interrupted" } },
  );
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
    jobs = store.listJobs().filter((j) => j.status !== "removed" || j.pendingTaskId !== undefined);
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
    caps: validCaps(DEFAULT_JOB_CAPS, input.caps),
    notify: input.notify === undefined ? "every_run" : validNotify(input.notify),
    originHost: input.originHost,
    originCwd: input.originCwd,
    createdBy: opts.actor,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    revision: 1,
    nextSeq: 1,
    consecutiveFailures: 0,
    retryUsed: false,
  };
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

/** Refuse every action but remove on a removed job or one whose stored template does not parse. */
function requireEditable(job: JobRecord): void {
  if (job.status === "removed") throw new JobActionError("job was removed");
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
      retryUsed: false,
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
    // The sweep may have just auto-paused the job (its third failed slot).
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

/** Jobs, oldest first; removed jobs are hidden unless asked for. */
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
