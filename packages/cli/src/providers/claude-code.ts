/**
 * Claude Code provider adapter.
 *
 * Runs the local `claude` CLI headless (`claude -p`) under the user's Claude
 * Code subscription login, so a task needs no API key. It lives in the CLI
 * host, not in `@tidegap/core`: core stays free of process spawning (see
 * `notify.ts`), and `tidegap tick` is the only host that runs it.
 *
 * Isolation: the prompt goes on stdin (never argv), the built-in tools are
 * cut to a read-only set (`--tools` and `--allowedTools` name the same
 * allowlisted tools, default WebSearch and WebFetch; `--permission-mode
 * dontAsk` denies the rest), the user's CLAUDE.md, skills, plugins, hooks and
 * MCP servers are off (`--safe-mode`, `--strict-mcp-config`), and the run
 * happens in a fresh temp directory that is removed afterwards. The child
 * leads its own process group, so the timeout stops anything it started.
 *
 * Origin session (KTD6-KTD11): a task queued from a Claude Code session
 * runs in a copy of it (`--resume <id> --fork-session`) in the session's
 * project directory, with read-only file tools pre-approved there only. A
 * task with web tools, a session that is gone or too large, or
 * `TIDEGAP_RESUME=off` runs fresh, with a short header built from the task.
 * The fork persists, so `claude --resume <fork id>` opens it; the origin
 * session's transcript is never written.
 *
 * Batch: UNSUPPORTED. There is no batch path, so `dispatchBatch` is omitted
 * and the scheduler keeps these tasks on the sync path. `maxTokens` and
 * `temperature` are ignored: the CLI has no flags for them.
 *
 * Failures throw a plain `Error` (no `status` / `code`), so the scheduler
 * fails the task once and never retries: Claude Code retries API errors
 * itself. A subscription usage-limit result is the exception (KTD13): it
 * throws `ProviderDeferError`, and the scheduler puts the task back in the
 * queue until the limit resets. A timeout throws a `NonRetryableError`
 * whose details name the cap (`stopped_by: "llm_timeout"`).
 */

import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeCodeToolsError,
  DEFAULT_CLAUDE_CODE_TOOLS,
  freshReasonText,
  includesFileTool,
  includesWebTool,
  MAX_TIMER_MS,
  NonRetryableError,
  ProviderDeferError,
  ProviderRefusalError,
  tokensLabel,
  type DispatchOptions,
  type DispatchResult,
  type FreshReason,
  type ProviderAdapter,
  type RunSession,
} from "@tidegap/core";
import { nodeSessionFs, type SessionFs } from "../session/estimate.js";
import { effectiveTools, originDirCheck, planRun, resumeSettings, type ResumeSettings, type RunOrigin } from "../session/plan.js";

export interface ClaudeCodeAdapterOptions {
  /** Absolute path of the `claude` binary. Unset means not ready. */
  binaryPath?: string;
  /** Environment for the child process. Unset inherits this process's. */
  env?: Record<string, string | undefined>;
  /** `--max-budget-usd` cap (Claude Code's list-price estimate). Default 1. */
  maxBudgetUsd?: number;
  /** Run timeout. Default 10 minutes. */
  timeoutMs?: number;
  /** Parent of the per-run scratch directory. Default: the OS temp dir. */
  scratchRoot?: string;
  /** Tools for a task that names none (`[]` = none). Default: WebSearch, WebFetch. */
  defaultTools?: readonly string[];
  /**
   * The host's limit reset for a task model (KTD5/KTD13), read when a run
   * hits the usage limit. Undefined, or a resolver that returns undefined,
   * leaves the time to the result text.
   */
  resetTarget?: (model: string) => Promise<LimitReset | undefined>;
  /** `TIDEGAP_RESUME` and the context cap. Default: on, 150k tokens. */
  resume?: ResumeSettings;
  /** `--max-budget-usd` of a run that resumes a session (KTD10). Default 3. */
  resumeMaxBudgetUsd?: number;
  /** File access of the fork-or-fresh check (tests). */
  sessionFs?: SessionFs;
}

/** The limit reset the host resolved: when, and whether a window is spent. */
export interface LimitReset {
  at: Date;
  exhausted: boolean;
}

/** A limit result with no usable time waits this long. */
const LIMIT_FALLBACK_MS = 60 * 60 * 1000;
/** A deferral never retries sooner than this. */
const LIMIT_FLOOR_MS = 5 * 60 * 1000;
const LIMIT_TEXT = /usage limit|limit reached|hit your limit/i;

/** Default `--max-budget-usd` cap. */
export const DEFAULT_MAX_BUDGET_USD = 1;
/** Default `--max-budget-usd` cap of a resumed run: the whole context is re-read with a cold cache. */
export const DEFAULT_RESUME_MAX_BUDGET_USD = 3;
/** Claude Code's answer when `--resume` names a session it cannot find. */
const NO_CONVERSATION = /No conversation found with session ID/i;
/** Characters with a meaning in a permission-rule path (gitignore syntax). */
const RULE_SPECIAL = /[*?[\]\\!#()\s,]/;
/** Claude Code's stdin cap. */
const MAX_STDIN_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const KILL_GRACE_MS = 5_000;
const STDERR_TAIL = 500;
/** stderr lines a timeout error quotes, and their character cap. */
const TIMEOUT_STDERR_LINES = 20;
const TIMEOUT_STDERR_CHARS = 2000;
/**
 * A launchd job that opens a path under ~/Documents (claude follows
 * ~/.claude/skills symlinks there) waits on the privacy prompt until it is
 * answered; the run prints nothing and times out.
 */
const MACOS_PRIVACY_HINT = "macOS: check for a pending Files & Folders prompt for the daemon's node";
/** stderr kept in memory while the child runs; only the tail is reported. */
const STDERR_KEEP = 64 * 1024;
const INSTALL_HINT = "install Claude Code or set TIDEGAP_CLAUDE_BIN";
const LOGIN_HINT = "run `claude` once as this user and complete /login";

/** Model ids and aliases Claude Code accepts for `--model`. */
const PASS_THROUGH_MODEL = /^(claude-[a-z0-9.-]+|opus|sonnet|haiku|fable|opusplan)(\[1m\])?$/i;

/** The fields of `claude -p --output-format json` this adapter reads. */
interface ClaudeResult {
  is_error?: boolean;
  subtype?: string;
  result?: string | null;
  stop_reason?: string | null;
  terminal_reason?: string;
  api_error_status?: number | null;
  usage?: {
    input_tokens?: number;
    cache_creation_input_tokens?: number;
    output_tokens?: number;
  };
  modelUsage?: Record<
    string,
    { inputTokens?: number; cacheCreationInputTokens?: number; outputTokens?: number } | undefined
  >;
  session_id?: string;
}

interface RunOutcome {
  cwd: string;
  /** `cwd` is the per-run scratch directory, already removed when the outcome is read. */
  scratch: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** The time limit this run had. */
  timeoutMs: number;
}

/** Per-call limits: the job caps when given (KTD8), else the adapter's own. */
interface CallLimits {
  timeoutMs: number;
  budgetUsd: number;
}

/** Prior turns as a labeled transcript before the prompt: `claude -p` takes one user turn. */
function stdinText(prompt: string, options: DispatchOptions): string {
  const prior = options.messages ?? [];
  if (prior.length === 0) return prompt;
  const turns = prior.map((m) => `[${m.role}]\n${m.content}`).join("\n\n");
  return `Earlier turns of this conversation, oldest first:\n\n${turns}\n\nCurrent message:\n\n${prompt}`;
}

/**
 * KTD11: what a fresh run of a task from a session is told first. Built
 * only from the task; nothing from the session itself.
 */
function freshHeader(cwd: string, reason: FreshReason, contextTokens: number | undefined): string {
  const why =
    reason === "too-large" && contextTokens !== undefined
      ? `${freshReasonText(reason)} (${tokensLabel(contextTokens)})`
      : freshReasonText(reason);
  return (
    `This task was queued from a Claude Code session in ${cwd}. ` +
    `It runs in a fresh session without that conversation (reason: ${why}), ` +
    `so work from the task text alone.\n\nTask:\n\n`
  );
}

/**
 * `--allowedTools` entries of a run with an origin (KTD7): web tools by
 * name, file tools as one Read rule for `cwd` only (Claude Code applies Read
 * rules to Grep and Glob too). A directory whose path has rule syntax in it
 * gets no rule; dontAsk still lets reads inside the working directory run.
 */
function scopedAllowedTools(tools: readonly string[], cwd: string): string[] {
  const out = tools.filter((t) => !includesFileTool([t]));
  if (includesFileTool(tools) && !RULE_SPECIAL.test(cwd)) out.push(`Read(/${cwd.replace(/\/+$/, "")}/**)`);
  return out;
}

/**
 * `--allowedTools` entries of a run without a directory to scope to: the web
 * tools by name. File tools are never pre-approved by bare name, which would
 * allow reads anywhere; dontAsk still lets them read the working directory.
 */
function plainAllowedTools(tools: readonly string[]): string[] {
  const web = tools.filter((t) => !includesFileTool([t]));
  return web.length > 0 ? [web.join(",")] : [];
}

interface ReportedRun {
  model: string;
  inputTokens?: number;
  outputTokens?: number;
}

/** Input tokens the way the receipt counts them: fresh input plus cache writes (cache reads excluded). */
function sumInput(input: number | undefined, cacheCreation: number | undefined): number | undefined {
  return input !== undefined || cacheCreation !== undefined ? (input ?? 0) + (cacheCreation ?? 0) : undefined;
}

/**
 * The model and the tokens the receipt bills, from one source (K4): the
 * `modelUsage` entry with the most output tokens, with that entry's own
 * tokens. Without `modelUsage`, the top-level `usage` and the requested model.
 */
function reportedRun(parsed: ClaudeResult, requested: string): ReportedRun {
  let best: ReportedRun | undefined;
  let bestOut = -1;
  for (const [model, u] of Object.entries(parsed.modelUsage ?? {})) {
    const out = u?.outputTokens ?? 0;
    if (out > bestOut) {
      best = { model, inputTokens: sumInput(u?.inputTokens, u?.cacheCreationInputTokens), outputTokens: u?.outputTokens };
      bestOut = out;
    }
  }
  if (best) return best;
  const u = parsed.usage ?? {};
  return {
    model: requested && requested !== "default" ? requested : "claude-code",
    inputTokens: sumInput(u.input_tokens, u.cache_creation_input_tokens),
    outputTokens: u.output_tokens,
  };
}

/** The UTC offset (ms) of `zone` at instant `t`. Throws on an unknown zone. */
function zoneOffset(t: number, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(t));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - t;
}

/**
 * The reset time a limit result's text names (KTD13 step 2): an epoch after
 * `|` (older Claude Code), or `reset(s) (at) 7pm (Europe/Kyiv)` as the next
 * such wall-clock instant in that zone (this machine's zone when the text
 * names none, as in `5-hour limit reached ∙ resets 7pm`). Undefined when the
 * text names no time.
 */
export function resetFromText(text: string, now: Date = new Date()): Date | undefined {
  const epoch = /\|(\d{9,11})\b/.exec(text);
  if (epoch) return new Date(Number(epoch[1]) * 1000);
  const m = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b(?:\s*\(([^)\s]+)\))?/i.exec(text);
  if (!m) return undefined;
  const hour12 = Number(m[1]);
  const minute = Number(m[2] ?? 0);
  if (hour12 < 1 || hour12 > 12 || minute > 59) return undefined;
  const hour = (hour12 % 12) + (m[3]!.toLowerCase() === "pm" ? 12 : 0);
  const zone = m[4] ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    const local = new Date(now.getTime() + zoneOffset(now.getTime(), zone));
    for (let day = 0; day <= 1; day++) {
      const wall = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + day, hour, minute);
      let t = wall - zoneOffset(wall, zone);
      t = wall - zoneOffset(t, zone);
      if (t > now.getTime()) return new Date(t);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function isLimitResult(parsed: ClaudeResult): boolean {
  return parsed.api_error_status === 429 || LIMIT_TEXT.test(parsed.result ?? "");
}

function failureMessage(parsed: ClaudeResult): string {
  const text =
    parsed.result ||
    [parsed.subtype, parsed.terminal_reason].filter(Boolean).join(", ") ||
    "unknown error";
  if (/not logged in|\/login/i.test(text)) return `claude-code: ${text}; ${LOGIN_HINT}`;
  const status = parsed.api_error_status ? ` (API status ${parsed.api_error_status})` : "";
  return `claude-code: ${text}${status}`;
}

/** Fresh-run reasons that get the KTD11 header. */
const HEADER_REASONS: ReadonlySet<FreshReason> = new Set([
  "web-tools",
  "cwd-missing",
  "cwd-unsafe",
  "session-missing",
  "too-large",
]);

/**
 * True when a fork failed because Claude Code has no session with that id.
 * Only a failed run counts: an answer that quotes the message is a result.
 */
function forkSessionMissing(run: RunOutcome): boolean {
  if (run.timedOut) return false;
  if (NO_CONVERSATION.test(run.stderr)) return true;
  let value: { is_error?: unknown; result?: unknown } | undefined;
  try {
    value = JSON.parse(run.stdout) as { is_error?: unknown; result?: unknown };
  } catch {
    return false;
  }
  const failed = run.code !== 0 || value?.is_error === true;
  return failed && typeof value?.result === "string" && NO_CONVERSATION.test(value.result);
}

/** `~` or `~/...` with the home folder in front; other paths as given. */
export function expandHome(path: string, home: string = homedir()): string {
  if (path === "~") return home;
  return path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

/** True when `path` is an existing directory. */
export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export class ClaudeCodeAdapter implements ProviderAdapter {
  readonly provider = "claude-code";
  private readonly binaryPath: string | undefined;
  private readonly env: Record<string, string | undefined> | undefined;
  private readonly maxBudgetUsd: number;
  private readonly timeoutMs: number;
  private readonly scratchRoot: string;
  private readonly defaultTools: readonly string[];
  private readonly resetTarget: ClaudeCodeAdapterOptions["resetTarget"];
  private readonly resume: ResumeSettings;
  private readonly resumeMaxBudgetUsd: number;
  private readonly sessionFs: SessionFs;

  constructor(opts: ClaudeCodeAdapterOptions = {}) {
    this.resetTarget = opts.resetTarget;
    this.binaryPath = opts.binaryPath;
    this.env = opts.env;
    this.maxBudgetUsd = opts.maxBudgetUsd ?? DEFAULT_MAX_BUDGET_USD;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.scratchRoot = opts.scratchRoot ?? tmpdir();
    this.defaultTools = opts.defaultTools ?? DEFAULT_CLAUDE_CODE_TOOLS;
    this.resume = opts.resume ?? resumeSettings({});
    this.resumeMaxBudgetUsd = opts.resumeMaxBudgetUsd ?? DEFAULT_RESUME_MAX_BUDGET_USD;
    this.sessionFs = opts.sessionFs ?? nodeSessionFs;
  }

  get ready(): boolean {
    return this.binaryPath !== undefined;
  }

  async dispatch(
    model: string,
    prompt: string,
    options: DispatchOptions = {},
  ): Promise<DispatchResult> {
    const binary = this.binaryPath;
    if (!binary) throw new Error(`claude-code: no claude binary found; ${INSTALL_HINT}`);
    const origin: RunOrigin | undefined = options.origin;
    // Checked again here, not only at enqueue: a hand-edited ledger row
    // must never hand `claude` a tool that runs commands or writes files.
    // Validated before the copy: a string or other non-array must be refused
    // as is, not spread into characters first.
    const requested: unknown = options.tools ?? effectiveTools(undefined, origin, this.defaultTools);
    const toolsError = claudeCodeToolsError(requested);
    if (toolsError) throw new Error(`claude-code: ${toolsError}`);
    const tools = [...(requested as readonly string[])];
    const input = stdinText(prompt, options);
    if (Buffer.byteLength(input) > MAX_STDIN_BYTES) {
      throw new Error("claude-code: prompt is larger than Claude Code's 10 MB stdin limit");
    }
    const limits: CallLimits = {
      timeoutMs: options.timeoutMs ?? this.timeoutMs,
      budgetUsd: options.maxBudgetUsd ?? this.maxBudgetUsd,
    };
    if (!origin && options.cwd !== undefined) {
      // A job occurrence (KTD8): a fresh run in the job's directory, never a fork.
      const run = await this.runInDir(binary, model, tools, input, options.system, options.cwd, limits);
      return { ...(await this.toResult(run, model)), tools };
    }
    if (!origin) {
      const run = await this.runFresh(binary, model, tools, input, options.system, limits);
      return { ...(await this.toResult(run, model)), tools };
    }

    const plan = planRun({ provider: "claude-code", origin, tools, settings: this.resume, fs: this.sessionFs });
    if (plan.mode === "fork" && origin.sessionId && origin.cwd) {
      const run = await this.runFork(binary, model, tools, input, options.system, origin.sessionId, origin.cwd, limits.timeoutMs);
      if (!forkSessionMissing(run)) {
        const result = await this.toResult(run, model);
        const forkId = (result.raw as ClaudeResult).session_id;
        if (forkId === origin.sessionId) {
          throw new Error(
            `claude-code: the fork of session ${origin.sessionId} reported the same session id ${forkId}; ` +
              `the origin session may have been written, so the result is not used`,
          );
        }
        const session: RunSession = {
          mode: "fork",
          ...(forkId ? { sessionId: forkId } : {}),
          originSessionId: origin.sessionId,
          ...(plan.contextTokens !== undefined ? { contextTokens: plan.contextTokens } : {}),
        };
        return { ...result, tools, session };
      }
      return this.freshFromOrigin(binary, model, tools, input, options.system, origin, "session-missing", plan.contextTokens, limits);
    }
    return this.freshFromOrigin(binary, model, tools, input, options.system, origin, plan.reason ?? "no-origin", plan.contextTokens, limits);
  }

  /** The argv every run shares; `persist` drops `--no-session-persistence`. */
  private baseArgs(model: string, tools: string[], allowed: string[], budget: number, persist: boolean): string[] {
    const args = [
      "-p",
      "--output-format", "json",
      // `--tools` limits the built-in set; `--allowedTools` pre-approves
      // them so dontAsk runs them. "" means no tools.
      "--tools", tools.join(","),
      ...(allowed.length > 0 ? ["--allowedTools", ...allowed] : []),
      "--permission-mode", "dontAsk",
      "--max-budget-usd", String(budget),
      "--safe-mode",
      "--strict-mcp-config",
      ...(persist ? [] : ["--no-session-persistence"]),
    ];
    if (PASS_THROUGH_MODEL.test(model)) args.push("--model", model);
    return args;
  }

  /**
   * Run in `cwd`, or in a fresh scratch directory when `cwd` is undefined.
   * The scratch directory also holds the system prompt file; it is removed
   * after the run.
   */
  private async runIn(
    binary: string,
    args: string[],
    cwd: string | undefined,
    input: string,
    system: string | undefined,
    timeoutMs: number,
  ): Promise<RunOutcome> {
    const needsScratch = cwd === undefined || system !== undefined;
    const dir = needsScratch ? await mkdtemp(join(this.scratchRoot, "tidegap-claude-")) : undefined;
    try {
      if (system) {
        const file = join(dir!, "system-prompt.txt");
        await writeFile(file, system, "utf8");
        args.push("--system-prompt-file", file);
      }
      return { ...(await this.run(binary, args, cwd ?? dir!, input, timeoutMs)), scratch: cwd === undefined };
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  }

  /** A task without an origin: today's isolated run in a scratch directory. */
  private runFresh(binary: string, model: string, tools: string[], input: string, system: string | undefined, limits: CallLimits) {
    const args = this.baseArgs(model, tools, plainAllowedTools(tools), limits.budgetUsd, false);
    return this.runIn(binary, args, undefined, input, system, limits.timeoutMs);
  }

  /**
   * A job occurrence's run (KTD8): fresh, in `cwd` (`~` is the home folder),
   * file tools scoped to it. A missing directory fails with its path.
   */
  private async runInDir(
    binary: string,
    model: string,
    tools: string[],
    input: string,
    system: string | undefined,
    cwd: string,
    limits: CallLimits,
  ) {
    const dir = expandHome(cwd);
    if (!isDirectory(dir)) throw new Error(`claude-code: working directory ${dir} does not exist`);
    const args = this.baseArgs(model, tools, scopedAllowedTools(tools, dir), limits.budgetUsd, false);
    return this.runIn(binary, args, dir, input, system, limits.timeoutMs);
  }

  /** KTD6: a persisted fork of the origin session, in its project directory. */
  private runFork(
    binary: string,
    model: string,
    tools: string[],
    input: string,
    system: string | undefined,
    sessionId: string,
    cwd: string,
    timeoutMs: number,
  ) {
    const args = [
      ...this.baseArgs(model, tools, scopedAllowedTools(tools, cwd), this.resumeMaxBudgetUsd, true),
      "--resume", sessionId,
      "--fork-session",
    ];
    return this.runIn(binary, args, cwd, input, system, timeoutMs);
  }

  /**
   * KTD11: a fresh run of a task from a session. The header comes first for
   * the reasons that leave the task without its session; file tools keep
   * the session's directory when it still exists.
   */
  private async freshFromOrigin(
    binary: string,
    model: string,
    tools: string[],
    input: string,
    system: string | undefined,
    origin: RunOrigin,
    reason: FreshReason,
    contextTokens: number | undefined,
    limits: CallLimits,
  ): Promise<DispatchResult> {
    const inOrigin =
      includesFileTool(tools) &&
      !includesWebTool(tools) &&
      originDirCheck(origin.cwd, this.sessionFs, this.resume.home) === "ok";
    const cwd = inOrigin ? origin.cwd : undefined;
    const allowed = cwd ? scopedAllowedTools(tools, cwd) : plainAllowedTools(tools);
    const headed = HEADER_REASONS.has(reason) && origin.cwd ? freshHeader(origin.cwd, reason, contextTokens) + input : input;
    const args = this.baseArgs(model, tools, allowed, limits.budgetUsd, false);
    const run = await this.runIn(binary, args, cwd, headed, system, limits.timeoutMs);
    const result = await this.toResult(run, model);
    const ranId = (result.raw as ClaudeResult).session_id;
    const session: RunSession = {
      mode: "fresh",
      reason,
      ...(ranId ? { sessionId: ranId } : {}),
      ...(origin.sessionId ? { originSessionId: origin.sessionId } : {}),
      ...(contextTokens !== undefined ? { contextTokens } : {}),
    };
    return { ...result, tools, session };
  }

  private run(binary: string, args: string[], cwd: string, input: string, timeoutMs: number): Promise<Omit<RunOutcome, "scratch">> {
    return new Promise((resolve, reject) => {
      const child = spawn(binary, args, {
        cwd,
        ...(this.env ? { env: this.env } : {}),
        stdio: ["pipe", "pipe", "pipe"],
        // Own process group: the timeout signals the group, not just `claude`.
        detached: true,
      });
      const killGroup = (signal: NodeJS.Signals) => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, signal);
        } catch {
          child.kill(signal);
        }
      };
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let killTimer: NodeJS.Timeout | undefined;
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup("SIGTERM");
        killTimer = setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS);
      }, Math.min(timeoutMs, MAX_TIMER_MS));
      const stop = () => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
      };
      child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
      child.stderr.setEncoding("utf8").on("data", (d: string) => {
        stderr = (stderr + d).slice(-STDERR_KEEP);
      });
      child.on("error", (err: NodeJS.ErrnoException) => {
        stop();
        reject(new Error(`claude-code: cannot run ${binary} (${err.code ?? err.message}); ${INSTALL_HINT}`));
      });
      child.on("close", (code) => {
        stop();
        resolve({ cwd, code, stdout, stderr, timedOut, timeoutMs });
      });
      // A binary that exits before reading stdin closes the pipe (EPIPE);
      // the exit status reports what went wrong.
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    });
  }

  /**
   * KTD13: when to retry a run that hit the usage limit. First hit wins: the
   * host's reset when a window is spent, the time the result text names, the
   * host's reset when nothing is spent, now + 60 min. Never sooner than
   * now + 5 min.
   */
  private async limitRetryAt(text: string, model: string): Promise<Date> {
    const now = Date.now();
    let reset: LimitReset | undefined;
    try {
      reset = await this.resetTarget?.(model);
    } catch {
      reset = undefined;
    }
    // A reset that has already passed says nothing about this limit result.
    if (reset && reset.at.getTime() <= Date.now()) reset = undefined;
    const at =
      (reset?.exhausted ? reset.at : undefined) ??
      resetFromText(text, new Date(now)) ??
      reset?.at ??
      new Date(now + LIMIT_FALLBACK_MS);
    return new Date(Math.max(at.getTime(), now + LIMIT_FLOOR_MS));
  }

  /**
   * The timeout error. The first line is what notifications show (cut to
   * 140 characters), so the macOS hint, for a run that printed nothing,
   * comes before the cwd; the stderr tail follows on its own lines.
   */
  private timeoutMessage(run: RunOutcome): string {
    const tail = run.stderr.trimEnd().split("\n").slice(-TIMEOUT_STDERR_LINES).join("\n").slice(-TIMEOUT_STDERR_CHARS);
    const silent = !tail.trim();
    const hint = silent && process.platform === "darwin" ? ` (${MACOS_PRIVACY_HINT})` : "";
    const cwd = run.scratch ? `${run.cwd} (scratch, removed)` : run.cwd;
    return (
      `claude-code: timed out after ${run.timeoutMs / 1000}s${hint}; cwd ${cwd}; ` +
      (silent ? "no stderr" : `stderr tail:\n${tail}`)
    );
  }

  private async toResult(run: RunOutcome, requested: string): Promise<DispatchResult> {
    if (run.timedOut) throw new NonRetryableError(this.timeoutMessage(run), { stopped_by: "llm_timeout" });
    let parsed: ClaudeResult | undefined;
    try {
      const value: unknown = JSON.parse(run.stdout);
      if (value && typeof value === "object" && !Array.isArray(value)) parsed = value as ClaudeResult;
    } catch {
      // handled below
    }
    if (!parsed) {
      const tail = run.stderr.trim().slice(-STDERR_TAIL);
      throw new Error(
        `claude-code: exit ${run.code ?? "unknown"} without a JSON result` + (tail ? `: ${tail}` : ""),
      );
    }
    if (parsed.is_error === true || parsed.subtype?.startsWith("error")) {
      const message = failureMessage(parsed);
      if (isLimitResult(parsed)) {
        const retryAt = await this.limitRetryAt(parsed.result ?? "", requested);
        throw new ProviderDeferError(`${message}; deferred until ${retryAt.toISOString()}`, retryAt);
      }
      throw new Error(message);
    }
    const { model, inputTokens, outputTokens } = reportedRun(parsed, requested);
    if (parsed.stop_reason === "refusal") {
      throw new ProviderRefusalError(this.provider, model, null);
    }
    return {
      text: parsed.result ?? "",
      usage: {
        inputTokens,
        outputTokens,
        totalTokens:
          inputTokens !== undefined && outputTokens !== undefined
            ? inputTokens + outputTokens
            : undefined,
      },
      model,
      provider: this.provider,
      raw: parsed,
      ...(parsed.stop_reason ? { stopReason: parsed.stop_reason } : {}),
    };
  }

  // No dispatchBatch / retrieveBatch: Claude Code has no batch path.
}
