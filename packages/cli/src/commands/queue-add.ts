/**
 * `tidegap queue add` — queue one task for any runner from a shell or the
 * Bash tool of an agent session: an LLM prompt (`claude-code`, `anthropic`,
 * `openai`, `gemini`, `ollama`) or a one-off shell command (`command`).
 *
 * The write goes through the adapter-free scheduler of the other queue
 * writes, so this command never runs the task; `tidegap tick` does. Inside
 * a Claude Code session the task records that session (a checked origin), so
 * its notice comes back to that session's next prompt. A shell command is
 * the user's decision: the plugin's guard asks before an agent runs this
 * command with a runner other than the LLM runners.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import {
  COMMAND_MAX_CHARS,
  DEFAULT_MODEL_BY_PROVIDER,
  BATCH_LLM_TIMEOUT_NOTE,
  describeRunLimit,
  DurationError,
  mayRunAsBatch,
  parseRetries,
  parseRetryDelay,
  retryPolicyText,
  runLimitsDetails,
  handoffCwdError,
  loadQuotaResetConfig,
  parseDuration,
  profileTools,
  resolveQuotaDeadline,
  resolveQuotaProvider,
  resultPathError,
  stripControlChars,
  writeWakeMarker,
} from "@tidegap/core";
import type { DeferOptions, DurationValue, ProviderCallOrigin, ProviderCallSpec, ProviderName, TaskRecord } from "@tidegap/core";

import { readEnvCredentials, readUsageEnv } from "../env.js";
import { currentSession, requireOwnSession, UsageError, type CurrentSession, type SessionSources } from "../handoff/session.js";
import { hostResetTarget, type HostLimitsOptions } from "../usage/index.js";
import type { TargetResult } from "../usage/target.js";
import { loadEnvFileIntoProcess } from "./env-file.js";
import { actionScheduler, parseWhen, writeResult, type QueueWriteOptions } from "./queue.js";
import { defaultDbPath } from "./tick.js";

/** The runners `queue add` takes. */
export const QUEUE_ADD_RUNNERS = ["claude-code", "anthropic", "openai", "gemini", "ollama", "command"] as const;
export type QueueAddRunner = (typeof QUEUE_ADD_RUNNERS)[number];

/** Most text `-` reads from stdin. */
export const QUEUE_ADD_STDIN_MAX_BYTES = 1024 * 1024;

/** The `--by` forms, quoted in its errors. */
export const QUEUE_ADD_BY_FORMS = "a duration (30m, 2h, 3d, 1w), an ISO-8601 time, or quota-reset";

/** The keys of `queue add --json`, in print order. The handoff page lists them; docs-drift compares. */
export const QUEUE_ADD_JSON_KEYS = Object.freeze([
  "task_id",
  "status",
  "runner",
  "scheduled_for",
  "deadline",
  "origin_session_id",
  "result_path",
  "wake",
  "wake_armed",
] as const);
type QueueAddJsonKey = (typeof QUEUE_ADD_JSON_KEYS)[number];

export interface QueueAddOptions extends QueueWriteOptions {
  runner?: string;
  /** Deadline: a duration, an ISO-8601 time, or `quota-reset`. Required. */
  by?: string;
  quotaProvider?: string;
  notBefore?: string;
  afterLimitReset?: boolean;
  cwd?: string;
  profile?: string;
  model?: string;
  resultPath?: string;
  title?: string;
  /** `current` or this session's id; any other id is refused. */
  session?: string;
  /** Time limit of a `command` run: `90s`, `30m`, `2h`, `2d` or `none`. Unset: the setting when it runs. */
  commandTimeout?: string;
  /** Time limit of an LLM run, in the same grammar. Unset: the setting when it runs. */
  llmTimeout?: string;
  /** Automatic retries of a failed run, 0 to 10. Unset: the setting when it fails. */
  retries?: string;
  /** Wait before the first retry, a duration (each later retry waits twice the one before). Unset: the setting. */
  retryDelay?: string;
  /** Wake this Claude Code session when the task finishes, if it sits idle. */
  wake?: boolean;
  json?: boolean;
  /** `~/.tidegap/config` (the quota resets) override. */
  config?: string;
  /** Usage read overrides for `--after-limit-reset` (tests). */
  usage?: HostLimitsOptions;
  /** Tests: the session sources, the folder relative paths resolve in, the stdin reader, the reset source. */
  sessionSources?: SessionSources;
  workDir?: string;
  readStdin?: () => string;
  resetTarget?: (model: string | undefined, now: Date) => Promise<TargetResult>;
}

export interface QueueAddResult {
  record: TaskRecord<unknown>;
  rendered: string;
}

/** A usage error naming the command. */
function usage(message: string): UsageError {
  return new UsageError(`queue add: ${message}`);
}

/** `~` and `~/x` expanded, then resolved against `workDir`. */
function absolute(value: string, workDir: string): string {
  const home = homedir();
  const expanded = value === "~" ? home : value.startsWith("~/") ? `${home}/${value.slice(2)}` : value;
  return resolve(workDir, expanded);
}

/** The stdin text of `-`, at most {@link QUEUE_ADD_STDIN_MAX_BYTES}. */
function readStdinText(): string {
  if (process.stdin.isTTY) throw usage("text - reads stdin, and stdin is a terminal");
  const buf = readFileSync(0);
  if (buf.length > QUEUE_ADD_STDIN_MAX_BYTES) throw usage(`stdin holds more than ${QUEUE_ADD_STDIN_MAX_BYTES} bytes`);
  return buf.toString("utf8");
}

/** A flag in the grammar `parse` checks (the registry's); the error is its sentence. */
function flagValue<T>(flag: string, value: string, parse: (text: string) => T): T {
  try {
    return parse(value);
  } catch (err) {
    if (err instanceof DurationError) throw usage(`${flag}: ${err.message}`);
    throw err;
  }
}

/** A time limit flag in the shared grammar, in ms or `"none"`; the error names `none`. */
function timeLimit(flag: string, value: string): DurationValue {
  return flagValue(flag, value, parseDuration);
}

/** The project folder to record for a task: the session's, else the folder the CLI runs in; never `/` or the home folder. */
function originCwdOf(session: CurrentSession | undefined, workDir: string): string | undefined {
  const cwd = session?.cwd ?? workDir;
  return cwd === "/" || cwd === homedir() ? undefined : cwd;
}

/**
 * `tidegap queue add [--runner <name>] --by <when> [options] <text>`: queue
 * one task. `<text>` is the prompt, or the shell command of `--runner
 * command`; `-` reads it from stdin. The first output line is the task id
 * alone. Throws {@link UsageError} (exit 2) on bad input, including an
 * option the runner does not take and a refused path; other errors are the
 * scheduler's refusals (exit 1).
 */
export async function runQueueAdd(textArg: string, opts: QueueAddOptions = {}): Promise<QueueAddResult> {
  const now = opts.now?.() ?? new Date();
  const workDir = opts.workDir ?? process.cwd();
  const sources = opts.sessionSources;
  // The secrets file first, as every write does: TIDEGAP_DEFAULT_MODEL may live there.
  loadEnvFileIntoProcess();

  // The session first: the default runner depends on it.
  const session =
    opts.session !== undefined
      ? requireOwnSession("queue add", opts.session, sources, "drop --session: queue add records the session it runs in by itself")
      : currentSession(sources);
  const runnerName = opts.runner ?? (session ? "claude-code" : "anthropic");
  if (!(QUEUE_ADD_RUNNERS as readonly string[]).includes(runnerName)) {
    throw usage(`--runner must be one of ${QUEUE_ADD_RUNNERS.join(", ")}, got ${JSON.stringify(runnerName)}`);
  }
  const runner = runnerName as QueueAddRunner;
  const notFor = (flag: string, runners: string) => usage(`${flag} applies to runner ${runners} only, not ${runner}`);
  if (opts.cwd !== undefined && runner !== "claude-code" && runner !== "command") throw notFor("--cwd", "claude-code or command");
  if (opts.profile !== undefined && runner !== "claude-code") throw notFor("--profile", "claude-code");
  if (opts.commandTimeout !== undefined && runner !== "command") throw notFor("--command-timeout", "command");
  if (opts.llmTimeout !== undefined && runner === "command") {
    throw usage("--llm-timeout applies to the LLM runners, not command; use --command-timeout");
  }
  if (opts.model !== undefined && runner === "command") throw usage("--model does not apply to runner command, which runs no model");
  if (opts.wake && !session) {
    throw usage("--wake needs a Claude Code session: it wakes the session that queued the task; follow the task with tidegap queue wait instead");
  }

  // The text.
  let text = textArg === "-" ? (opts.readStdin ?? readStdinText)() : textArg;
  if (Buffer.byteLength(text, "utf8") > QUEUE_ADD_STDIN_MAX_BYTES) throw usage(`the text is longer than ${QUEUE_ADD_STDIN_MAX_BYTES} bytes`);
  if (runner === "command") text = text.replace(/\n+$/, "");
  if (text.trim() === "") throw usage(runner === "command" ? "the command is empty" : "the prompt is empty");
  if (runner === "command" && text.length > COMMAND_MAX_CHARS) throw usage(`the command is longer than ${COMMAND_MAX_CHARS} characters`);
  const own = {
    ...(opts.commandTimeout !== undefined ? { commandTimeoutMs: timeLimit("--command-timeout", opts.commandTimeout) } : {}),
    ...(opts.llmTimeout !== undefined ? { llmTimeoutMs: timeLimit("--llm-timeout", opts.llmTimeout) } : {}),
    ...(opts.retries !== undefined ? { retries: flagValue("--retries", opts.retries, parseRetries) } : {}),
    ...(opts.retryDelay !== undefined ? { retryDelayMs: flagValue("--retry-delay", opts.retryDelay, parseRetryDelay) } : {}),
  };
  const caps = Object.keys(own).length > 0 ? own : undefined;

  // The deadline and the earliest start.
  if (opts.by === undefined) throw usage(`--by is required: ${QUEUE_ADD_BY_FORMS}`);
  const timing: Pick<DeferOptions, "deadline" | "deadlineKind" | "quotaProvider" | "notBefore"> = {};
  if (opts.by.trim().toLowerCase() === "quota-reset") {
    const pick = resolveQuotaProvider(loadQuotaResetConfig(opts.config !== undefined ? { path: opts.config } : {}), opts.quotaProvider);
    if (!pick.ok) throw usage(`--by quota-reset: ${pick.error}`);
    timing.deadline = resolveQuotaDeadline(pick.schedule, now).deadline;
    timing.deadlineKind = "quota_reset";
    timing.quotaProvider = pick.schedule.label;
  } else {
    if (opts.quotaProvider !== undefined) throw usage("--quota-provider goes with --by quota-reset");
    let at: Date;
    try {
      at = parseWhen(opts.by, now);
    } catch {
      throw usage(`cannot read --by ${JSON.stringify(opts.by)}; use ${QUEUE_ADD_BY_FORMS}`);
    }
    if (!(at.getTime() > now.getTime())) throw usage(`--by ${JSON.stringify(opts.by)} is not in the future`);
    timing.deadline = at;
  }
  if (opts.notBefore !== undefined && opts.afterLimitReset) throw usage("pass --not-before or --after-limit-reset, not both");
  const model = runner === "command" ? undefined : (opts.model ?? defaultModel(runner));
  if (opts.notBefore !== undefined) {
    let at: Date;
    try {
      at = parseWhen(opts.notBefore, now);
    } catch {
      throw usage(`cannot read --not-before ${JSON.stringify(opts.notBefore)}; use a duration (30m, 2h) or an ISO-8601 time`);
    }
    if (!(at.getTime() > now.getTime())) throw usage(`--not-before ${JSON.stringify(opts.notBefore)} is not in the future`);
    if (at.getTime() > (timing.deadline as Date).getTime()) throw usage("--not-before is after the --by deadline");
    timing.notBefore = at;
  } else if (opts.afterLimitReset) {
    const target = opts.resetTarget ?? ((m, at) => hostResetTarget({ env: readUsageEnv(), ...opts.usage, now: at, model: m }));
    const res = await target(model, now);
    if (!res.ok) throw new Error(`queue add: --after-limit-reset: ${res.reason}`);
    timing.notBefore = res.target.at;
  }

  // The folders.
  const originCwd = originCwdOf(session, workDir);
  const cwd = opts.cwd !== undefined ? absolute(opts.cwd, workDir) : runner === "command" ? workDir : undefined;
  if (cwd !== undefined) {
    const refused = handoffCwdError(cwd, runner === "command" ? "command" : "claude-code");
    if (refused) throw usage(refused);
  }
  let profile: string | undefined;
  if (runner === "claude-code") {
    const choice = profileTools(opts.profile, cwd);
    if (choice.error) throw usage(choice.error);
    profile = choice.profile;
  }
  const resultPath = opts.resultPath !== undefined ? absolute(opts.resultPath, workDir) : undefined;
  if (resultPath !== undefined) {
    const refused = resultPathError(resultPath, { cwd, originCwd });
    if (refused) throw usage(refused);
  }

  const origin: ProviderCallOrigin | undefined = session ? { ...session.origin } : undefined;
  const defer: DeferOptions = {
    ...timing,
    originHost: "cli",
    ...(originCwd ? { originCwd } : {}),
    ...(session ? { originSessionId: session.sessionId } : {}),
    ...(opts.title !== undefined ? { title: opts.title } : {}),
  };
  const dbPath = opts.db ?? defaultDbPath();
  const scheduler = actionScheduler({ ...opts, dbPath });
  let record: TaskRecord<unknown>;
  try {
    if (runner === "command") {
      record = await scheduler.enqueueCommandTask(
        {
          run: text,
          cwd: cwd!,
          ...(caps ? { caps } : {}),
          ...(resultPath !== undefined ? { resultPath } : {}),
          ...(origin ? { origin } : {}),
          ...(opts.wake ? { wake: true } : {}),
        },
        defer,
      );
    } else {
      const handoff = {
        ...(cwd !== undefined ? { cwd } : {}),
        ...(profile !== undefined ? { profile } : {}),
        ...(resultPath !== undefined ? { resultPath } : {}),
        ...(opts.wake ? { wake: true } : {}),
      } as NonNullable<ProviderCallSpec["handoff"]>;
      const spec: ProviderCallSpec = {
        type: "provider_call",
        provider: runner as ProviderName,
        model: model!,
        prompt: text,
        ...(Object.keys(handoff).length > 0 ? { handoff } : {}),
        ...(origin ? { origin } : {}),
        ...(caps ? { caps } : {}),
      };
      record = await scheduler.enqueueProviderCall(spec, defer);
    }
  } catch (err) {
    scheduler.shutdown();
    throw err;
  }
  // The marker lets the plugin's Stop hook of this same turn start its waiter.
  const wakeProblem = opts.wake && session ? writeWakeMarker(session.sessionId) : undefined;
  if (opts.json) {
    scheduler.shutdown();
    const fields: Record<QueueAddJsonKey, unknown> = {
      task_id: record.taskId,
      status: record.status,
      runner,
      scheduled_for: record.scheduledFor ?? null,
      deadline: record.deadline ?? null,
      origin_session_id: record.originSessionId ?? null,
      result_path: resultPath ?? null,
      wake: opts.wake === true,
      // False when the marker could not be written: the notice then waits for the next prompt.
      wake_armed: opts.wake === true && wakeProblem === undefined,
    };
    return { record, rendered: JSON.stringify(Object.fromEntries(QUEUE_ADD_JSON_KEYS.map((k) => [k, fields[k]])), null, 2) };
  }
  const limits = scheduler.runLimitsFor(JSON.parse(record.bodyJson!) as ProviderCallSpec);
  const limit = limits.command_timeout ?? limits.llm_timeout;
  const retries = retryPolicyText(runLimitsDetails(limits));
  const runOnce = runner === "command" && limits.retries?.value !== 0 ? "; --retries 0 runs it once" : "";
  const extra = [
    `runner: ${runner}`,
    ...(limit ? [`time limit: ${describeRunLimit(limit)}`] : []),
    ...(retries ? [`retries: ${retries}${runOnce}`] : []),
    ...(caps?.llmTimeoutMs !== undefined && mayRunAsBatch(runner, Date.parse(record.deadline ?? ""), now.getTime())
      ? [`llm_timeout: ${BATCH_LLM_TIMEOUT_NOTE}`]
      : []),
    ...(cwd ? [`cwd: ${stripControlChars(cwd)}`] : []),
    ...(profile ? [`profile: ${profile}`] : []),
    ...(resultPath ? [`result_path: ${stripControlChars(resultPath)}`] : []),
    ...(opts.wake
      ? [
          wakeProblem
            ? `wake: not armed (${stripControlChars(wakeProblem)}); the notice comes with the next prompt`
            : "wake: on (this session wakes when the task finishes, if it is idle, within 12 hours after its last turn)",
        ]
      : []),
    session
      ? `origin_session: ${session.sessionId} (its next prompt gets the notice)`
      : "notices: off (not queued from a Claude Code session); follow it with tidegap queue wait",
  ];
  return { record, rendered: writeResult(scheduler, dbPath, record, record.taskId, extra) };
}

/** The model of a runner without `--model`: `TIDEGAP_DEFAULT_MODEL` for anthropic, else the shared default. */
function defaultModel(runner: Exclude<QueueAddRunner, "command">): string {
  if (runner === "anthropic") return readEnvCredentials().defaultModel ?? DEFAULT_MODEL_BY_PROVIDER.anthropic;
  return DEFAULT_MODEL_BY_PROVIDER[runner];
}
