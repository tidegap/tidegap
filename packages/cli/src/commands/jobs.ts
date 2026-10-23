/**
 * `tidegap jobs` — recurring jobs from the command line (jobs U7, R24, R29).
 *
 *   list | show | add | edit | pause | resume | run | remove | history
 *   secrets list | set <NAME> | remove <NAME>
 *
 * Writes go through the core job actions on the action scheduler (no
 * adapters): a command never dispatches; the tick runs every occurrence.
 * Flags and `--file` build the same `JobInput` JSON the UI API takes
 * (`ui/jobs-api.ts`), so both refuse the same input with the same line.
 *
 * Exit codes follow `tidegap channels`: 0 ok, 1 refused or failed, 2 usage
 * (a bad flag or an input rule). Every job string printed is untrusted and
 * goes through `stripControlChars`. Secret values are read from stdin only
 * and never printed: `secrets set` echoes the name.
 */

import { readFileSync } from "node:fs";

import {
  createJob,
  JobActionError,
  JobScheduleError,
  parseWindow,
  pauseJob,
  removeJob,
  resumeJob,
  runJobNow,
  stripControlChars,
  updateJob,
  type GridFeed,
  type JobRecord,
  type Scheduler,
  type TaskStore,
} from "@tidegap/core";

import { assertJobSecretName, listJobSecretNames, removeJobSecret, setJobSecret } from "../jobs/secrets.js";
import { JobInputError, jobDetailView, jobInputFromJson, jobPatchFromJson, jobRuns, jobView, runView } from "../ui/jobs-api.js";
import { EXIT } from "./channels.js";
import { PromptCancelled, promptSecret } from "./prompt-secret.js";
import { actionScheduler } from "./queue.js";
import { defaultDbPath } from "./tick.js";

/** The line `tidegap jobs` with no command prints after the list (R36). */
export const JOBS_SNIPPET_HINT = "Make your agent prefer Tidegap over cron: tidegap jobs snippet";

/** A refusal with its exit code: {@link EXIT.usage} for bad input, {@link EXIT.failed} otherwise. */
export class JobsCommandError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = EXIT.failed,
  ) {
    super(message);
    this.name = "JobsCommandError";
  }
}

const usage = (message: string): never => {
  throw new JobsCommandError(message, EXIT.usage);
};

export interface JobsOptions {
  db?: string;
  json?: boolean;
  /** Inject a grid feed (tests); default: the one `tidegap tick` builds. */
  feed?: GridFeed;
  /** Job secrets file; default `~/.config/tidegap/job-secrets.json`. */
  secretsFile?: string;
}

/** The flags of `add` and `edit`, as commander parses them. */
export interface JobFlags extends JobsOptions {
  title?: string;
  daily?: boolean;
  weekdays?: boolean;
  weekly?: string;
  every?: string;
  window?: string;
  tz?: string;
  prompt?: string;
  tools?: string;
  command?: string;
  summarize?: string;
  secret?: string[];
  provider?: string;
  model?: string;
  cwd?: string;
  notify?: string;
  commandTimeout?: string;
  llmTimeout?: string;
  budget?: string;
  file?: string;
}

function safe(value: string): string {
  return stripControlChars(value);
}

/** Map a core or input refusal to its exit code. */
function refused(err: unknown): never {
  if (err instanceof JobsCommandError) throw err;
  if (err instanceof JobInputError || err instanceof JobScheduleError) throw new JobsCommandError(err.message, EXIT.usage);
  if (err instanceof JobActionError) throw new JobsCommandError(err.message, err.code === "invalid" ? EXIT.usage : EXIT.failed);
  throw new JobsCommandError(err instanceof Error ? err.message : String(err));
}

/** Run `fn` with a write scheduler (actor `cli`), closing it after. */
async function withScheduler<T>(opts: JobsOptions, fn: (s: Scheduler, store: TaskStore) => Promise<T> | T): Promise<T> {
  const scheduler = actionScheduler({ dbPath: opts.db ?? defaultDbPath(), actor: "cli", ...(opts.feed ? { feed: opts.feed } : {}) });
  try {
    return await fn(scheduler, scheduler.ledger()!);
  } catch (err) {
    return refused(err);
  } finally {
    scheduler.shutdown();
  }
}

/** `5m`, `90s`, `1h` or a number of seconds, to seconds. */
export function parseDurationSeconds(value: string, flag: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h)?$/i.exec(value.trim());
  if (!m) return usage(`${flag} must be a duration such as 90s, 5m or 1h`);
  const n = Number(m[1]) * { s: 1, m: 60, h: 3600 }[(m[2] ?? "s").toLowerCase() as "s" | "m" | "h"];
  return n > 0 ? n : usage(`${flag} must be more than zero`);
}

const NOTIFY_FLAG: Record<string, string> = { every: "every_run", every_run: "every_run", failures: "failures", summary: "summary" };

/** The cadence flags, at most one. */
function cadenceFlag(f: JobFlags): Record<string, unknown> | undefined {
  const given = [f.daily && "--daily", f.weekdays && "--weekdays", f.weekly !== undefined && "--weekly", f.every !== undefined && "--every"].filter(Boolean);
  if (given.length > 1) usage(`pick one cadence: ${given.join(" and ")} were given`);
  if (f.daily) return { kind: "daily" };
  if (f.weekdays) return { kind: "weekdays" };
  if (f.weekly !== undefined) return { kind: "weekly", days: f.weekly.split(",").map((d) => d.trim()).filter(Boolean) };
  if (f.every !== undefined) {
    const m = /^(\d+)\s*h$/i.exec(f.every.trim());
    if (!m) usage("--every takes hours, for example --every 6h (N from 2 to 168)");
    return { kind: "hours", every: Number(m![1]) };
  }
  return undefined;
}

/** `--file` JSON: one object. */
function readJobFile(path: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return usage(`--file: ${(err as NodeJS.ErrnoException).code === "ENOENT" ? "no such file" : "not valid JSON"}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) usage("--file must hold one JSON object (the JobInput of the client API)");
  return parsed as Record<string, unknown>;
}

/**
 * The `JobInput` JSON the flags describe, over `--file` when given (flags
 * win). `current` is the job `edit` changes: `--prompt` on a command job
 * makes it a prompt job, `--command` on a prompt job a command job.
 */
export function jobBodyFromFlags(f: JobFlags, current?: JobRecord): Record<string, unknown> {
  const body: Record<string, unknown> = f.file ? readJobFile(f.file) : {};
  const set = (key: string, value: unknown) => {
    if (value !== undefined) body[key] = value;
  };
  set("title", f.title);
  set("cadence", cadenceFlag(f));
  if (f.window !== undefined) {
    if (f.window.trim().toLowerCase() === "none") body.window = null;
    else {
      try {
        body.window = parseWindow(f.window);
      } catch (err) {
        usage((err as Error).message);
      }
    }
  }
  set("time_zone", f.tz);
  if (f.prompt !== undefined && f.command !== undefined) usage("--prompt is for prompt jobs; a command job's LLM step is --summarize");
  if (f.summarize !== undefined && f.prompt !== undefined) usage("--summarize is for command jobs; a prompt job takes --prompt");
  if (f.prompt !== undefined) {
    body.runner = "prompt";
    body.prompt = f.prompt;
  }
  if (f.command !== undefined) {
    body.runner = "command";
    body.command = f.command;
  }
  if (f.summarize !== undefined) {
    const runner = body.runner ?? current?.template.runner;
    if (runner !== "command") usage("--summarize needs a command job (--command)");
    body.runner = "command";
    body.prompt = f.summarize;
  }
  if (f.secret !== undefined) body.secrets = f.secret;
  set("tools", f.tools);
  set("provider", f.provider);
  set("model", f.model);
  set("cwd", f.cwd);
  if (f.notify !== undefined) {
    const n = NOTIFY_FLAG[f.notify.trim().toLowerCase()];
    if (!n) usage("--notify must be every, failures or summary");
    body.notify = n;
  }
  const caps: Record<string, number> = { ...((body.caps as Record<string, number> | undefined) ?? {}) };
  if (f.commandTimeout !== undefined) caps.command_timeout_s = parseDurationSeconds(f.commandTimeout, "--command-timeout");
  if (f.llmTimeout !== undefined) caps.llm_timeout_s = parseDurationSeconds(f.llmTimeout, "--llm-timeout");
  if (f.budget !== undefined) {
    const usd = Number(f.budget);
    if (!Number.isFinite(usd) || usd <= 0) usage("--budget must be a positive amount in USD, for example 1.00");
    caps.max_budget_usd = usd;
  }
  if (Object.keys(caps).length > 0) body.caps = caps;
  if (current === undefined && body.runner === undefined) usage("a job needs --prompt <text> or --command <shell>");
  return body;
}

// ── Rendering ─────────────────────────────────────────────────────────────

type View = ReturnType<typeof jobView>;

function secretNames(opts: JobsOptions): string[] {
  try {
    return listJobSecretNames(opts.secretsFile);
  } catch {
    return [];
  }
}

function viewOf(job: JobRecord, store: TaskStore, scheduler: Scheduler | undefined, opts: JobsOptions): View {
  return jobView(job, { store, scheduler, secretNames: secretNames(opts) });
}

const NOTIFY_TEXT: Record<string, string> = { every_run: "every run", failures: "failures only", summary: "daily summary only" };

function nextLine(v: View): string {
  const next = v.next_run as Record<string, unknown> | null;
  if (!next) return v.status === "active" ? "next run: none yet (the next tick plans one)" : "next run: none";
  if (next.status === "running" || next.status === "submitted") return `next run: running now (${next.task_id})`;
  const at = next.scheduled_for ? `planned ${next.scheduled_for}` : `from ${next.earliest}`;
  return `next run: ${at}, deadline ${next.deadline} (${next.task_id})`;
}

function lastLine(v: View): string | undefined {
  const last = v.last_run as Record<string, unknown> | null;
  if (!last) return undefined;
  const preview = typeof last.preview === "string" ? `, "${safe(last.preview).slice(0, 120)}"` : "";
  return `last run: ${last.outcome} ${last.completed_at ?? last.started_at ?? ""}${preview} (${last.task_id})`.replace(/\s+\(/, " (");
}

/** The warning lines for secret names the secrets file lacks (AE7: names only). */
function missingLines(v: View): string[] {
  return (v.missing_secrets as string[]).map((n) => `warning: secret ${n} is not set; run: tidegap jobs secrets set ${n}`);
}

export function renderJob(v: View): string {
  const caps = v.caps as Record<string, number>;
  const lines = [
    `${v.job_id}  ${safe(String(v.title))}  (${v.status})`,
    `${v.guarantee ?? "schedule"} (${v.time_zone})`,
  ];
  if (v.runner === "command") {
    lines.push(`command: ${safe(String(v.command))}`);
    if (v.prompt !== null) lines.push(`summarize (${v.provider}${v.model ? ` ${v.model}` : ""}, no tools): ${safe(String(v.prompt))}`);
    if ((v.secrets as string[]).length > 0) lines.push(`secrets: ${(v.secrets as string[]).join(", ")}`);
  } else {
    lines.push(`prompt (${v.provider}${v.model ? ` ${v.model}` : ""}, tools ${v.tools}): ${safe(String(v.prompt))}`);
  }
  lines.push(`cwd: ${safe(String(v.cwd))}`);
  lines.push(`notify: ${NOTIFY_TEXT[String(v.notify)] ?? v.notify}`);
  lines.push(`caps: command ${caps.command_timeout_s} s, LLM ${caps.llm_timeout_s} s, budget ${caps.max_budget_usd} USD`);
  lines.push(nextLine(v));
  const last = lastLine(v);
  if (last) lines.push(last);
  if (v.status === "paused") lines.push(`paused: ${safe(String(v.pause_reason ?? "manual"))}`);
  else if ((v.consecutive_failures as number) > 0) lines.push(`failed runs in a row: ${v.consecutive_failures}`);
  lines.push(...missingLines(v));
  return lines.join("\n");
}

function cadenceLabel(v: View): string {
  const c = v.cadence as { kind: string; days?: string[]; every?: number };
  const base = c.kind === "weekly" ? `weekly ${c.days?.join(",")}` : c.kind === "hours" ? `every ${c.every}h` : c.kind;
  const w = v.window as { start: string; end: string } | null;
  return w ? `${base} ${w.start}-${w.end}` : base;
}

function pad(s: string, n: number): string {
  return s.length >= n ? `${s.slice(0, n - 1)} ` : s.padEnd(n);
}

export function renderJobList(views: readonly View[]): string {
  if (views.length === 0) return "No jobs. Create one: tidegap jobs add --title <t> --daily --prompt <text>";
  const rows = views.map((v) => {
    const next = v.next_run as Record<string, unknown> | null;
    const last = v.last_run as Record<string, unknown> | null;
    const nextText = next ? String(next.scheduled_for ?? `~${next.earliest}`) : "-";
    return `${pad(String(v.job_id), 14)}${pad(String(v.status), 8)}${pad(cadenceLabel(v), 22)}${pad(nextText, 26)}${pad(last ? String(last.outcome) : "-", 8)}${safe(String(v.title))}`;
  });
  return [`${pad("JOB", 14)}${pad("STATUS", 8)}${pad("CADENCE", 22)}${pad("NEXT", 26)}${pad("LAST", 8)}TITLE`, ...rows].join("\n");
}

// ── Commands ──────────────────────────────────────────────────────────────

/** `tidegap jobs list [--all]`; with `hint`, the bare `tidegap jobs` (R36). */
export async function runJobsList(opts: JobsOptions & { all?: boolean; hint?: boolean } = {}): Promise<string> {
  return withScheduler(opts, (scheduler, store) => {
    const jobs = store.listJobs(opts.all ? {} : { status: ["active", "paused"] });
    const views = jobs.map((j) => viewOf(j, store, scheduler, opts));
    if (opts.json) return JSON.stringify({ jobs: views }, null, 2);
    const text = renderJobList(views);
    return opts.hint ? `${text}\n\n${JOBS_SNIPPET_HINT}` : text;
  });
}

function requireJob(store: TaskStore, jobId: string): JobRecord {
  const job = store.getJob(jobId);
  if (!job) throw new JobsCommandError(`job ${JSON.stringify(jobId)} not found`);
  return job;
}

/** `tidegap jobs show <id>`: the job, its guarantee, next and last run, and unset secret names. */
export async function runJobsShow(jobId: string, opts: JobsOptions = {}): Promise<string> {
  return withScheduler(opts, (scheduler, store) => {
    const job = requireJob(store, jobId);
    if (opts.json) return JSON.stringify(jobDetailView(job, { store, scheduler, secretNames: secretNames(opts) }), null, 2);
    return renderJob(viewOf(job, store, scheduler, opts));
  });
}

function written(job: JobRecord, store: TaskStore, scheduler: Scheduler, opts: JobsOptions, head: string): string {
  const view = viewOf(job, store, scheduler, opts);
  if (opts.json) return JSON.stringify(view, null, 2);
  return [head, renderJob(view)].join("\n");
}

/** `tidegap jobs add`: create a job from flags and `--file`; prints it with its first run. */
export async function runJobsAdd(flags: JobFlags): Promise<string> {
  const body = jobBodyFromFlags(flags);
  return withScheduler(flags, async (scheduler, store) => {
    const input = jobInputFromJson(body, { host: "cli" });
    const job = await createJob(scheduler, input, { actor: "cli" });
    return written(job, store, scheduler, flags, `created ${job.jobId}`);
  });
}

/** `tidegap jobs edit <id>`: change only the fields the flags give. */
export async function runJobsEdit(jobId: string, flags: JobFlags): Promise<string> {
  return withScheduler(flags, async (scheduler, store) => {
    const current = requireJob(store, jobId);
    const body = jobBodyFromFlags(flags, current);
    if (Object.keys(body).length === 0) usage("nothing to change: give at least one flag");
    const job = await updateJob(scheduler, jobId, jobPatchFromJson(body, current), { actor: "cli" });
    return written(job, store, scheduler, flags, `updated ${job.jobId}`);
  });
}

type Action = "pause" | "resume" | "run" | "remove";

/** `tidegap jobs pause|resume|run|remove <id>`. The tick runs what these plan; none dispatches. */
export async function runJobsAction(action: Action, jobId: string, opts: JobsOptions = {}): Promise<string> {
  return withScheduler(opts, async (scheduler, store) => {
    requireJob(store, jobId);
    switch (action) {
      case "pause":
        return written(await pauseJob(scheduler, jobId, { actor: "cli" }), store, scheduler, opts, `paused ${jobId}`);
      case "resume":
        return written(await resumeJob(scheduler, jobId, { actor: "cli" }), store, scheduler, opts, `resumed ${jobId}`);
      case "remove": {
        await removeJob(scheduler, jobId, { actor: "cli" });
        return opts.json ? JSON.stringify({ job_id: jobId, status: "removed" }) : `removed ${jobId}; its history stays (tidegap jobs history ${jobId})`;
      }
      case "run": {
        const task = await runJobNow(scheduler, jobId, { actor: "cli" });
        return opts.json
          ? JSON.stringify(viewOf(requireJob(store, jobId), store, scheduler, opts), null, 2)
          : `${jobId}: ${task.taskId} marked to run now; the next tick runs it`;
      }
    }
  });
}

/** `tidegap jobs history <id> [--limit N]`: past runs, newest first, with receipt ids (R29). */
export async function runJobsHistory(jobId: string, opts: JobsOptions & { limit?: string } = {}): Promise<string> {
  const limit = opts.limit === undefined ? 20 : Number(opts.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) usage("--limit must be a whole number from 1 to 1000");
  return withScheduler(opts, (scheduler, store) => {
    requireJob(store, jobId);
    const runs = jobRuns(store, jobId, { limit }).runs.map((r) => runView(r, scheduler));
    if (opts.json) return JSON.stringify({ runs }, null, 2);
    if (runs.length === 0) return `${jobId}: no runs yet`;
    const header = `${pad("RUN", 22)}${pad("STATUS", 11)}${pad("FINISHED", 26)}${pad("RECEIPT", 22)}CARBON`;
    const rows = runs.map((r) => {
      const g = typeof r.carbon_g === "number" ? `${r.carbon_g.toFixed(2)} g` : "-";
      return `${pad(String(r.task_id), 22)}${pad(String(r.status), 11)}${pad(String(r.completed_at ?? r.scheduled_for ?? "-"), 26)}${pad(String(r.receipt_id ?? "-"), 22)}${g}`;
    });
    return [header, ...rows, "", "Verify a receipt: tidegap verify <receipt id>"].join("\n");
  });
}

// ── Secrets ───────────────────────────────────────────────────────────────

/** The refusal of `secrets set NAME <value>`: the value never comes from argv (visible in `ps` and shell history). */
export const SECRET_VALUE_AS_ARGUMENT =
  "the value is never an argument: pipe it on stdin or type it at the hidden prompt (and remove it from your shell history)";

/** A bad secret name is a usage error (exit 2). */
function checkSecretName(name: string): void {
  try {
    assertJobSecretName(name);
  } catch (err) {
    throw new JobsCommandError((err as Error).message, EXIT.usage);
  }
}

/** A secrets-file refusal after the name passed: a failure (exit 1). */
function secretFileError(err: Error): JobsCommandError {
  return new JobsCommandError(err.message, EXIT.failed);
}

/** `tidegap jobs secrets list`: names only. */
export function runJobsSecretsList(opts: JobsOptions = {}): string {
  const names = listJobSecretNames(opts.secretsFile, (line) => process.stderr.write(`${line}\n`));
  if (opts.json) return JSON.stringify({ names });
  return names.length > 0 ? names.join("\n") : "No job secrets. Set one: tidegap jobs secrets set <NAME> (the value comes from stdin)";
}

export interface SecretInput {
  /** All of stdin (piped input). */
  readStdin?: () => Promise<string>;
  /** stdin is a terminal: ask for the value with a hidden prompt. */
  isTTY?: boolean;
  prompt?: (question: string) => Promise<string>;
}

const readAll = async (): Promise<string> => {
  let text = "";
  for await (const chunk of process.stdin) text += String(chunk);
  return text;
};

/**
 * `tidegap jobs secrets set <NAME>`: the value is one line from stdin, or a
 * hidden prompt on a terminal; never an argument. Prints the name only.
 */
export async function runJobsSecretsSet(name: string, opts: JobsOptions = {}, io: SecretInput = {}): Promise<string> {
  checkSecretName(name);
  let value: string;
  try {
    if (io.isTTY ?? process.stdin.isTTY === true) {
      value = await (io.prompt ?? ((q) => promptSecret(q)))(`Value of ${name} (hidden): `);
    } else {
      value = (await (io.readStdin ?? readAll)()).split(/\r?\n/)[0] ?? "";
    }
  } catch (err) {
    if (err instanceof PromptCancelled) throw new JobsCommandError("cancelled; nothing saved");
    throw err;
  }
  try {
    setJobSecret(name, value, opts.secretsFile);
  } catch (err) {
    throw secretFileError(err as Error);
  }
  return `secret ${name} saved`;
}

/** `tidegap jobs secrets remove <NAME>`. */
export function runJobsSecretsRemove(name: string, opts: JobsOptions = {}): string {
  checkSecretName(name);
  let removed: boolean;
  try {
    removed = removeJobSecret(name, opts.secretsFile);
  } catch (err) {
    throw secretFileError(err as Error);
  }
  if (!removed) throw new JobsCommandError(`secret ${name} is not set`);
  return `secret ${name} removed`;
}
