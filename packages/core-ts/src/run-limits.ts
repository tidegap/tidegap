/**
 * The run-limits registry: the one place that names each run limit and
 * retry setting, its `~/.tidegap/config` keys, its per-runner defaults, the
 * value grammar, the settings read and the precedence resolver; plus the
 * failure classifier and the retry planner. Every surface parses and prints
 * a run limit through this module and keeps no default of its own.
 *
 * Precedence for each setting, first match wins: the task's or job's own
 * value (`task`), the per-runner setting `<KEY>_<RUNNER>`
 * (`setting:<runner>`), the all-runners setting `<KEY>` (`setting`), the
 * built-in default for the runner (`default`).
 *
 * `none` switches a time limit off; `0` is refused, so one character never
 * means both "nothing" and "no limit". For retries `0` means no automatic
 * retry, and a retry delay takes neither.
 *
 * Core stays environment-pure: the settings come from the config file only,
 * read fresh by the host at each tick, request or tool call. The Python twin
 * is packages/core-py/src/tidegap/run_limits.py; both pass
 * test/fixtures/run-limits-vectors.json.
 */
import { readFileSync } from "node:fs";

import { carbonBudgetConfigPath, parseKeyValues } from "./budget.js";
import type { ProviderName } from "./types.js";

/** A time limit in milliseconds, or `none` for no limit. */
export type DurationValue = number | "none";

export type RunLimitName = "command_timeout" | "llm_timeout" | "retries" | "retry_delay";

/** Where an effective limit came from. */
export type RunLimitSource = "task" | `setting:${ProviderName}` | "setting" | "default";

export interface RunLimitDefinition {
  name: RunLimitName;
  /**
   * `time_limit`: a duration in ms or `none`; `delay`: a duration in ms,
   * `none` refused; `count`: a whole number from 0 to 10.
   */
  kind: "time_limit" | "delay" | "count";
  /** The all-runners key in `~/.tidegap/config`. */
  key: string;
  /** The CLI flag and setting name. */
  cliName: string;
  /** The key of the row's or job's caps that holds a per-task value. */
  capsKey: "commandTimeoutMs" | "llmTimeoutMs" | "retries" | "retryDelayMs";
  /** Built-in default per runner, in ms (a count for `count`). The runners listed are the ones the setting applies to. */
  defaults: Readonly<Partial<Record<ProviderName, number>>>;
  /** Whether `<KEY>_<RUNNER>` keys are read. */
  perRunner: boolean;
  /**
   * The default every writer stored before caps carried `capsVersion`: on
   * caps without the marker, a stored value equal to it counts as unset.
   * Only the time limits had one.
   */
  legacyDefaultMs?: number;
}

/** The caps marker of writers that store only the values a caller set. */
export const CAPS_VERSION = 2;

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const MIN_DURATION_MS = SECOND_MS;
const MAX_DURATION_MS = 7 * DAY_MS;
/** The most automatic retries a setting or a task can ask for. */
export const MAX_RETRIES = 10;

/** Every runner: retries and the retry delay apply to all of them. */
function everyRunner(value: number): Readonly<Partial<Record<ProviderName, number>>> {
  return Object.freeze({ command: value, "claude-code": value, anthropic: value, openai: value, gemini: value, ollama: value });
}

export const RUN_LIMITS: readonly Readonly<RunLimitDefinition>[] = Object.freeze([
  Object.freeze({
    name: "command_timeout",
    kind: "time_limit",
    key: "TIDEGAP_COMMAND_TIMEOUT",
    cliName: "command-timeout",
    capsKey: "commandTimeoutMs",
    defaults: Object.freeze({ command: 30 * MINUTE_MS }),
    perRunner: false,
    legacyDefaultMs: 5 * MINUTE_MS,
  }),
  Object.freeze({
    name: "llm_timeout",
    kind: "time_limit",
    key: "TIDEGAP_LLM_TIMEOUT",
    cliName: "llm-timeout",
    capsKey: "llmTimeoutMs",
    defaults: Object.freeze({
      "claude-code": 30 * MINUTE_MS,
      anthropic: 10 * MINUTE_MS,
      openai: 10 * MINUTE_MS,
      gemini: 10 * MINUTE_MS,
      ollama: 10 * MINUTE_MS,
    }),
    perRunner: true,
    legacyDefaultMs: 10 * MINUTE_MS,
  }),
  Object.freeze({
    name: "retries",
    kind: "count",
    key: "TIDEGAP_RETRIES",
    cliName: "retries",
    capsKey: "retries",
    defaults: everyRunner(1),
    perRunner: true,
  }),
  Object.freeze({
    name: "retry_delay",
    kind: "delay",
    key: "TIDEGAP_RETRY_DELAY",
    cliName: "retry-delay",
    capsKey: "retryDelayMs",
    defaults: everyRunner(30 * MINUTE_MS),
    perRunner: true,
  }),
]);

/** The registry entry of `name`. */
export function runLimitDefinition(name: RunLimitName): Readonly<RunLimitDefinition> {
  return RUN_LIMITS.find((d) => d.name === name)!;
}

/** A value the duration grammar refuses; the message is a fixed sentence. */
export class DurationError extends Error {
  override name = "DurationError";
}

export const DURATION_FORM_ERROR =
  "Use a duration from 1s to 7d, such as 90s, 30m, 1.5h or 2d, or none for no time limit.";
export const DURATION_ZERO_ERROR = "0 is not a time limit; use none for no time limit.";
export const DURATION_RANGE_ERROR = "A time limit must be from 1s to 7d; use none for no time limit.";

const UNIT_MS: Readonly<Record<string, number>> = { s: SECOND_MS, m: MINUTE_MS, min: MINUTE_MS, h: HOUR_MS, d: DAY_MS };

/**
 * Parse a time limit: a number with an optional unit `s`, `m` (or `min`),
 * `h` or `d`, case-insensitive, a bare number being seconds; from 1 second
 * to 7 days; or `none`. Returns milliseconds or `"none"`; throws a
 * {@link DurationError} with a fixed sentence that names `none`.
 */
export function parseDuration(input: string): DurationValue {
  const text = input.trim().toLowerCase();
  if (text === "none") return "none";
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|min|h|d)?$/.exec(text);
  if (!m) throw new DurationError(DURATION_FORM_ERROR);
  const n = Number(m[1]);
  if (n === 0) throw new DurationError(DURATION_ZERO_ERROR);
  const ms = Math.round(n * UNIT_MS[m[2] ?? "s"]!);
  if (ms < MIN_DURATION_MS || ms > MAX_DURATION_MS) throw new DurationError(DURATION_RANGE_ERROR);
  return ms;
}

/** The canonical form of a time limit: the largest whole unit, else seconds; `none` as is. */
export function formatDuration(value: DurationValue): string {
  if (value === "none") return "none";
  if (value % DAY_MS === 0) return `${value / DAY_MS}d`;
  if (value % HOUR_MS === 0) return `${value / HOUR_MS}h`;
  if (value % MINUTE_MS === 0) return `${value / MINUTE_MS}m`;
  return `${value / SECOND_MS}s`;
}

export const RETRIES_ERROR = "Retries must be a whole number from 0 to 10; 0 turns automatic retries off.";
export const RETRY_DELAY_ERROR =
  "A retry delay must be a duration from 1s to 7d, such as 90s, 30m or 2h; 0 and none are refused.";

/** Parse a retry count: a whole number from 0 to 10. Throws a {@link DurationError} with {@link RETRIES_ERROR}. */
export function parseRetries(input: string): number {
  const text = input.trim();
  if (!/^[0-9]+$/.test(text)) throw new DurationError(RETRIES_ERROR);
  const n = Number(text);
  if (n > MAX_RETRIES) throw new DurationError(RETRIES_ERROR);
  return n;
}

/** Parse a retry delay: the duration grammar without `none`. Throws a {@link DurationError} with {@link RETRY_DELAY_ERROR}. */
export function parseRetryDelay(input: string): number {
  let value: DurationValue;
  try {
    value = parseDuration(input);
  } catch {
    throw new DurationError(RETRY_DELAY_ERROR);
  }
  if (value === "none") throw new DurationError(RETRY_DELAY_ERROR);
  return value;
}

/** Parse a value of setting `def` by its kind; throws a {@link DurationError} with the setting's sentence. */
export function parseRunLimitValue(def: Pick<RunLimitDefinition, "kind">, input: string): DurationValue {
  if (def.kind === "count") return parseRetries(input);
  if (def.kind === "delay") return parseRetryDelay(input);
  return parseDuration(input);
}

/** A value of setting `def` as a person reads and writes it: `30m`, `none`, `2`. */
export function formatRunLimitValue(def: Pick<RunLimitDefinition, "kind">, value: DurationValue): string {
  return def.kind === "count" ? String(value) : formatDuration(value);
}

/** The config-key suffix of a runner: `claude-code` → `CLAUDE_CODE`. */
function runnerSuffix(runner: ProviderName): string {
  return runner.toUpperCase().replace(/-/g, "_");
}

/** One `~/.tidegap/config` line the read skipped, and why. */
export interface IgnoredRunLimitLine {
  key: string;
  value: string;
  reason: string;
}

export interface RunLimitSettings {
  /** The valid values by config key, in ms or `"none"`. */
  values: Readonly<Record<string, DurationValue>>;
  /** Lines under a run-limit key that were skipped, in file order. */
  ignored: readonly IgnoredRunLimitLine[];
}

/** The reason a `<KEY>_<SUFFIX>` line is not read, or undefined when the suffix is a runner the limit takes. */
function suffixError(def: Readonly<RunLimitDefinition>, suffix: string): string | undefined {
  if (!def.perRunner) return `${def.key} takes no runner suffix.`;
  const runners = Object.keys(def.defaults) as ProviderName[];
  if (runners.some((r) => runnerSuffix(r) === suffix)) return undefined;
  const names = runners.map(runnerSuffix);
  return `${def.key} takes a runner suffix of ${names.slice(0, -1).join(", ")} or ${names.at(-1)}.`;
}

/**
 * The run-limit settings out of already-read KEY=VALUE pairs. Keys outside
 * the registry are left alone; an empty value counts as unset; any other
 * line under a run-limit key that cannot be used is listed in `ignored`.
 */
export function runLimitSettingsFromValues(pairs: Readonly<Record<string, string>>): RunLimitSettings {
  const values: Record<string, DurationValue> = {};
  const ignored: IgnoredRunLimitLine[] = [];
  for (const [key, raw] of Object.entries(pairs)) {
    const def = RUN_LIMITS.find((d) => key === d.key || key.startsWith(`${d.key}_`));
    if (!def) continue;
    const value = raw.trim();
    if (value === "") continue;
    const keyError = key === def.key ? undefined : suffixError(def, key.slice(def.key.length + 1));
    if (keyError) {
      ignored.push({ key, value, reason: keyError });
      continue;
    }
    try {
      values[key] = parseRunLimitValue(def, value);
    } catch (err) {
      ignored.push({ key, value, reason: (err as Error).message });
    }
  }
  return { values, ignored };
}

const reportedLines = new Set<string>();

export interface LoadRunLimitSettingsOptions {
  /** Override the config file path (tests). Defaults to `~/.tidegap/config`. */
  path?: string;
}

/**
 * Read the run-limit settings from `~/.tidegap/config` (or `opts.path`). A
 * missing or unreadable file gives no settings and never throws. Each
 * ignored line is reported on stderr once per process.
 */
export function loadRunLimitSettings(opts: LoadRunLimitSettingsOptions = {}): RunLimitSettings {
  let contents: string;
  try {
    contents = readFileSync(opts.path ?? carbonBudgetConfigPath(), "utf8");
  } catch {
    return { values: {}, ignored: [] };
  }
  const settings = runLimitSettingsFromValues(parseKeyValues(contents));
  for (const line of settings.ignored) {
    const id = `${line.key}=${line.value}`;
    if (reportedLines.has(id)) continue;
    reportedLines.add(id);
    console.warn(`tidegap: ~/.tidegap/config: ${line.key} ignored: ${line.reason}`);
  }
  return settings;
}

export interface ResolvedRunLimit {
  value: DurationValue;
  source: RunLimitSource;
}

export type ResolvedRunLimits = Partial<Record<RunLimitName, ResolvedRunLimit>>;

/** A stored per-task value, or undefined when it is unset or not a valid value of the setting. */
function taskValue(
  def: Readonly<RunLimitDefinition>,
  caps: Readonly<Record<string, unknown>>,
): DurationValue | undefined {
  const stored = caps[def.capsKey];
  if (def.kind === "count") return isRetryCount(stored) ? stored : undefined;
  if (stored === "none") return def.kind === "time_limit" ? "none" : undefined;
  if (typeof stored !== "number" || !Number.isFinite(stored) || stored <= 0) return undefined;
  const versioned = typeof caps.capsVersion === "number" && caps.capsVersion >= CAPS_VERSION;
  if (!versioned && stored === def.legacyDefaultMs) return undefined;
  return stored;
}

/** A whole number from 0 to {@link MAX_RETRIES}. */
function isRetryCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_RETRIES;
}

/** One limit for `runner`: the first of the task's value, the per-runner setting, the all-runners setting and `fallback`. */
function resolveRunLimit(
  def: Readonly<RunLimitDefinition>,
  caps: Readonly<Record<string, unknown>> | undefined,
  settings: RunLimitSettings,
  runner: ProviderName,
  fallback: number,
): ResolvedRunLimit {
  const own = caps ? taskValue(def, caps) : undefined;
  if (own !== undefined) return { value: own, source: "task" };
  const perRunner = def.perRunner ? settings.values[`${def.key}_${runnerSuffix(runner)}`] : undefined;
  if (perRunner !== undefined) return { value: perRunner, source: `setting:${runner}` };
  const all = settings.values[def.key];
  if (all !== undefined) return { value: all, source: "setting" };
  return { value: fallback, source: "default" };
}

/**
 * Each limit that applies to `runner`, with its value and source. `caps` is
 * the row's spec caps or the job's caps as stored; only the keys the caller
 * set count, and on caps without `capsVersion: 2` a value equal to the old
 * stored default counts as unset.
 */
export function resolveRunLimits(
  caps: Readonly<Record<string, unknown>> | undefined,
  settings: RunLimitSettings,
  runner: ProviderName,
): ResolvedRunLimits {
  const out: ResolvedRunLimits = {};
  for (const def of RUN_LIMITS) {
    const fallback = def.defaults[runner];
    if (fallback !== undefined) out[def.name] = resolveRunLimit(def, caps, settings, runner, fallback);
  }
  return out;
}

/**
 * The limits of one run: a model call's for its runner; a command's for
 * the `command` runner, plus, when it has a summarize step, that step's LLM
 * limit for the summarize provider. `spec` is the row's body or a job
 * occurrence's.
 */
export function resolveTaskRunLimits(
  spec: { provider: ProviderName; caps?: Readonly<Record<string, unknown>>; summarize?: { provider: ProviderName } },
  settings: RunLimitSettings,
): ResolvedRunLimits {
  const out = resolveRunLimits(spec.caps, settings, spec.provider);
  if (spec.provider === "command" && spec.summarize) {
    const step = resolveRunLimits(spec.caps, settings, spec.summarize.provider).llm_timeout;
    if (step) out.llm_timeout = step;
  }
  return out;
}

/** An effective time limit as a person reads it: `30m (default)`, `none (setting:claude-code)`. */
export function describeRunLimit(limit: ResolvedRunLimit): string {
  return `${formatDuration(limit.value)} (${limit.source})`;
}

/**
 * The fixed sentence a writer refuses a stored time limit with, or
 * undefined for a valid one: milliseconds from 1 second to 7 days, or
 * `"none"`.
 */
export function timeLimitError(value: unknown): string | undefined {
  if (value === "none") return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) return DURATION_FORM_ERROR;
  if (value === 0) return DURATION_ZERO_ERROR;
  if (value < MIN_DURATION_MS || value > MAX_DURATION_MS) return DURATION_RANGE_ERROR;
  return undefined;
}

/** The fixed sentence a writer refuses a stored retry delay with, or undefined: milliseconds from 1 second to 7 days. */
function retryDelayError(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < MIN_DURATION_MS || value > MAX_DURATION_MS) return RETRY_DELAY_ERROR;
  return undefined;
}

/**
 * True for a caps key that holds a run-limit setting (`commandTimeoutMs`,
 * `llmTimeoutMs`, `retries`, `retryDelayMs`): a writer drops it on `null`,
 * so the setting or the default applies at each run.
 */
export function isRunLimitCap(key: string): boolean {
  return RUN_LIMITS.some((d) => d.capsKey === key);
}

/**
 * The fixed sentence a writer refuses a stored run-limit setting with
 * (caps key `commandTimeoutMs`, `llmTimeoutMs`, `retries` or
 * `retryDelayMs`), or undefined for a valid value or another key: a time
 * limit per {@link timeLimitError}, retries a whole number from 0 to 10, a
 * retry delay from 1 second to 7 days.
 */
export function runLimitValueError(key: string, value: unknown): string | undefined {
  const def = RUN_LIMITS.find((d) => d.capsKey === key);
  if (!def) return undefined;
  if (def.kind === "count") return isRetryCount(value) ? undefined : RETRIES_ERROR;
  return def.kind === "delay" ? retryDelayError(value) : timeLimitError(value);
}

/** Why a writer refuses a cap value, or undefined: a run-limit setting per {@link runLimitValueError}, any other cap a positive number. */
export function capValueError(key: string, value: unknown): string | undefined {
  if (isRunLimitCap(key)) {
    const error = runLimitValueError(key, value);
    return error ? `cap ${key}: ${error}` : undefined;
  }
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? undefined : `cap ${key} must be a positive number`;
}

/**
 * Caps as a writer stores them from now on: on caps without `capsVersion`,
 * a time limit equal to the old stored default is dropped (it counted as
 * unset), then `capsVersion: 2` is added, so each time limit left is one a
 * caller set.
 */
export function versionedCaps<T extends object>(caps: T): T & { capsVersion: number } {
  const out: Record<string, unknown> = { ...(caps as Record<string, unknown>) };
  const versioned = typeof out.capsVersion === "number" && out.capsVersion >= CAPS_VERSION;
  if (!versioned) {
    for (const def of RUN_LIMITS) if (def.legacyDefaultMs !== undefined && out[def.capsKey] === def.legacyDefaultMs) delete out[def.capsKey];
  }
  out.capsVersion = CAPS_VERSION;
  return out as T & { capsVersion: number };
}

/** A time limit as event details and HTTP JSON carry it: seconds, or `"none"`. */
export function durationSeconds(value: DurationValue): number | "none" {
  return value === "none" ? "none" : value / SECOND_MS;
}

/** One setting in event details and HTTP JSON: a duration in seconds (`value_s`, or `"none"`), retries as a count (`value`), and its source. */
export interface RunLimitDetail {
  value_s?: number | "none";
  value?: number;
  source: RunLimitSource;
}

/** The `limits` details of a `dispatched` event: each effective setting and its source. */
export type RunLimitsDetails = Partial<Record<RunLimitName, RunLimitDetail>>;

export function runLimitsDetails(limits: ResolvedRunLimits): RunLimitsDetails {
  const out: RunLimitsDetails = {};
  for (const def of RUN_LIMITS) {
    const limit = limits[def.name];
    if (!limit) continue;
    out[def.name] =
      def.kind === "count" ? { value: limit.value as number, source: limit.source } : { value_s: durationSeconds(limit.value), source: limit.source };
  }
  return out;
}

/** A detail's value back in the registry's unit (ms, a count or `"none"`), or undefined when it is not valid. */
function detailValue(def: Readonly<RunLimitDefinition>, entry: RunLimitDetail): DurationValue | undefined {
  if (def.kind === "count") return isRetryCount(entry.value) ? entry.value : undefined;
  const s = entry.value_s;
  if (s === "none") return def.kind === "time_limit" ? "none" : undefined;
  return typeof s === "number" && Number.isFinite(s) && s > 0 ? s * SECOND_MS : undefined;
}

/** The limits a `dispatched` event's details record, or undefined when it records none (a run from before they were recorded). */
export function runLimitsFromDetails(details: unknown): ResolvedRunLimits | undefined {
  const limits = (details as { limits?: unknown } | null | undefined)?.limits;
  if (!limits || typeof limits !== "object") return undefined;
  const out: ResolvedRunLimits = {};
  for (const def of RUN_LIMITS) {
    const entry = (limits as Record<string, RunLimitDetail | undefined>)[def.name];
    if (!entry || typeof entry.source !== "string") continue;
    const value = detailValue(def, entry);
    if (value !== undefined) out[def.name] = { value, source: entry.source };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** A task's limits as a view shows them, and whether its newest run recorded them or they apply if it ran now. */
export interface TaskRunLimitsView {
  limits: RunLimitsDetails;
  from: "dispatch" | "now";
}

/**
 * The limits of a task: the ones its newest `dispatched` event recorded,
 * or, before a run recorded them, the ones a run that starts now gets.
 * `events` are the task's events, oldest first.
 */
export function taskRunLimitsView(
  bodyJson: string | undefined,
  events: readonly { kind: string; details?: unknown }[],
  settings: RunLimitSettings,
): TaskRunLimitsView {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.kind !== "dispatched") continue;
    const recorded = runLimitsFromDetails(events[i]!.details);
    if (recorded) return { limits: runLimitsDetails(recorded), from: "dispatch" };
    break;
  }
  let spec: unknown;
  try {
    spec = JSON.parse(bodyJson ?? "null");
  } catch {
    spec = undefined;
  }
  const provider = (spec as { provider?: unknown } | undefined)?.provider;
  if (typeof provider !== "string") return { limits: {}, from: "now" };
  return { limits: runLimitsDetails(resolveTaskRunLimits(spec as Parameters<typeof resolveTaskRunLimits>[0], settings)), from: "now" };
}

/** `command 30m (default), LLM 10m (setting)`: each time limit of a view, or undefined when it has none. */
export function runLimitsText(limits: RunLimitsDetails): string | undefined {
  const label: Partial<Record<RunLimitName, string>> = { command_timeout: "command", llm_timeout: "LLM" };
  const parts = RUN_LIMITS.flatMap((def) => {
    const l = limits[def.name];
    const value = l && def.kind === "time_limit" ? detailValue(def, l) : undefined;
    return value !== undefined ? [`${label[def.name]} ${formatDuration(value)} (${l!.source})`] : [];
  });
  return parts.length > 0 ? parts.join(", ") : undefined;
}

/** `1 after 30m (default)`: the retry policy of a view, or undefined when it has none. The delay's source is named when it differs. */
export function retryPolicyText(limits: RunLimitsDetails): string | undefined {
  const retries = limits.retries;
  const delay = limits.retry_delay;
  const count = retries ? detailValue(runLimitDefinition("retries"), retries) : undefined;
  const wait = delay ? detailValue(runLimitDefinition("retry_delay"), delay) : undefined;
  if (typeof count !== "number" || wait === undefined) return undefined;
  const sources = retries!.source === delay!.source ? `(${retries!.source})` : `(${retries!.source}; delay ${delay!.source})`;
  if (count === 0) return `0, no automatic retry ${sources}`;
  return `${count} after ${formatDuration(wait)}${count > 1 ? ", doubling" : ""} ${sources}`;
}

/**
 * Why a run failed, as the retry policy reads it. `timeout`, `exit`,
 * `transient` and `interrupted` may retry; `permanent` (a retry cannot fix
 * it), `after_command` (a job's LLM step failed after its command ran) and
 * `batch_submit_interrupted` (the provider may hold the batch) never do.
 */
export type FailureClass =
  | "timeout"
  | "exit"
  | "transient"
  | "interrupted"
  | "permanent"
  | "after_command"
  | "batch_submit_interrupted";

export const FAILURE_CLASSES: readonly FailureClass[] = [
  "timeout",
  "exit",
  "transient",
  "interrupted",
  "permanent",
  "after_command",
  "batch_submit_interrupted",
];

const RETRYABLE: ReadonlySet<FailureClass> = new Set(["timeout", "exit", "transient", "interrupted"]);

/** True for a class whose failure may retry. */
export function isRetryableFailure(cls: FailureClass): boolean {
  return RETRYABLE.has(cls);
}

/** A failure as both cores describe it to {@link classifyFailure}; every key is optional. */
export interface FailureFacts {
  /** The HTTP status the provider answered with. */
  status?: number;
  /** Set by an adapter or a refusal: a retry cannot fix it (a refusal, missing setup, a rejected request). */
  permanent?: boolean;
  /** The cap that stopped the run: `command_timeout`, `llm_timeout`, `budget`. */
  stopped_by?: string;
  /** The steps of the run (`command`, `prompt`); a failed run with `prompt` failed after its command ran. */
  steps?: readonly string[];
  /** The run's process exited non-zero or was killed (a command or Claude Code run). */
  exit?: boolean;
  /** A tick stopped the run (`run`: a forced stop or a dead tick), or its Batch submit (`batch_submit`). */
  interrupted?: "run" | "batch_submit";
}

/**
 * The facts of a thrown error: its HTTP status (`status` or `statusCode`),
 * the adapter's `permanent` and `exit` marks, and the `steps` and
 * `stopped_by` of its run details.
 */
export function failureFactsOf(err: unknown): FailureFacts {
  if (!err || typeof err !== "object") return {};
  const e = err as { status?: unknown; statusCode?: unknown; permanent?: unknown; exit?: unknown; details?: { steps?: unknown; stopped_by?: unknown } };
  const status = typeof e.status === "number" ? e.status : typeof e.statusCode === "number" ? e.statusCode : undefined;
  const steps = Array.isArray(e.details?.steps) ? (e.details!.steps as unknown[]).filter((s): s is string => typeof s === "string") : undefined;
  const stoppedBy = typeof e.details?.stopped_by === "string" ? e.details.stopped_by : undefined;
  return {
    ...(status !== undefined ? { status } : {}),
    ...(e.permanent === true ? { permanent: true } : {}),
    ...(e.exit === true ? { exit: true } : {}),
    ...(steps ? { steps } : {}),
    ...(stoppedBy ? { stopped_by: stoppedBy } : {}),
  };
}

/** The class of a failure; an unmarked unknown error is `transient`: one more attempt costs less than a lost task. */
export function classifyFailure(facts: FailureFacts): FailureClass {
  if (facts.interrupted === "batch_submit") return "batch_submit_interrupted";
  if (facts.steps?.includes("prompt")) return "after_command";
  if (facts.interrupted === "run") return "interrupted";
  if (facts.permanent === true || facts.stopped_by === "budget") return "permanent";
  if (facts.stopped_by === "command_timeout" || facts.stopped_by === "llm_timeout") return "timeout";
  const status = facts.status;
  if (typeof status === "number" && status >= 400 && status < 500 && status !== 429) return "permanent";
  if (facts.exit === true || facts.steps?.includes("command")) return "exit";
  return "transient";
}

/** Why a failure is final when its class allows a retry. */
export type FinalReason = "no_retries_left" | "no_time_left";

/** The sentence a final failure's error ends with, for a reason that has one. */
export const NO_TIME_LEFT_TEXT = "no time left before the deadline for a retry";

/** What {@link planRetry} decides: the next attempt's earliest start, or why there is none. */
export type RetryPlan = { retryAt: number } | { final: FinalReason };

/**
 * The next attempt after attempt `attempt` (1-based) failed at `failedAt`:
 * retry k waits `delayMs × 2^(k−1)`, a later `notBefore` wins, and the start
 * must not pass `deadline`. All times in ms since the epoch; no deadline
 * means no bound.
 */
export function planRetry(input: {
  attempt: number;
  retries: number;
  delayMs: number;
  failedAt: number;
  deadline?: number;
  notBefore?: number;
}): RetryPlan {
  if (input.attempt > input.retries) return { final: "no_retries_left" };
  const retryAt = Math.max(input.failedAt + input.delayMs * 2 ** (input.attempt - 1), input.notBefore ?? 0);
  if (input.deadline !== undefined && retryAt > input.deadline) return { final: "no_time_left" };
  return { retryAt };
}

/**
 * The number of the attempt a run of a task is: one plus the
 * `attempt_failed` events since the newest `created` event or manual retry
 * (a `rescheduled` event with reason `retry`). `events` are oldest first.
 */
export function attemptNumber(events: readonly { kind: string; details?: unknown }[]): number {
  let failed = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind === "created") break;
    if (e.kind === "rescheduled" && (e.details as { reason?: unknown } | undefined)?.reason === "retry") break;
    if (e.kind === "attempt_failed") failed++;
  }
  return failed + 1;
}

/** The error a final failure stores: the run's error, then the attempt count when more than one ran, then the no-time reason. */
export function finalFailureError(error: string, attempts: number, reason?: FinalReason): string {
  const counted = attempts > 1 ? ` (after ${attempts} attempts)` : "";
  return `${error}${counted}${reason === "no_time_left" ? ` (${NO_TIME_LEFT_TEXT})` : ""}`;
}
