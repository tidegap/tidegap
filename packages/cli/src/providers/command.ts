/**
 * The `command` pseudo-provider (jobs KTD6): runs a command job's shell
 * step, then, when the job has one, its summarize step. Built only by the
 * CLI tick; the scheduler leaves `command` rows alone where no such adapter
 * exists (the OpenClaw ticker, the UI server).
 *
 * Safety model (KD4, KD5, R11-R14):
 *
 * - Only a row of a `command` job is run; anything else is refused.
 * - The shell step gets the minimal environment plus the job's named
 *   secrets, its own process group and the job's time and output caps
 *   (`jobs/run-shell.ts`).
 * - Every secret value, and every vendor key shape, is scrubbed out of the
 *   output, the stderr tail and every error before it is returned, stored,
 *   summarized or sent on. Where the output cap or the stderr tail cut the
 *   text, a fragment of a value at the cut goes too (`scrubCutEdges`).
 * - A summarize step whose provider has no adapter fails before the
 *   command runs.
 * - The summarize step has zero tools (`tools: []`): the model reads the
 *   output and can only answer.
 * - Every error leaving the adapter is a {@link NonRetryableError}, so the
 *   scheduler never runs the command twice; the summarize call is retried
 *   here instead. A usage-limit deferral ({@link ProviderDeferError})
 *   propagates as is: the occurrence goes back to the queue and the command
 *   runs again on the deferred dispatch.
 */

import { homedir } from "node:os";

import {
  DEFAULT_JOB_CAPS,
  NonRetryableError,
  ProviderDeferError,
  redactPrompt,
  retryWithBackoff,
  scrubCutEdges,
  scrubValues,
  type DispatchOptions,
  type DispatchResult,
  type JobCaps,
  type ProviderAdapter,
  type RunDetails,
  type TickAdapters,
} from "@tidegap/core";

import { childEnv, runShell, type RunShellResult } from "../jobs/run-shell.js";
import type { JobSecretsRead } from "../jobs/secrets.js";
import { expandHome, isDirectory } from "./claude-code.js";

export interface CommandAdapterOptions {
  /** The adapters of this tick; the summarize step uses its provider's one. */
  adapters: TickAdapters;
  /** The job's runner (`prompt` or `command`), or undefined for an unknown job. */
  jobRunner: (jobId: string) => string | undefined;
  /** Reads the named job secrets (`readJobSecrets`). */
  readSecrets: (names: readonly string[]) => JobSecretsRead;
  /** The environment the allowlist is taken from; default `process.env`. */
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  /** Time between SIGTERM and SIGKILL (tests). */
  killGraceMs?: number;
}

/** Folders whose access macOS asks about; a silent timeout there gets the hint. */
const PROTECTED_DIRS = /(^|[\s'"=:])(~|\$HOME|\/Users\/[^/\s]+)\/(Documents|Desktop|Downloads)(\/|$|[\s'"])/;
const MACOS_PRIVACY_HINT = "macOS: check for a pending Files & Folders prompt for the daemon's node";

/** "0 min 2 s", "5 min". */
export function durationLabel(ms: number): string {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 && s === 0 ? `${m} min` : `${m} min ${s} s`;
}

/** The longest run of backticks in `text`, plus one, at least three. */
function fence(text: string): string {
  let longest = 0;
  for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  return "`".repeat(Math.max(3, longest + 1));
}

/** The summarize input: the user's prompt, then the last `capBytes` of the output in a fenced block. */
export function summarizeInput(prompt: string, output: string, capBytes: number): string {
  const bytes = Buffer.from(output, "utf8");
  let body = output;
  let note = "";
  if (bytes.length > capBytes) {
    body = bytes.subarray(bytes.length - capBytes).toString("utf8");
    note = `[command output truncated: the last ${Math.round(capBytes / 1024)} KB of ${Math.round(bytes.length / 1024)} KB follow]\n`;
  }
  const f = fence(body);
  return `${prompt}\n\nCommand output:\n${note}${f}\n${body}\n${f}`;
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
    try {
      const jobId = options.jobId;
      if (!jobId) throw new NonRetryableError("command: refused: the task is not a run of a job");
      if (this.opts.jobRunner(jobId) !== "command") {
        throw new NonRetryableError(`command: refused: job ${jobId} is not a command job`);
      }
      const step = options.command;
      if (!step || typeof step.run !== "string" || step.run.trim() === "") {
        throw new NonRetryableError(`command: refused: the run of job ${jobId} has no command`);
      }
      const caps: JobCaps = { ...DEFAULT_JOB_CAPS, ...options.caps };
      // Before the command runs: a summarize step that cannot run would only repeat the command's work.
      const summarizer = options.summarize ? this.opts.adapters[options.summarize.provider] : undefined;
      if (options.summarize && (!summarizer || !summarizer.ready)) {
        throw new NonRetryableError(`summarize provider ${options.summarize.provider} is not configured`);
      }
      const read = this.opts.readSecrets(step.secrets ?? []);
      secrets = Object.values(read.values);
      if (read.problem) throw new NonRetryableError(read.problem);
      const missing = read.missing[0];
      if (missing) {
        throw new NonRetryableError(`secret ${missing} is not set; run: tidegap jobs secrets set ${missing}`);
      }
      const home = this.opts.home ?? homedir();
      const cwd = expandHome(step.cwd ?? "~", home);
      if (!isDirectory(cwd)) throw new NonRetryableError(`command: working directory ${cwd} does not exist`);

      const run = await runShell({
        command: step.run,
        cwd,
        env: childEnv(this.opts.env ?? process.env, read.values),
        timeoutMs: caps.commandTimeoutMs,
        outputCapBytes: caps.outputCapBytes,
        ...(this.opts.killGraceMs !== undefined ? { killGraceMs: this.opts.killGraceMs } : {}),
      });
      // The stderr tail has its own budget: only its start can be cut.
      const stderr = scrubCutEdges(scrubValues(run.stderrTail, secrets), secrets, { start: run.stderrCut });
      const failure = this.shellFailure(run, stderr, caps, cwd, step.run);
      if (failure) throw new NonRetryableError(scrub(failure.message), failure.details);

      const output = scrub(scrubCutEdges(scrubValues(run.stdout, secrets), secrets, { end: run.truncated }));
      const truncated = run.truncated ? { truncated: true } : {};
      if (!options.summarize) {
        return {
          text: output.trimEnd(),
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          model: "none",
          provider: this.provider,
          raw: { exitCode: run.code, ...truncated },
          details: { steps: ["command"], ...truncated },
        };
      }
      return await this.summarize(summarizer!, model, prompt, output, caps, options.summarize, truncated, scrub);
    } catch (err) {
      if (err instanceof ProviderDeferError || err instanceof NonRetryableError) throw err;
      throw new NonRetryableError(scrub(`command: ${errText(err)}`));
    }
  }

  /** The error of a shell step that did not exit 0, or undefined. `stderr` is the scrubbed tail; the rest is not yet scrubbed. */
  private shellFailure(
    run: RunShellResult,
    stderr: string,
    caps: JobCaps,
    cwd: string,
    command: string,
  ): { message: string; details: RunDetails } | undefined {
    const tail = stderr.trim();
    const stderrPart = tail ? `; stderr: ${tail}` : "";
    if (run.timedOut) {
      const silent = !tail && (this.opts.platform ?? process.platform) === "darwin" && (PROTECTED_DIRS.test(` ${cwd}`) || PROTECTED_DIRS.test(` ${command}`));
      return {
        message: `stopped: command time limit ${durationLabel(caps.commandTimeoutMs)}${silent ? ` (${MACOS_PRIVACY_HINT})` : ""}${stderrPart}`,
        details: { steps: ["command"], stopped_by: "command_timeout" },
      };
    }
    if (run.code === 0) return undefined;
    if (run.code === null) {
      return { message: `command stopped by signal ${run.signal ?? "unknown"}${stderrPart}`, details: { steps: ["command"] } };
    }
    const hint = run.code === 127 ? " (command not found under the daemon's PATH; use an absolute path)" : "";
    return { message: `command exited with code ${run.code}${hint}${stderrPart}`, details: { steps: ["command"] } };
  }

  /** The tool-less summarize step (R12): the user's prompt plus the scrubbed output. */
  private async summarize(
    adapter: ProviderAdapter,
    model: string,
    prompt: string,
    output: string,
    caps: JobCaps,
    step: NonNullable<DispatchOptions["summarize"]>,
    truncated: { truncated?: boolean },
    scrub: (text: string) => string,
  ): Promise<DispatchResult> {
    const steps = ["command", "prompt"];
    const input = summarizeInput(prompt, output, caps.summarizeInputCapBytes);
    let result: DispatchResult;
    try {
      result = await retryWithBackoff(() =>
        adapter.dispatch(step.model ?? model, input, {
          tools: [],
          timeoutMs: caps.llmTimeoutMs,
          maxBudgetUsd: caps.maxBudgetUsd,
        }),
      );
    } catch (err) {
      if (err instanceof ProviderDeferError) throw err;
      const own = (err as { details?: RunDetails } | null)?.details;
      const message = errText(err);
      // The adapter names the cap that stopped it; the message text is not read.
      const stoppedBy = own?.stopped_by;
      throw new NonRetryableError(scrub(`summarize: ${message}`), {
        steps,
        ...(stoppedBy ? { stopped_by: stoppedBy } : {}),
        ...truncated,
      });
    }
    return { ...result, text: scrub(result.text), tools: [], details: { steps, ...truncated } };
  }
}
