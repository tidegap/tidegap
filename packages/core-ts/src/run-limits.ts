/**
 * The run-limits registry: the one place that names each run limit, its
 * `~/.tidegap/config` keys, its per-runner defaults, the duration grammar,
 * the settings read and the precedence resolver. Every surface parses and
 * prints a run limit through this module and keeps no default of its own.
 *
 * Precedence for each limit, first match wins: the task's or job's own value
 * (`task`), the per-runner setting `<KEY>_<RUNNER>` (`setting:<runner>`), the
 * all-runners setting `<KEY>` (`setting`), the built-in default for the
 * runner (`default`).
 *
 * `none` switches a time limit off; `0` is refused, so one character never
 * means both "nothing" and "no limit".
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

export type RunLimitName = "command_timeout" | "llm_timeout";

/** Where an effective limit came from. */
export type RunLimitSource = "task" | `setting:${ProviderName}` | "setting" | "default";

export interface RunLimitDefinition {
  name: RunLimitName;
  /** The all-runners key in `~/.tidegap/config`. */
  key: string;
  /** The CLI flag and setting name. */
  cliName: string;
  /** The key of the row's or job's caps that holds a per-task value. */
  capsKey: "commandTimeoutMs" | "llmTimeoutMs";
  /** Built-in default per runner, in ms. The runners listed are the ones the limit applies to. */
  defaults: Readonly<Partial<Record<ProviderName, number>>>;
  /** Whether `<KEY>_<RUNNER>` keys are read. */
  perRunner: boolean;
  /**
   * The default every writer stored before caps carried `capsVersion`: on
   * caps without the marker, a stored value equal to it counts as unset.
   */
  legacyDefaultMs: number;
}

/** The caps marker of writers that store only the values a caller set. */
export const CAPS_VERSION = 2;

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const MIN_DURATION_MS = SECOND_MS;
const MAX_DURATION_MS = 7 * DAY_MS;

export const RUN_LIMITS: readonly Readonly<RunLimitDefinition>[] = Object.freeze([
  Object.freeze({
    name: "command_timeout",
    key: "TIDEGAP_COMMAND_TIMEOUT",
    cliName: "command-timeout",
    capsKey: "commandTimeoutMs",
    defaults: Object.freeze({ command: 30 * MINUTE_MS }),
    perRunner: false,
    legacyDefaultMs: 5 * MINUTE_MS,
  }),
  Object.freeze({
    name: "llm_timeout",
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
]);

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
      values[key] = parseDuration(value);
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

/** A stored per-task value, or undefined when it is unset or not a limit. */
function taskValue(
  def: Readonly<RunLimitDefinition>,
  caps: Readonly<Record<string, unknown>>,
): DurationValue | undefined {
  const stored = caps[def.capsKey];
  if (stored === "none") return "none";
  if (typeof stored !== "number" || !Number.isFinite(stored) || stored <= 0) return undefined;
  const versioned = typeof caps.capsVersion === "number" && caps.capsVersion >= CAPS_VERSION;
  if (!versioned && stored === def.legacyDefaultMs) return undefined;
  return stored;
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
 * The time limits of one run: a model call's LLM limit for its runner; a
 * command's limit, plus, when it has a summarize step, that step's LLM limit
 * for the summarize provider. `spec` is the row's body or a job occurrence's.
 */
export function resolveTaskRunLimits(
  spec: { provider: ProviderName; caps?: Readonly<Record<string, unknown>>; summarize?: { provider: ProviderName } },
  settings: RunLimitSettings,
): ResolvedRunLimits {
  const out = resolveRunLimits(spec.caps, settings, spec.provider);
  if (spec.provider === "command" && spec.summarize) Object.assign(out, resolveRunLimits(spec.caps, settings, spec.summarize.provider));
  return out;
}

/** An effective limit as a person reads it: `30m (default)`, `none (setting:claude-code)`. */
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

/** True for a caps key that holds a time limit (`commandTimeoutMs`, `llmTimeoutMs`). */
export function isTimeLimitCap(key: string): boolean {
  return RUN_LIMITS.some((d) => d.capsKey === key);
}

/** Why a writer refuses a cap value, or undefined: a time limit per {@link timeLimitError}, any other cap a positive number. */
export function capValueError(key: string, value: unknown): string | undefined {
  if (isTimeLimitCap(key)) {
    const error = timeLimitError(value);
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
  if (!versioned) for (const def of RUN_LIMITS) if (out[def.capsKey] === def.legacyDefaultMs) delete out[def.capsKey];
  out.capsVersion = CAPS_VERSION;
  return out as T & { capsVersion: number };
}

/** A time limit as event details and HTTP JSON carry it: seconds, or `"none"`. */
export function durationSeconds(value: DurationValue): number | "none" {
  return value === "none" ? "none" : value / SECOND_MS;
}

/** The `limits` details of a `dispatched` event: each effective time limit, in seconds or `"none"`, and its source. */
export type RunLimitsDetails = Partial<Record<RunLimitName, { value_s: number | "none"; source: RunLimitSource }>>;

export function runLimitsDetails(limits: ResolvedRunLimits): RunLimitsDetails {
  const out: RunLimitsDetails = {};
  for (const def of RUN_LIMITS) {
    const limit = limits[def.name];
    if (limit) out[def.name] = { value_s: durationSeconds(limit.value), source: limit.source };
  }
  return out;
}

/** The limits a `dispatched` event's details record, or undefined when it records none (a run from before they were recorded). */
export function runLimitsFromDetails(details: unknown): ResolvedRunLimits | undefined {
  const limits = (details as { limits?: unknown } | null | undefined)?.limits;
  if (!limits || typeof limits !== "object") return undefined;
  const out: ResolvedRunLimits = {};
  for (const def of RUN_LIMITS) {
    const entry = (limits as Record<string, { value_s?: unknown; source?: unknown } | undefined>)[def.name];
    if (!entry || typeof entry.source !== "string") continue;
    const s = entry.value_s;
    if (s === "none") out[def.name] = { value: "none", source: entry.source as RunLimitSource };
    else if (typeof s === "number" && Number.isFinite(s) && s > 0) out[def.name] = { value: s * SECOND_MS, source: entry.source as RunLimitSource };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** A task's time limits as a view shows them, and whether its newest run recorded them or they apply if it ran now. */
export interface TaskRunLimitsView {
  limits: RunLimitsDetails;
  from: "dispatch" | "now";
}

/**
 * The time limits of a task: the ones its newest `dispatched` event
 * recorded, or, before a run recorded them, the ones a run that starts now
 * gets. `events` are the task's events, oldest first.
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
  const label: Record<RunLimitName, string> = { command_timeout: "command", llm_timeout: "LLM" };
  const parts = RUN_LIMITS.flatMap((def) => {
    const l = limits[def.name];
    return l ? [`${label[def.name]} ${formatDuration(l.value_s === "none" ? "none" : l.value_s * SECOND_MS)} (${l.source})`] : [];
  });
  return parts.length > 0 ? parts.join(", ") : undefined;
}
