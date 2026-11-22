/**
 * The `command` pseudo-provider (jobs KTD6): runs a command job's shell
 * step, then, when the job has one, its summarize step. Built only by the
 * CLI tick; the scheduler leaves `command` rows alone where no such adapter
 * exists (the OpenClaw ticker, the UI server).
 *
 * Safety model (KD4, KD5, R11-R14):
 *
 * - Only a row of a `command` job, or a one-off command the user queued
 *   with `tidegap queue add --runner command` (no job, `origin: "cli"`),
 *   is run; anything else is refused.
 * - The shell step gets the minimal environment plus the job's named
 *   secrets, its own process group, the command time limit the scheduler
 *   resolved for the run (`none`: no timer) and the job's output cap
 *   (`jobs/run-shell.ts`). A cancel of the task while it runs (the dispatch
 *   `signal`) stops the group as at the time limit, and the summarize call.
 * - Every secret value, and every vendor key shape, is scrubbed out of the
 *   output, the stderr tail, each progress line and every error before it is
 *   returned, stored, summarized or sent on. Where the output cap or the
 *   stderr tail cut the text, a fragment of a value at the cut goes too
 *   (`scrubCutEdges`). A progress line is always whole, so it has no cut.
 * - A summarize step never fails the run: when its provider has no
 *   adapter, or it errs, times out, runs over its budget or answers with
 *   nothing, the run completes with the command's output and a
 *   `summaryError`. With a reply, `text` is still the command's output and
 *   the reply is the run's `summary`.
 * - The summarize step has zero tools (`tools: []`): the model reads the
 *   output and can only answer. It reads the names of the run's attachments,
 *   never their bytes, and cannot make one.
 * - With an attachment store and a task id, each attempt gets a fresh
 *   private `TIDEGAP_ATTACH_DIR`; after an exit 0 its files are checked and
 *   stored under the task (`jobs/attachments.ts`). The incoming folder goes
 *   on every path; the stored files go too when the attempt then throws (a
 *   deferral, a failure, a cancel), so a task keeps only the files of its
 *   completed attempt.
 * - Every error leaving the adapter is a {@link NonRetryableError}, so the
 *   call is never sent again at once; the summarize call is resent here
 *   instead. The task's retry policy may run a failed command again later
 *   (one retry by default, `--retries 0` runs it once): a refusal or
 *   missing setup is marked permanent and never retries. A
 *   usage-limit deferral ({@link ProviderDeferError}) propagates as is: the
 *   occurrence goes back to the queue and the command runs again on the
 *   deferred dispatch.
 */

import { homedir } from "node:os";

import {
  cleanProgressText,
  DEFAULT_JOB_CAPS,
  formatDuration,
  JOB_INTERRUPTED_ERROR,
  NonRetryableError,
  permanentError,
  ProviderDeferError,
  redactPrompt,
  retryWithBackoff,
  RUN_LIMITS,
  scrubCutEdges,
  scrubValues,
  type DispatchOptions,
  type DispatchResult,
  type JobCaps,
  type ProviderAdapter,
  type RunDetails,
  type StoredAttachment,
  type TickAdapters,
  effectiveSummarizePrompt,
  type NoticeLanguage,
} from "@tidegap/core";

/** The built-in command time limit, for a call that names none (a direct call; the scheduler always names it). */
const COMMAND_TIMEOUT_DEFAULT_MS = RUN_LIMITS.find((d) => d.name === "command_timeout")!.defaults.command!;

import { attachmentsLine, intakeAttachments, makeIncomingDir, removeDir, taskAttachmentDir, type IntakeResult } from "../jobs/attachments.js";
import { childEnv, runShell, type RunShellResult } from "../jobs/run-shell.js";
import type { JobSecretsRead } from "../jobs/secrets.js";
import { expandHome, isDirectory } from "./claude-code.js";
import { commandHintApplies, formatQuiet, MACOS_PRIVACY_HINT, privacyNextStep, quietBeforeStop } from "./macos-privacy.js";

export interface CommandAdapterOptions {
  /** The adapters of this tick; the summarize step uses its provider's one. */
  adapters: TickAdapters;
  /** The job's runner (`prompt` or `command`), or undefined for an unknown job. */
  jobRunner: (jobId: string) => string | undefined;
  /** The job's title, for the summarize input; undefined when unknown. */
  jobTitle?: (jobId: string) => string | undefined;
  /** The notice language setting, read on each summarize call; undefined when unset. */
  noticeLanguage?: () => NoticeLanguage | undefined;
  /** The attachment store (`attachmentsRoot`); absent, the command gets no `TIDEGAP_ATTACH_DIR`. */
  attachmentsRoot?: string;
  /** Reads the named job secrets (`readJobSecrets`). */
  readSecrets: (names: readonly string[]) => JobSecretsRead;
  /** The environment the allowlist is taken from; default `process.env`. */
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  /** Time between SIGTERM and SIGKILL (tests). */
  killGraceMs?: number;
}


/** The longest run of backticks in `text`, plus one, at least three. */
function fence(text: string): string {
  let longest = 0;
  for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * The summarize input: the user's prompt, the reply language when one is
 * set, the job's title when known, the names of the run's attachments, then
 * the last `capBytes` of the output in a fenced block.
 */
export function summarizeInput(
  prompt: string,
  output: string,
  capBytes: number,
  title?: string,
  language?: NoticeLanguage,
  attachments: readonly StoredAttachment[] = [],
): string {
  const bytes = Buffer.from(output, "utf8");
  let body = output;
  let note = "";
  if (bytes.length > capBytes) {
    body = bytes.subarray(bytes.length - capBytes).toString("utf8");
    note = `[command output truncated: the last ${Math.round(capBytes / 1024)} KB of ${Math.round(bytes.length / 1024)} KB follow]\n`;
  }
  const f = fence(body);
  const named = title ? `Job title: ${title}\n\n` : "";
  const reply = language ? `Reply language: ${language.name} (${language.code}). Use another language only when the prompt above asks for it.\n\n` : "";
  const files = attachments.length > 0 ? `${attachmentsLine(attachments)}\n\n` : "";
  return `${prompt}\n\n${reply}${named}${files}Command output:\n${note}${f}\n${body}\n${f}`;
}

/** The run's files checked and stored; a store that cannot be written keeps none and says so, and the run still completes. */
function storeAttachments(attach: { incoming: string; taskDir: string }, secrets: readonly string[]): IntakeResult {
  try {
    return intakeAttachments({ ...attach, secrets });
  } catch {
    removeDir(attach.taskDir);
    return { attachments: [], skipped: [{ name: "the run's files", reason: "not stored: the attachment folder could not be written" }] };
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class CommandAdapter implements ProviderAdapter {
  readonly provider = "command";
  readonly ready = true;
  private readonly opts: CommandAdapterOptions;

  constructor(opts: CommandAdapterOptions) {
    this.opts = opts;
  }

  async dispatch(model: string, prompt: string, options: DispatchOptions = {}): Promise<DispatchResult> {
    let secrets: string[] = [];
    const scrub = (text: string) => redactPrompt(scrubValues(text, secrets), undefined);
    let attach: { incoming: string; taskDir: string } | undefined;
    let stored = false;
    try {
      const jobId = options.jobId;
      const step = options.command;
      if (jobId) {
        if (this.opts.jobRunner(jobId) !== "command") {
          throw permanentError(`command: refused: job ${jobId} is not a command job`);
        }
      } else if (step?.origin !== "cli") {
        throw permanentError("command: refused: the task is not a run of a job or a one-off command queued with tidegap queue add");
      }
      const what = jobId ? `the run of job ${jobId}` : "the one-off task";
      if (!step || typeof step.run !== "string" || step.run.trim() === "") {
        throw permanentError(`command: refused: ${what} has no command`);
      }
      const caps: JobCaps = { ...DEFAULT_JOB_CAPS, ...options.caps };
      const commandTimeout = options.commandTimeoutMs ?? COMMAND_TIMEOUT_DEFAULT_MS;
      const read = this.opts.readSecrets(step.secrets ?? []);
      secrets = Object.values(read.values);
      if (read.problem) throw permanentError(read.problem);
      const missing = read.missing[0];
      if (missing) {
        throw permanentError(`secret ${missing} is not set; run: tidegap jobs secrets set ${missing}`);
      }
      const home = this.opts.home ?? homedir();
      const cwd = expandHome(step.cwd ?? "~", home);
      if (!isDirectory(cwd)) throw permanentError(`command: working directory ${cwd} does not exist`);
      const root = this.opts.attachmentsRoot;
      if (root && options.taskId) attach = { taskDir: taskAttachmentDir(root, options.taskId), incoming: makeIncomingDir(root) };

      const run = await runShell({
        command: step.run,
        cwd,
        env: childEnv(this.opts.env ?? process.env, read.values, attach?.incoming),
        timeoutMs: commandTimeout,
        outputCapBytes: caps.outputCapBytes,
        ...(this.opts.killGraceMs !== undefined ? { killGraceMs: this.opts.killGraceMs } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        // The core caps which lines become progress events. Each leaves here
        // cleaned, then scrubbed: a removed character cannot join a secret.
        ...(options.onProgress ? { onLine: (line: string) => options.onProgress!(scrub(cleanProgressText(line))) } : {}),
      });
      // Progress is the shell step's output only, never a summarize step's time.
      options.onProgressEnd?.();
      // The stderr tail has its own budget: only its start can be cut.
      const stderr = scrubCutEdges(scrubValues(run.stderrTail, secrets), secrets, { start: run.stderrCut });
      const failure = this.shellFailure(run, stderr, commandTimeout, cwd, step.run, home);
      if (failure) throw new NonRetryableError(scrub(failure.message), failure.details, { interrupted: failure.interrupted });

      const output = scrub(scrubCutEdges(scrubValues(run.stdout, secrets), secrets, { end: run.truncated }));
      const truncated = run.truncated ? { truncated: true } : {};
      stored = attach !== undefined;
      const intake = attach ? storeAttachments(attach, secrets) : { attachments: [], skipped: [] };
      const files = {
        ...(intake.attachments.length > 0 ? { attachments: intake.attachments } : {}),
        ...(intake.skipped.length > 0 ? { attachmentsSkipped: intake.skipped } : {}),
      };
      const commandOnly: DispatchResult = {
        text: output.trimEnd(),
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        model: "none",
        provider: this.provider,
        raw: { exitCode: run.code, ...truncated },
        details: { steps: ["command"], ...truncated },
        ...files,
      };
      if (!options.summarize) return commandOnly;
      const summary = await this.summarize(model, prompt, output, caps, options, scrub, jobId, intake.attachments);
      const details = { steps: ["command", "prompt"], ...truncated };
      if ("summaryError" in summary) return { ...commandOnly, summaryError: summary.summaryError, details };
      return { ...summary.result, text: commandOnly.text, summary: summary.text, tools: [], details, ...files };
    } catch (err) {
      if (stored) removeDir(attach!.taskDir);
      if (err instanceof ProviderDeferError || err instanceof NonRetryableError) throw err;
      throw new NonRetryableError(scrub(`command: ${errText(err)}`));
    } finally {
      if (attach) removeDir(attach.incoming);
    }
  }

  /** The error of a shell step that did not exit 0, or undefined. `stderr` is the scrubbed tail; the rest is not yet scrubbed. */
  private shellFailure(
    run: RunShellResult,
    stderr: string,
    timeoutMs: number | "none",
    cwd: string,
    command: string,
    home: string,
  ): { message: string; details: RunDetails; interrupted?: "run" } | undefined {
    if (run.cancelled) return { message: "command: stopped: the task was cancelled", details: { steps: ["command"] } };
    const tail = stderr.trim();
    const stderrPart = tail ? `; stderr: ${tail}` : "";
    if (run.timedOut) {
      const details: RunDetails = { steps: ["command"], stopped_by: "command_timeout" };
      const limit = `stopped: command time limit ${formatDuration(timeoutMs)}`;
      const limitMs = timeoutMs === "none" ? Number.POSITIVE_INFINITY : timeoutMs;
      const platform = this.opts.platform ?? process.platform;
      if (!commandHintApplies({ platform, timedOut: true, quietMs: run.quietMs, limitMs, noStderr: !tail, cwd, command })) {
        return { message: `${limit}${stderrPart}`, details };
      }
      // KTD8: the cause and a short next step on the first line, which
      // one-line surfaces show; the full next step, then the stderr tail.
      const quiet = quietBeforeStop(run.quietMs, limitMs) ? `; no output for ${formatQuiet(run.quietMs)}` : "";
      const lines = [`${limit}${quiet} (${MACOS_PRIVACY_HINT})`, privacyNextStep(process.execPath, home)];
      if (tail) lines.push(`stderr: ${tail}`);
      return { message: lines.join("\n"), details };
    }
    if (run.code === 0) return undefined;
    if (run.stoppedByTick) return { message: JOB_INTERRUPTED_ERROR, details: { steps: ["command"] }, interrupted: "run" };
    if (run.code === null) {
      return { message: `command stopped by signal ${run.signal ?? "unknown"}${stderrPart}`, details: { steps: ["command"] } };
    }
    const hint = run.code === 127 ? " (command not found under the daemon's PATH; use an absolute path)" : "";
    return { message: `command exited with code ${run.code}${hint}${stderrPart}`, details: { steps: ["command"] } };
  }

  /**
   * The tool-less summarize step (R12): the user's prompt plus the scrubbed
   * output. Its reply, scrubbed and trimmed, or the scrubbed reason it gave
   * none; only a usage-limit deferral is thrown.
   */
  private async summarize(
    model: string,
    prompt: string,
    output: string,
    caps: JobCaps,
    options: DispatchOptions,
    scrub: (text: string) => string,
    jobId: string | undefined,
    attachments: readonly StoredAttachment[],
  ): Promise<{ result: DispatchResult; text: string } | { summaryError: string }> {
    const step = options.summarize!;
    const adapter = this.opts.adapters[step.provider];
    if (!adapter || !adapter.ready) return { summaryError: scrub(`summarize provider ${step.provider} is not configured`) };
    const signal = options.signal;
    const title = jobId ? this.opts.jobTitle?.(jobId) : undefined;
    const input = summarizeInput(effectiveSummarizePrompt(prompt), output, caps.summarizeInputCapBytes, title, this.opts.noticeLanguage?.(), attachments);
    let result: DispatchResult;
    try {
      result = await retryWithBackoff(
        () =>
          adapter.dispatch(step.model ?? model, input, {
            tools: [],
            ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
            maxBudgetUsd: caps.maxBudgetUsd,
            ...(signal ? { signal } : {}),
          }),
        signal,
      );
    } catch (err) {
      if (err instanceof ProviderDeferError) throw err;
      return { summaryError: scrub(`summarize: ${errText(err)}`) };
    }
    const text = typeof result.text === "string" ? scrub(result.text).trim() : "";
    if (!text) return { summaryError: "summarize: the reply was empty" };
    return { result, text };
  }
}
