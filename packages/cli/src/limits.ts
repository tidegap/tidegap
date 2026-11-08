/**
 * The run-limit settings in `~/.tidegap/config` (the two time limits,
 * retries and the retry delay): one module reads and writes them for every
 * host surface (`tidegap limits` now, the settings API later). The
 * run-limits registry in core owns the names, keys, defaults, grammar and
 * precedence; this module only lists and edits the stored lines.
 */

import { readFileSync } from "node:fs";

import {
  carbonBudgetConfigPath,
  DurationError,
  durationSeconds,
  formatRunLimitValue,
  parseKeyValues,
  parseRunLimitValue,
  resolveRunLimits,
  RUN_LIMITS,
  runLimitSettingsFromValues,
  type DurationValue,
  type IgnoredRunLimitLine,
  type ProviderName,
  type RunLimitDefinition,
  type RunLimitName,
  type RunLimitSettings,
  type RunLimitSource,
} from "@tidegap/core";

import { setEnvFileKey } from "./commands/env-file.js";

/** The sentence a user reads before switching a time limit off. */
export const NO_TIME_LIMIT_WARNING =
  "A run with no time limit holds every other due task while it runs; tidegap queue cancel <id> stops it.";

/** A setting refused by name, runner or value; the message is the sentence to print. */
export class LimitSettingError extends Error {
  override name = "LimitSettingError";
}

/** One effective limit: a setting for one runner, its value and where it came from. */
export interface LimitRow {
  setting: RunLimitName;
  /** The CLI name: `command-timeout`, `llm-timeout`, `retries` or `retry-delay`. */
  name: string;
  runner: ProviderName;
  /** Milliseconds or `none` for a duration, a count for `retries`. */
  value: DurationValue;
  source: RunLimitSource;
}

export interface LimitsView {
  rows: LimitRow[];
  /** Lines under a run-limit key that are not used, with the reason. */
  ignored: readonly IgnoredRunLimitLine[];
}

/** The runners a setting applies to, in registry order. */
export function limitRunners(def: Readonly<RunLimitDefinition>): ProviderName[] {
  return Object.keys(def.defaults) as ProviderName[];
}

/** The settings of the file, without the once-per-process stderr warning: the listing names ignored lines itself. */
function readSettings(configPath: string): RunLimitSettings {
  let contents: string;
  try {
    contents = readFileSync(configPath, "utf8");
  } catch {
    return { values: {}, ignored: [] };
  }
  return runLimitSettingsFromValues(parseKeyValues(contents));
}

/** Every setting for every runner it applies to, with value and source, and the ignored lines. */
export function limitsView(configPath: string = carbonBudgetConfigPath()): LimitsView {
  const settings = readSettings(configPath);
  const rows: LimitRow[] = [];
  for (const def of RUN_LIMITS) {
    for (const runner of limitRunners(def)) {
      const limit = resolveRunLimits(undefined, settings, runner)[def.name]!;
      rows.push({ setting: def.name, name: def.cliName, runner, value: limit.value, source: limit.source });
    }
  }
  return { rows, ignored: settings.ignored };
}

/** The setting a CLI name names. */
export function limitByName(name: string): Readonly<RunLimitDefinition> {
  const def = RUN_LIMITS.find((d) => d.cliName === name);
  if (!def) {
    const names = RUN_LIMITS.map((d) => d.cliName);
    throw new LimitSettingError(`unknown setting ${JSON.stringify(name)}; use ${names.slice(0, -1).join(", ")} or ${names.at(-1)}`);
  }
  return def;
}

/** The config key of a setting, for all runners or for one: `TIDEGAP_LLM_TIMEOUT_CLAUDE_CODE`. */
export function limitKey(def: Readonly<RunLimitDefinition>, runner?: string): string {
  if (runner === undefined) return def.key;
  const runners = limitRunners(def);
  if (!def.perRunner) throw new LimitSettingError(`${def.cliName} takes no --runner: it applies to the ${runners.join(", ")} runner only`);
  if (!(runners as string[]).includes(runner)) {
    throw new LimitSettingError(`${def.cliName} takes --runner ${runners.join(", ")}, got ${JSON.stringify(runner)}`);
  }
  return `${def.key}_${runner.toUpperCase().replace(/-/g, "_")}`;
}

/**
 * Store a setting: `value` in the setting's grammar (a duration or `none`
 * for a time limit, a duration for the retry delay, 0 to 10 for retries),
 * for all runners or for `runner`. Every other line of the file stays byte
 * for byte. Returns the key and the stored value.
 */
export function setLimit(
  name: string,
  value: string,
  runner: string | undefined,
  configPath: string = carbonBudgetConfigPath(),
): { key: string; value: DurationValue; def: Readonly<RunLimitDefinition> } {
  const def = limitByName(name);
  const key = limitKey(def, runner);
  let parsed: DurationValue;
  try {
    parsed = parseRunLimitValue(def, value);
  } catch (err) {
    if (err instanceof DurationError) throw new LimitSettingError(err.message);
    throw err;
  }
  setEnvFileKey(configPath, key, formatRunLimitValue(def, parsed));
  return { key, value: parsed, def };
}

/** Remove a setting, so the next layer applies. Returns the key. */
export function resetLimit(name: string, runner: string | undefined, configPath: string = carbonBudgetConfigPath()): string {
  const key = limitKey(limitByName(name), runner);
  setEnvFileKey(configPath, key, undefined);
  return key;
}

/**
 * The defaults of a setting as help text reads them, from the registry:
 * `30m` when every runner shares one, else `30m for claude-code, 10m for
 * anthropic, openai, gemini and ollama`.
 */
export function limitDefaultsText(name: string): string {
  const def = limitByName(name);
  const groups = new Map<number, string[]>();
  for (const runner of limitRunners(def)) {
    const value = def.defaults[runner]!;
    groups.set(value, [...(groups.get(value) ?? []), runner]);
  }
  if (groups.size === 1) return formatRunLimitValue(def, [...groups.keys()][0]!);
  const list = (names: string[]) => (names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);
  return [...groups].map(([value, runners]) => `${formatRunLimitValue(def, value)} for ${list(runners)}`).join(", ");
}

// ── the settings API (`GET|POST /api/settings/limits`) ─────────────────

/** One value in HTTP JSON (KTD12): a duration as `value_s` (seconds or `"none"`), retries as `value`. */
export type LimitJsonValue = { value_s: number | "none" } | { value: number };

function jsonValue(def: Readonly<RunLimitDefinition>, value: DurationValue): LimitJsonValue {
  return def.kind === "count" ? { value: value as number } : { value_s: durationSeconds(value) };
}

/** One runner of a setting in the API view: the effective value and its source, and the value stored for this runner. */
export interface LimitRunnerJson {
  runner: ProviderName;
  effective: LimitJsonValue;
  source: RunLimitSource;
  /** The `<KEY>_<RUNNER>` value, or null; always null for a setting without per-runner keys. */
  stored: LimitJsonValue | null;
  default: LimitJsonValue;
}

export interface LimitSettingJson {
  setting: RunLimitName;
  name: string;
  kind: RunLimitDefinition["kind"];
  /** `<KEY>_<RUNNER>` lines are read (false: one key for the one runner). */
  per_runner: boolean;
  key: string;
  /** The all-runners `<KEY>` value, or null. */
  all: LimitJsonValue | null;
  runners: LimitRunnerJson[];
}

export interface LimitsJson {
  settings: LimitSettingJson[];
  ignored: readonly IgnoredRunLimitLine[];
  /** The sentence to show under a time limit set to `none`. */
  no_time_limit_warning: string;
}

/** The settings API body: every setting, its stored lines and, per runner, the effective value with its source. */
export function limitsJson(configPath: string = carbonBudgetConfigPath()): LimitsJson {
  const settings = readSettings(configPath);
  const stored = (key: string) => settings.values[key];
  return {
    settings: RUN_LIMITS.map((def) => {
      const all = stored(def.key);
      return {
        setting: def.name,
        name: def.cliName,
        kind: def.kind,
        per_runner: def.perRunner,
        key: def.key,
        all: all === undefined ? null : jsonValue(def, all),
        runners: limitRunners(def).map((runner) => {
          const own = def.perRunner ? stored(limitKey(def, runner)) : undefined;
          const limit = resolveRunLimits(undefined, settings, runner)[def.name]!;
          return {
            runner,
            effective: jsonValue(def, limit.value),
            source: limit.source,
            stored: own === undefined ? null : jsonValue(def, own),
            default: jsonValue(def, def.defaults[runner]!),
          };
        }),
      };
    }),
    ignored: settings.ignored,
    no_time_limit_warning: NO_TIME_LIMIT_WARNING,
  };
}

/**
 * Store or clear one setting from an API body: `setting` is the registry
 * name, `runner` null for all runners, the value `value_s` (seconds or
 * `"none"`) for a duration or `value` for retries, null to remove the line.
 * Throws {@link LimitSettingError} with a fixed sentence for a body the
 * setting does not take.
 */
export function storeLimitJson(body: Record<string, unknown>, configPath: string = carbonBudgetConfigPath()): void {
  const def = RUN_LIMITS.find((d) => d.name === body.setting);
  const names = RUN_LIMITS.map((d) => d.name);
  if (!def) throw new LimitSettingError(`setting must be ${names.slice(0, -1).join(", ")} or ${names.at(-1)}`);
  const valueKey = def.kind === "count" ? "value" : "value_s";
  const extra = Object.keys(body).find((k) => k !== "setting" && k !== "runner" && k !== valueKey);
  // A fixed sentence: the caller's key is never echoed back.
  if (extra) throw new LimitSettingError(`${def.name} takes only {"setting", "runner", "${valueKey}"}`);
  if (!(valueKey in body)) throw new LimitSettingError(`${def.name} needs "${valueKey}"; null removes the setting`);
  const runner = body.runner ?? undefined;
  const runners = limitRunners(def);
  if (runner !== undefined) {
    if (!def.perRunner) throw new LimitSettingError(`${def.name} applies to the ${runners.join(", ")} runner only; send "runner": null`);
    if (typeof runner !== "string" || !(runners as string[]).includes(runner)) {
      throw new LimitSettingError(`runner must be null (all runners) or one of ${runners.join(", ")}`);
    }
  }
  const value = body[valueKey];
  if (value === null) {
    resetLimit(def.cliName, runner as string | undefined, configPath);
    return;
  }
  // A number is seconds (or a count), the grammar's bare number; `"none"` is the one word.
  const text = typeof value === "number" && Number.isFinite(value) ? String(value) : value === "none" ? "none" : "?";
  setLimit(def.cliName, text, runner as string | undefined, configPath);
}
