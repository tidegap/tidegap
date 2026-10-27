/**
 * Job routes of `tidegap ui` (jobs U7, KTD13) and the job JSON both the API
 * and `tidegap jobs` use: `JobInput` in, `Job` and `Run` out (the contract
 * is `docs/spec/ui-client-api.md`, "Jobs").
 *
 * Writes go through the core job actions on the server's action scheduler
 * (no adapters): the server writes the ledger and never runs a command or
 * a provider; the tick runs every occurrence. A `JobActionError` maps to
 * its status (400, 404, 409) with its one line; anything else is 500 with
 * a fixed text. Secret values never pass here: a job holds secret names,
 * and `GET /api/jobs/secrets` lists names only.
 *
 * Job strings (title, prompt, command, result previews) are untrusted text:
 * they leave as JSON values, previews default-redacted and cut to 300
 * characters.
 */

import { isAbsolute, resolve } from "node:path";

import {
  createJob,
  DEFAULT_MODEL_BY_PROVIDER,
  getJob,
  guaranteeText,
  isRedactedTask,
  JobActionError,
  JobScheduleError,
  nextOccurrence,
  pauseJob,
  redactPrompt,
  removeJob,
  resumeJob,
  runJobNow,
  stripControlChars,
  taskResultText,
  updateJob,
  validateJobSchedule,
  type JobCadence,
  type JobCaps,
  type JobInput,
  type JobPatch,
  type JobRecord,
  type JobSchedule,
  type JobTemplate,
  type JobTools,
  type JobWindow,
  type ProviderName,
  type Scheduler,
  type TaskRecord,
  type TaskStore,
  type Weekday,
} from "@tidegap/core";

/** A job answer, the `Job` object of the contract. */
export type JobView = Record<string, unknown>;

type Body = Record<string, unknown>;

export interface JobsResponse {
  status: number;
  body?: unknown;
  /** Task ids this request changed (the job's occurrences). */
  changedIds?: string[];
  /** True when a job row changed; the stream sends `jobs: true`. */
  jobsChanged?: boolean;
}

/** What the job routes need from the server's request context. */
export interface JobsContext {
  store: TaskStore;
  scheduler?: Scheduler;
  /** Who this request's writes are recorded as (`page` or `client:<name>`). */
  actor?: string;
  /** The caller may create, edit and remove jobs (the page and a `macos` token, KTD13). Absent = true. */
  canAuthorJobs?: boolean;
  /** Names in the job secrets file; never values. */
  jobSecretNames?: () => string[];
  now?: () => Date;
}

/** Longest preview of a run's result or error, in characters. */
export const RUN_PREVIEW_CHARS = 300;
/** Runs in `GET /api/jobs/<id>` (`recent`). */
export const JOB_RECENT_RUNS = 5;
/** Most runs one history page returns. */
export const JOB_HISTORY_MAX = 100;

const PROVIDERS: ReadonlySet<string> = new Set(["anthropic", "openai", "gemini", "ollama", "claude-code"]);
const TOOLS: ReadonlySet<string> = new Set(["none", "files", "web"]);
const NOTIFY: ReadonlySet<string> = new Set(["every_run", "failures", "summary"]);
const LIVE = new Set(["queued", "scheduled", "running", "submitted"]);
const DEFAULT_PROVIDER: ProviderName = "claude-code";

/** Keys of a `JobInput`; an update adds `revision`. */
export const JOB_INPUT_KEYS = [
  "title",
  "cadence",
  "window",
  "time_zone",
  "runner",
  "prompt",
  "command",
  "provider",
  "model",
  "tools",
  "cwd",
  "secrets",
  "caps",
  "notify",
] as const;

/** The template keys: changing any one rebuilds the template. */
const TEMPLATE_KEYS = ["runner", "prompt", "command", "provider", "model", "tools", "cwd", "secrets"] as const;

/** Cap keys in the JSON (seconds and USD) and their `JobCaps` field and unit. */
const CAP_KEYS: Record<string, { field: keyof JobCaps; scale: number }> = {
  command_timeout_s: { field: "commandTimeoutMs", scale: 1000 },
  llm_timeout_s: { field: "llmTimeoutMs", scale: 1000 },
  max_budget_usd: { field: "maxBudgetUsd", scale: 1 },
  output_cap_bytes: { field: "outputCapBytes", scale: 1 },
};

/** A refused job input; the message is the 400 body. */
export class JobInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobInputError";
  }
}

const bad = (message: string): never => {
  throw new JobInputError(message);
};

function str(v: unknown, name: string): string {
  if (typeof v !== "string" || v.trim() === "") bad(`${name} must be a non-empty string`);
  return v as string;
}

function optStr(v: unknown, name: string): string | undefined {
  return v === undefined || v === null ? undefined : str(v, name);
}

/** `{kind, days?, every?}`: the shape only; the core checks the rules. */
export function cadenceFromJson(v: unknown): JobCadence {
  if (!v || typeof v !== "object" || Array.isArray(v)) return bad('cadence must be an object such as {"kind": "daily"}');
  const c = v as Record<string, unknown>;
  const extra = Object.keys(c).find((k) => !["kind", "days", "every"].includes(k));
  if (extra) bad(`unknown field cadence.${extra}`);
  switch (c.kind) {
    case "daily":
    case "weekdays":
      return { kind: c.kind };
    case "weekly":
      if (!Array.isArray(c.days) || c.days.some((d) => typeof d !== "string")) bad("cadence.days must be a list of weekdays");
      return { kind: "weekly", days: c.days as Weekday[] };
    case "hours":
      if (typeof c.every !== "number") bad("cadence.every must be a number of hours");
      return { kind: "hours", every: c.every as number };
    default:
      return bad("cadence.kind must be daily, weekdays, weekly or hours");
  }
}

function windowFromJson(v: unknown): JobWindow {
  if (!v || typeof v !== "object" || Array.isArray(v)) return bad('window must be {"start": "HH:MM", "end": "HH:MM"} or null');
  const w = v as Record<string, unknown>;
  const extra = Object.keys(w).find((k) => k !== "start" && k !== "end");
  if (extra) bad(`unknown field window.${extra}`);
  return { start: str(w.start, "window.start"), end: str(w.end, "window.end") };
}

function capsFromJson(v: unknown): Partial<JobCaps> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return bad("caps must be an object");
  const out: Partial<JobCaps> = {};
  for (const [key, value] of Object.entries(v as Record<string, unknown>)) {
    const spec = CAP_KEYS[key];
    if (!spec) bad(`unknown field caps.${key}`);
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) bad(`caps.${key} must be a positive number`);
    out[spec!.field] = (value as number) * spec!.scale;
  }
  return out;
}

/** A working directory: `~` forms stay, anything else becomes absolute. */
export function normalizeCwd(cwd: string): string {
  return cwd === "~" || cwd.startsWith("~/") || isAbsolute(cwd) ? cwd : resolve(cwd);
}

/** The flat template fields of a job, the way `Job` shows them. */
interface FlatTemplate {
  runner: "prompt" | "command";
  prompt?: string;
  command?: string;
  provider?: string;
  model?: string;
  tools: JobTools;
  cwd?: string;
  secrets: string[];
}

function flatOf(t: JobTemplate): FlatTemplate {
  if (t.runner === "prompt") {
    return { runner: "prompt", prompt: t.prompt, provider: t.provider, model: t.model, tools: t.tools, cwd: t.cwd, secrets: [] };
  }
  return {
    runner: "command",
    command: t.command,
    prompt: t.summarize?.prompt,
    provider: t.summarize?.provider,
    model: t.summarize?.model,
    tools: "none",
    cwd: t.cwd,
    secrets: [...t.secrets],
  };
}

/** Overlay the template keys present in `body` on `base` (null clears an optional field). */
function overlay(base: FlatTemplate | undefined, body: Body): FlatTemplate {
  const runner = body.runner !== undefined ? body.runner : base?.runner;
  if (runner !== "prompt" && runner !== "command") return bad('runner must be "prompt" or "command"');
  const pick = (key: "prompt" | "command" | "provider" | "model" | "cwd"): string | undefined =>
    Object.hasOwn(body, key) ? optStr(body[key], key) : base?.[key];
  let tools: JobTools = base?.runner === runner ? base.tools : "none";
  if (body.tools !== undefined) {
    if (typeof body.tools !== "string" || !TOOLS.has(body.tools)) bad("tools must be none, files or web");
    tools = body.tools as JobTools;
  }
  if (runner === "command" && tools !== "none") bad("a command job has no tools; its LLM step has none");
  let secrets = base?.secrets ?? [];
  if (body.secrets !== undefined && body.secrets !== null) {
    if (!Array.isArray(body.secrets) || body.secrets.some((s) => typeof s !== "string")) bad("secrets must be a list of names");
    secrets = body.secrets as string[];
  } else if (body.secrets === null) {
    secrets = [];
  }
  const provider = pick("provider");
  if (provider !== undefined && !PROVIDERS.has(provider)) bad(`provider must be one of ${[...PROVIDERS].join(", ")}`);
  const cwd = pick("cwd");
  return {
    runner,
    prompt: pick("prompt"),
    command: pick("command"),
    provider,
    model: pick("model"),
    tools,
    cwd: cwd === undefined ? undefined : normalizeCwd(cwd),
    secrets,
  };
}

function templateOf(f: FlatTemplate): JobTemplate {
  const provider = (f.provider ?? DEFAULT_PROVIDER) as ProviderName;
  if (f.runner === "prompt") {
    if (f.command !== undefined) bad("a prompt job has no command; use runner command");
    if (f.secrets.length > 0) bad("secrets are for command jobs only");
    return { runner: "prompt", prompt: str(f.prompt, "prompt"), provider, model: f.model, cwd: f.cwd, tools: f.tools };
  }
  return {
    runner: "command",
    command: str(f.command, "command"),
    cwd: f.cwd,
    secrets: f.secrets,
    summarize: f.prompt !== undefined ? { prompt: f.prompt, provider, model: f.model } : undefined,
  };
}

function notifyOf(v: unknown): JobInput["notify"] {
  if (typeof v !== "string" || !NOTIFY.has(v)) return bad("notify must be every_run, failures or summary");
  return v as JobInput["notify"];
}

function onlyKeys(body: Body, allowed: readonly string[]): void {
  const extra = Object.keys(body).find((k) => !allowed.includes(k));
  if (extra) bad(`unknown field ${extra}`);
}

/** A `JobInput` JSON object to the core's input. Throws {@link JobInputError}. */
export function jobInputFromJson(body: Body, origin: { host: string }): JobInput {
  onlyKeys(body, JOB_INPUT_KEYS);
  if (body.cadence === undefined) bad("cadence is required");
  const input: JobInput = {
    title: str(body.title, "title"),
    cadence: cadenceFromJson(body.cadence),
    template: templateOf(overlay(undefined, body)),
    originHost: origin.host,
  };
  if (body.window !== undefined && body.window !== null) input.window = windowFromJson(body.window);
  if (body.time_zone !== undefined) input.timeZone = str(body.time_zone, "time_zone");
  if (body.caps !== undefined) input.caps = capsFromJson(body.caps);
  if (body.notify !== undefined) input.notify = notifyOf(body.notify);
  return input;
}

/** A partial `JobInput` to the core's patch, against the job's current template. Throws {@link JobInputError}. */
export function jobPatchFromJson(body: Body, current: JobRecord, extraKeys: readonly string[] = []): JobPatch {
  onlyKeys(body, [...JOB_INPUT_KEYS, ...extraKeys]);
  const patch: JobPatch = {};
  if (body.title !== undefined) patch.title = str(body.title, "title");
  if (body.cadence !== undefined) patch.cadence = cadenceFromJson(body.cadence);
  if (body.window !== undefined) patch.window = body.window === null ? null : windowFromJson(body.window);
  if (body.time_zone !== undefined) patch.timeZone = str(body.time_zone, "time_zone");
  if (body.caps !== undefined) patch.caps = capsFromJson(body.caps);
  if (body.notify !== undefined) patch.notify = notifyOf(body.notify);
  if (TEMPLATE_KEYS.some((k) => Object.hasOwn(body, k))) {
    const base = flatOf(current.template);
    // A runner switch starts from an empty template: no field of the other runner carries over.
    const fresh = body.runner !== undefined && body.runner !== base.runner;
    patch.template = templateOf(overlay(fresh ? undefined : base, body));
  }
  return patch;
}

/** One line, default-redacted, control characters removed, at most {@link RUN_PREVIEW_CHARS}. */
function preview(task: TaskRecord<unknown>): string | null {
  let text: string;
  if (task.status === "failed") text = (task.error ?? "").split(/\r?\n/).find((l) => l.trim()) ?? "";
  else if (task.status === "completed" && !isRedactedTask(task)) text = taskResultText(task) ?? "";
  else return null;
  const clean = stripControlChars(redactPrompt(text, undefined)).replace(/\s+/g, " ").trim();
  if (!clean) return null;
  return clean.length > RUN_PREVIEW_CHARS ? `${clean.slice(0, RUN_PREVIEW_CHARS - 1)}…` : clean;
}

/** When the occurrence was dispatched (its last `dispatched` event), or null. */
function startedAt(scheduler: Scheduler | undefined, taskId: string): string | null {
  const events = scheduler?.listTaskEvents(taskId) ?? [];
  for (let i = events.length - 1; i >= 0; i--) if (events[i]!.kind === "dispatched") return events[i]!.at;
  return null;
}

/**
 * Until when a pending occurrence waits for a usage limit: the `retry_at` of
 * its newest `deferred` event while that is ahead of `now`, no `dispatched`
 * event came after it, and the row still waits for it (`notBefore` is that
 * time; Run now or a reschedule moves it); else null.
 */
function deferredUntil(scheduler: Scheduler | undefined, task: TaskRecord<unknown>, now: Date): string | null {
  const events = scheduler?.listTaskEvents(task.taskId) ?? [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind === "dispatched") return null;
    if (e.kind !== "deferred") continue;
    const at = e.details?.retry_at;
    if (typeof at !== "string") return null;
    const atMs = Date.parse(at);
    return atMs > now.getTime() && task.notBefore !== undefined && Date.parse(task.notBefore) === atMs ? at : null;
  }
  return null;
}

/** A finished run ended after its deadline (the digest's "ran late" rule). */
function isLate(task: TaskRecord<unknown>): boolean {
  if (task.status !== "completed" && task.status !== "failed") return false;
  if (!task.deadline || !task.completedAt) return false;
  return Date.parse(task.deadline) < Date.parse(task.completedAt);
}

/** A `Run`: one occurrence of a job. `receipt_id` is the task id when the run has a receipt (`tidegap verify <id>`). */
export function runView(task: TaskRecord<unknown>, scheduler?: Scheduler): Record<string, unknown> {
  const g = task.receipt?.actualCarbonGCo2 ?? task.receipt?.estimatedCarbonGCo2;
  return {
    task_id: task.taskId,
    status: task.status,
    scheduled_for: task.scheduledFor ?? null,
    started_at: startedAt(scheduler, task.taskId),
    completed_at: task.completedAt ?? null,
    receipt_id: task.receipt ? task.taskId : null,
    carbon_g: typeof g === "number" && Number.isFinite(g) ? g : null,
    via_batch: task.batchId !== undefined,
    late: isLate(task),
    error: task.status === "failed" ? preview(task) : null,
    preview: task.status === "completed" ? preview(task) : null,
  };
}

function capsView(caps: JobCaps): Record<string, number> {
  return {
    command_timeout_s: caps.commandTimeoutMs / 1000,
    llm_timeout_s: caps.llmTimeoutMs / 1000,
    max_budget_usd: caps.maxBudgetUsd,
    output_cap_bytes: caps.outputCapBytes,
  };
}

function scheduleOf(job: Pick<JobRecord, "cadence" | "window" | "timeZone">): JobSchedule {
  return { cadence: job.cadence, window: job.window, timeZone: job.timeZone };
}

/**
 * The `Job` object. `actions` follow the caller: `edit` and `remove` only
 * for a caller that may author jobs. `missing_secrets` names the job's
 * secrets that the secrets file lacks (names only, never values).
 */
export function jobView(
  job: JobRecord,
  ctx: { store: TaskStore; scheduler?: Scheduler; canAuthorJobs?: boolean; secretNames?: readonly string[]; now?: Date },
): JobView {
  const flat = flatOf(job.template);
  const pending = job.pendingTaskId ? ctx.store.get(job.pendingTaskId) : undefined;
  const live = pending && LIVE.has(pending.status) ? pending : undefined;
  const last = job.lastTaskId ? ctx.store.get(job.lastTaskId) : undefined;
  const author = ctx.canAuthorJobs !== false;
  const removed = job.status === "removed";
  const running = live?.status === "running" || live?.status === "submitted";
  const pendingLive = live?.status === "queued" || live?.status === "scheduled";
  const known = new Set(ctx.secretNames ?? []);
  let guarantee: string | null;
  try {
    guarantee = guaranteeText(scheduleOf(job));
  } catch {
    guarantee = null;
  }
  return {
    job_id: job.jobId,
    title: job.title,
    status: job.status,
    revision: job.revision,
    cadence: job.cadence,
    window: job.window ?? null,
    time_zone: job.timeZone,
    guarantee,
    runner: flat.runner,
    command: flat.command ?? null,
    prompt: flat.prompt ?? null,
    provider: flat.provider ?? null,
    model: flat.model ?? null,
    tools: flat.tools,
    cwd: flat.cwd ?? "~",
    secrets: flat.secrets,
    missing_secrets: flat.secrets.filter((n) => !known.has(n)),
    caps: capsView(job.caps),
    notify: job.notify,
    next_run: live
      ? {
          task_id: live.taskId,
          status: live.status,
          earliest: live.notBefore ?? live.enqueuedAt,
          deadline: live.deadline ?? null,
          scheduled_for: live.scheduledFor ?? null,
          intensity_g_per_kwh: live.receipt?.intensityGCo2PerKwh ?? null,
          via_batch: live.batchId !== undefined,
          started_at: running ? startedAt(ctx.scheduler, live.taskId) : null,
          deferred_until: pendingLive ? deferredUntil(ctx.scheduler, live, ctx.now ?? new Date()) : null,
        }
      : null,
    last_run:
      last && job.lastOutcome
        ? {
            task_id: last.taskId,
            outcome: job.lastOutcome,
            started_at: job.lastRunStartedAt ?? null,
            completed_at: last.completedAt ?? null,
            late: isLate(last),
            preview: preview(last),
          }
        : null,
    consecutive_failures: job.consecutiveFailures,
    pause_reason: job.pauseReason ?? null,
    origin_host: job.originHost ?? null,
    created_at: job.createdAt,
    updated_at: job.updatedAt,
    actions: {
      edit: author && !removed,
      pause: job.status === "active",
      resume: job.status === "paused",
      run_now: job.status === "active" && !running,
      remove: author && !removed,
    },
  };
}

/** The `Job` object plus its {@link JOB_RECENT_RUNS} newest runs (`GET /api/jobs/<id>`, `tidegap jobs show --json`). */
export function jobDetailView(job: JobRecord, ctx: Parameters<typeof jobView>[1]): JobView {
  const { runs } = jobRuns(ctx.store, job.jobId, { limit: JOB_RECENT_RUNS });
  return { ...jobView(job, ctx), recent: runs.map((r) => runView(r, ctx.scheduler)) };
}

/** A job's occurrences, newest first, `limit` after the run `before` (exclusive). */
export function jobRuns(store: TaskStore, jobId: string, opts: { limit: number; before?: string }): { runs: TaskRecord<unknown>[]; nextBefore: string | null } {
  const all = store.list({ jobId }).reverse();
  let start = 0;
  if (opts.before !== undefined) {
    const i = all.findIndex((t) => t.taskId === opts.before);
    if (i < 0) throw new JobInputError("before is not a run of this job");
    start = i + 1;
  }
  const runs = all.slice(start, start + opts.limit);
  const more = start + opts.limit < all.length;
  return { runs, nextBefore: more && runs.length > 0 ? runs[runs.length - 1]!.taskId : null };
}

/** Counts and the next planned job run, for `GET /api/summary`. */
export function jobsSummary(store: TaskStore): { jobs: { active: number; paused: number }; next_job_run: { job_id: string; title: string; at: string } | null } {
  const jobs = store.listJobs({ status: ["active", "paused"] });
  let next: { job_id: string; title: string; at: string } | null = null;
  for (const job of jobs) {
    if (job.status !== "active" || !job.pendingTaskId) continue;
    const t = store.get(job.pendingTaskId);
    const at = t && (t.status === "scheduled" || t.status === "queued") ? (t.scheduledFor ?? t.notBefore) : undefined;
    if (at && (!next || Date.parse(at) < Date.parse(next.at))) next = { job_id: job.jobId, title: job.title, at };
  }
  return {
    jobs: { active: jobs.filter((j) => j.status === "active").length, paused: jobs.filter((j) => j.status === "paused").length },
    next_job_run: next,
  };
}

// ── Routes ────────────────────────────────────────────────────────────────

function error(status: number, message: string, code?: string): JobsResponse {
  return { status, body: code ? { error: message, code } : { error: message } };
}

function oneLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split("\n")[0]!.slice(0, 300);
}

const STATUS_OF: Record<JobActionError["code"], number> = { invalid: 400, not_found: 404, conflict: 409 };

/** Map a refusal to its status; anything else is 500 with a fixed text. */
function refusal(err: unknown): JobsResponse {
  if (err instanceof JobInputError) return error(400, oneLine(err));
  if (err instanceof JobActionError) return error(STATUS_OF[err.code], oneLine(err), err.reason);
  if (err instanceof JobScheduleError) return error(400, oneLine(err));
  return error(500, "job action failed");
}

function viewCtx(ctx: JobsContext) {
  return { store: ctx.store, scheduler: ctx.scheduler, canAuthorJobs: ctx.canAuthorJobs, secretNames: secretNames(ctx), now: ctx.now?.() };
}

function secretNames(ctx: JobsContext): string[] {
  try {
    return ctx.jobSecretNames?.() ?? [];
  } catch {
    return [];
  }
}

/** Task ids a job write may have changed: its old and new tracked occurrences. */
function touched(before: JobRecord | undefined, after: JobRecord): string[] {
  return [...new Set([before?.pendingTaskId, after.pendingTaskId, after.lastTaskId].filter((x): x is string => typeof x === "string"))];
}

function list(ctx: JobsContext, params: URLSearchParams): JobsResponse {
  const raw = params.get("status");
  let statuses: string[] = ["active", "paused"];
  if (raw !== null) {
    statuses = raw.split(",").map((s) => s.trim()).filter(Boolean);
    const unknown = statuses.find((s) => !["active", "paused", "removed"].includes(s));
    if (unknown || statuses.length === 0) return error(400, "status must be a comma list of active, paused, removed");
  }
  const jobs = ctx.store.listJobs({ status: statuses as JobRecord["status"][] });
  const view = viewCtx(ctx);
  return { status: 200, body: { jobs: jobs.map((j) => jobView(j, view)) } };
}

function detail(ctx: JobsContext, jobId: string): JobsResponse {
  const job = ctx.store.getJob(jobId);
  if (!job) return error(404, "job not found");
  return { status: 200, body: jobDetailView(job, viewCtx(ctx)) };
}

function history(ctx: JobsContext, jobId: string, params: URLSearchParams): JobsResponse {
  if (!ctx.store.getJob(jobId)) return error(404, "job not found");
  const rawLimit = params.get("limit");
  const limit = rawLimit === null ? 20 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > JOB_HISTORY_MAX) return error(400, `limit must be 1 to ${JOB_HISTORY_MAX}`);
  try {
    const page = jobRuns(ctx.store, jobId, { limit, before: params.get("before") ?? undefined });
    return { status: 200, body: { runs: page.runs.map((r) => runView(r, ctx.scheduler)), next_before: page.nextBefore } };
  } catch (err) {
    return refusal(err);
  }
}

async function write(ctx: JobsContext, jobId: string | undefined, run: (s: Scheduler) => Promise<JobRecord>, status = 200): Promise<JobsResponse> {
  if (!ctx.scheduler) return error(405, "this server is read-only");
  const before = jobId ? ctx.store.getJob(jobId) : undefined;
  if (jobId && !before) return error(404, "job not found");
  try {
    const after = await run(ctx.scheduler);
    return { status, body: jobView(after, viewCtx(ctx)), changedIds: touched(before, after), jobsChanged: true };
  } catch (err) {
    return refusal(err);
  }
}

function create(ctx: JobsContext, body: Body): Promise<JobsResponse> | JobsResponse {
  let input: JobInput;
  try {
    input = jobInputFromJson(body, { host: "page" });
  } catch (err) {
    return refusal(err);
  }
  return write(ctx, undefined, (s) => createJob(s, input, { actor: ctx.actor }), 201);
}

/** The core's stale-revision refusal (same words), for a revision the route can see is old. */
function staleRevision(current: number): JobActionError {
  return new JobActionError(`job changed meanwhile (revision ${current}); reload it and try again`, "conflict", "stale_revision");
}

function update(ctx: JobsContext, jobId: string, body: Body): Promise<JobsResponse> | JobsResponse {
  const job = ctx.store.getJob(jobId);
  if (!job) return error(404, "job not found");
  const revision = body.revision;
  if (typeof revision !== "number" || !Number.isInteger(revision)) return error(400, "revision must be the job's revision number");
  // A stale partial patch may not parse against the newer job: answer the conflict first.
  if (revision !== job.revision) return refusal(staleRevision(job.revision));
  let patch: JobPatch;
  try {
    const { revision: _revision, ...rest } = body;
    patch = jobPatchFromJson(rest, job);
  } catch (err) {
    return refusal(err);
  }
  // The core checks the revision inside its compare-and-set (stale_revision -> 409).
  return write(ctx, jobId, (s) => updateJob(s, jobId, patch, { actor: ctx.actor, expectedRevision: revision }));
}

async function remove(ctx: JobsContext, jobId: string): Promise<JobsResponse> {
  const out = await write(ctx, jobId, (s) => removeJob(s, jobId, { actor: ctx.actor }));
  return out.status === 200 ? { ...out, body: { job_id: jobId, status: "removed" } } : out;
}

async function preview_(ctx: JobsContext, body: Body): Promise<JobsResponse> {
  if (!ctx.scheduler) return error(405, "this server is read-only");
  let schedule: JobSchedule;
  try {
    onlyKeys(body, JOB_INPUT_KEYS);
    if (body.cadence === undefined) bad("cadence is required");
    schedule = validateJobSchedule({
      cadence: cadenceFromJson(body.cadence),
      window: body.window === undefined || body.window === null ? undefined : windowFromJson(body.window),
      timeZone: body.time_zone === undefined ? Intl.DateTimeFormat().resolvedOptions().timeZone : str(body.time_zone, "time_zone"),
    });
  } catch (err) {
    return refusal(err);
  }
  const now = ctx.now?.() ?? new Date();
  const occ = nextOccurrence(schedule, { now });
  let planned: { at: string | null; g: number | null } = { at: null, g: null };
  try {
    const earliest = new Date(occ.earliest);
    const p = await ctx.scheduler.previewProviderCall(
      { type: "provider_call", provider: "anthropic", model: DEFAULT_MODEL_BY_PROVIDER.anthropic, prompt: "preview" },
      { deadline: occ.deadline, ...(earliest.getTime() > now.getTime() ? { notBefore: earliest } : {}) },
    );
    planned = { at: p.scheduledFor, g: p.intensityGCo2PerKwh };
  } catch {
    // A forecast failure leaves the planned hour unknown; the rule still answers.
  }
  return {
    status: 200,
    body: {
      guarantee: guaranteeText(schedule),
      first_run: { earliest: occ.earliest, deadline: occ.deadline, planned_at: planned.at, intensity_g_per_kwh: planned.g },
    },
  };
}

function actOn(ctx: JobsContext, jobId: string, action: string): Promise<JobsResponse> {
  switch (action) {
    case "pause":
      return write(ctx, jobId, (s) => pauseJob(s, jobId, { actor: ctx.actor }));
    case "resume":
      return write(ctx, jobId, (s) => resumeJob(s, jobId, { actor: ctx.actor }));
    default:
      return write(ctx, jobId, async (s) => {
        await runJobNow(s, jobId, { actor: ctx.actor });
        return getJob(s, jobId)!;
      });
  }
}

/** Most job create, update and remove calls one token may make in a minute (previews have their own limit). */
export const JOB_WRITES_PER_MINUTE = 60;

/**
 * Most `POST /api/jobs/preview` calls one token may make in a minute. A
 * preview fetches a live forecast, so it has its own budget, apart from the
 * job write limit; the page form debounces it.
 */
export const JOB_PREVIEWS_PER_MINUTE = 20;

/** `POST /api/jobs/preview`; `route` starts at `jobs`. */
export function isJobPreviewRoute(method: string, route: readonly string[]): boolean {
  return method === "POST" && route.length === 2 && route[0] === "jobs" && route[1] === "preview";
}

/** The routes under `/api/jobs` that only the page and a `macos` token may call (KTD13). */
export function isJobAuthorRoute(method: string, route: readonly string[]): boolean {
  if (route[0] !== "jobs") return false;
  if (method === "POST" && route.length === 1) return true;
  if (isJobPreviewRoute(method, route)) return true;
  if (route.length === 2 && route[1] === "secrets") return true;
  return method === "POST" && route.length === 3 && (route[2] === "update" || route[2] === "remove");
}

/** How a job POST route treats its body: `json` for create, update and preview; `none` for the actions. */
export function jobsPostBodyKind(route: readonly string[]): "json" | "none" | undefined {
  if (route.length === 1) return "json";
  if (route.length === 2 && route[1] === "preview") return "json";
  if (route.length !== 3) return undefined;
  if (route[2] === "update") return "json";
  if (route[2] === "pause" || route[2] === "resume" || route[2] === "run-now" || route[2] === "remove") return "none";
  return undefined;
}

/** Route one `/api/jobs*` request; `route` starts at `jobs`. */
export async function handleJobs(ctx: JobsContext, method: string, route: readonly string[], params: URLSearchParams, body: Body): Promise<JobsResponse> {
  const get = method === "GET";
  const post = method === "POST";
  const wrong = () => error(405, "method not allowed");
  if (route.length === 1) return get ? list(ctx, params) : post ? create(ctx, body) : wrong();
  if (route.length === 2 && route[1] === "preview") return post ? preview_(ctx, body) : wrong();
  if (route.length === 2 && route[1] === "secrets") return get ? { status: 200, body: { names: secretNames(ctx) } } : wrong();
  let jobId: string;
  try {
    jobId = decodeURIComponent(route[1]!);
  } catch {
    return error(400, "bad job id");
  }
  if (route.length === 2) return get ? detail(ctx, jobId) : wrong();
  if (route.length !== 3) return error(404, "not found");
  switch (route[2]) {
    case "history":
      return get ? history(ctx, jobId, params) : wrong();
    case "update":
      return post ? update(ctx, jobId, body) : wrong();
    case "remove":
      return post ? remove(ctx, jobId) : wrong();
    case "pause":
    case "resume":
    case "run-now":
      return post ? actOn(ctx, jobId, route[2]) : wrong();
    default:
      return error(404, "not found");
  }
}

