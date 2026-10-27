/**
 * `schedule_task` sugar for floating recurring jobs (KTD16), shared by the
 * MCP server and the OpenClaw plugin so both hosts read the same `repeat`
 * vocabulary the same way.
 *
 * A job `repeat` (`daily`, `weekdays`, `weekly`, `every_n_hours`) creates a
 * prompt job; `none` queues a one-off task and `quota_reset` keeps the older
 * series path. Agents never create command jobs (KD10): a shell-like
 * argument is refused with the CLI command the user runs instead.
 */

import { includesFileTool, includesWebTool } from "./claude-tools.js";
import { guaranteeText, parseWindow, validateJobSchedule } from "./job-cadence.js";
import { getJob, removeJob, type JobInput } from "./jobs.js";
import type { Scheduler } from "./scheduler.js";
import type { JobCadence, JobRecord, JobTools, ProviderName, Weekday } from "./types.js";
import { systemTimeZone } from "./zone-time.js";

/** The `repeat` values that create a job. */
export const JOB_REPEATS = ["daily", "weekdays", "weekly", "every_n_hours"] as const;
export type JobRepeat = (typeof JOB_REPEATS)[number];

/** True when `repeat` creates a job rather than a one-off task or a series. */
export function isJobRepeat(repeat: unknown): repeat is JobRepeat {
  return typeof repeat === "string" && (JOB_REPEATS as readonly string[]).includes(repeat);
}

/** Parameters that only mean something with a job repeat. */
export const JOB_ONLY_PARAMS = ["every_hours", "days", "window", "time_zone"] as const;

/** Argument names that would make the run execute a shell command. */
const SHELL_KEYS = ["command", "cmd", "shell", "script"] as const;

/**
 * The refusal for a call that tries to create a command job (AE12), or
 * undefined. Checked on the raw arguments: the schemas drop unknown keys.
 */
export function commandJobRefusal(args: Record<string, unknown>): string | undefined {
  const key = SHELL_KEYS.find((k) => args[k] !== undefined);
  if (!key) return undefined;
  return (
    `schedule_task cannot create command jobs (got "${key}"). ` +
    `Ask the user to run: tidegap jobs add --command '<cmd>' --daily (see tidegap jobs add --help)`
  );
}

/**
 * The refusal for job-only parameters passed without a job repeat, or
 * undefined. `repeat` is the call's repeat when it creates a job (else
 * undefined); `present` lists the parameter names the call set.
 */
export function jobParamsRefusal(repeat: JobRepeat | undefined, present: readonly string[]): string | undefined {
  if (repeat !== undefined) {
    if (repeat !== "every_n_hours" && present.includes("every_hours")) return `every_hours needs repeat "every_n_hours"`;
    if (repeat !== "weekly" && present.includes("days")) return `days needs repeat "weekly"`;
    return undefined;
  }
  const stray = JOB_ONLY_PARAMS.filter((p) => present.includes(p));
  if (stray.length === 0) return undefined;
  return `${stray.join(", ")} need a job repeat (${JOB_REPEATS.join(", ")})`;
}

/**
 * Per-task options a job cannot keep, across both hosts: a job's runs plan
 * against the default region and carry no routing, budget, timing or
 * delivery options of their own.
 */
const JOB_UNSUPPORTED_PARAMS = [
  "region",
  "carbon_budget_g",
  "candidates",
  "route_weights",
  "not_before",
  "after_limit_reset",
  "dry_run",
  "output_path",
  "redact_in_receipt",
  "quota_provider",
  "deliver",
  "webhook_url",
  "file_path",
  "file_format",
] as const;

/**
 * The refusal for per-task options a job cannot keep, or undefined. `args`
 * are the call's arguments; an option counts when set to anything but
 * `false`, and `dispatch` counts only when `false` (its default is `true`).
 */
export function jobUnsupportedRefusal(args: Record<string, unknown>): string | undefined {
  const present: string[] = JOB_UNSUPPORTED_PARAMS.filter((k) => args[k] !== undefined && args[k] !== false);
  if (args.dispatch === false) present.push("dispatch");
  if (present.length === 0) return undefined;
  return `${present.join(", ")} cannot be used with a job repeat; omit ${present.length === 1 ? "it" : "them"}`;
}

/**
 * The job tool group for a `claude-code` tool list: any file tool keeps the
 * read-only file group, any web tool the web group, `[]` none. The caller
 * has already refused a list that mixes the two (claudeCodeToolsError).
 */
export function jobToolsFor(tools: readonly string[]): JobTools {
  if (includesFileTool(tools)) return "files";
  if (includesWebTool(tools)) return "web";
  return "none";
}

/** What both hosts pass to build a prompt job from a `schedule_task` call. */
export interface ScheduleJobArgs {
  prompt: string;
  title?: string;
  repeat: JobRepeat;
  everyHours?: number;
  days?: readonly string[];
  window?: string;
  timeZone?: string;
  /** Deadline of the first run only (AS9). */
  deadline?: string;
  provider: ProviderName;
  model?: string;
  tools: JobTools;
  /** The project directory a run starts in; never a session to fork (KD8). */
  cwd?: string;
  host: "mcp" | "openclaw";
}

/** Today's weekday in `timeZone` (a `weekly` job with no days, KTD16). */
function weekdayIn(timeZone: string, now: Date): Weekday {
  return new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone }).format(now).toLowerCase().slice(0, 3) as Weekday;
}

function cadenceOf(args: ScheduleJobArgs, timeZone: string, now: Date): JobCadence {
  switch (args.repeat) {
    case "daily":
      return { kind: "daily" };
    case "weekdays":
      return { kind: "weekdays" };
    case "weekly":
      // validateJobSchedule checks the day names.
      return {
        kind: "weekly",
        days: (args.days && args.days.length > 0 ? args.days : [weekdayIn(timeZone, now)]) as Weekday[],
      };
    case "every_n_hours":
      if (args.everyHours === undefined) throw new Error(`repeat "every_n_hours" needs every_hours (2 to 168)`);
      return { kind: "hours", every: args.everyHours };
  }
}

/**
 * The {@link JobInput} for a `schedule_task` job call. Throws an Error with
 * a plain message on a bad cadence, window or zone.
 */
export function scheduleJobInput(args: ScheduleJobArgs, now: Date = new Date()): JobInput {
  const timeZone = args.timeZone ?? systemTimeZone();
  // The zone is checked before the weekday lookup uses it.
  validateJobSchedule({ cadence: { kind: "daily" }, timeZone });
  const cadence = cadenceOf(args, timeZone, now);
  const window = args.window !== undefined ? parseWindow(args.window) : undefined;
  const schedule = validateJobSchedule({ cadence, window, timeZone });
  return {
    title: args.title?.trim() ? args.title : args.prompt,
    cadence: schedule.cadence,
    window: schedule.window,
    timeZone: schedule.timeZone,
    template: {
      runner: "prompt",
      prompt: args.prompt,
      provider: args.provider,
      model: args.model,
      cwd: args.cwd,
      tools: args.tools,
    },
    originHost: args.host,
    originCwd: args.cwd,
    ...(args.deadline !== undefined ? { deadline: args.deadline } : {}),
  };
}

/** A job as the tool hosts list it. */
export interface JobToolView {
  jobId: string;
  title: string;
  status: JobRecord["status"];
  /** The guarantee in words, e.g. "runs every day between 00:00 and 08:00". */
  guarantee: string;
  /** Planned hour of the job's live run, if one is planned. */
  nextRun?: string;
  /** Id of that run. */
  nextTaskId?: string;
  lastOutcome?: JobRecord["lastOutcome"];
  pauseReason?: string;
}

const LIVE = new Set(["queued", "scheduled", "running", "submitted"]);

/** One job's list view: guarantee, next run, last result. */
export function jobToolView(scheduler: Scheduler, job: JobRecord): JobToolView {
  const row = job.pendingTaskId ? scheduler.ledger()?.get(job.pendingTaskId) : undefined;
  const live = row && LIVE.has(row.status) ? row : undefined;
  return {
    jobId: job.jobId,
    title: job.title,
    status: job.status,
    guarantee: guaranteeText({ cadence: job.cadence, window: job.window, timeZone: job.timeZone }),
    ...(live ? { nextTaskId: live.taskId, nextRun: live.scheduledFor ?? live.notBefore } : {}),
    ...(job.lastOutcome ? { lastOutcome: job.lastOutcome } : {}),
    ...(job.pauseReason ? { pauseReason: job.pauseReason } : {}),
  };
}

/**
 * `cancel_task series=true` on a job's run (series coexistence map): remove
 * the job, so no further run is materialized. Returns the job when the task
 * belongs to one (already removed included), else undefined. The caller
 * cancels the task itself afterwards (stop flag first, KTD4).
 */
export async function endJobOfTask(
  scheduler: Scheduler,
  taskId: string,
  opts: { actor?: string } = {},
): Promise<JobRecord | undefined> {
  const jobId = scheduler.ledger()?.get(taskId)?.jobId;
  if (!jobId) return undefined;
  const job = getJob(scheduler, jobId);
  if (!job) return undefined;
  if (job.status === "removed") return job;
  return removeJob(scheduler, jobId, opts);
}
