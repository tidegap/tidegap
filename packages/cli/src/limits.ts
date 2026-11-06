/**
 * The run-limit settings in `~/.tidegap/config`: one module reads and
 * writes them for every host surface (`tidegap limits` now, the settings
 * API later). The run-limits registry in core owns the names, keys,
 * defaults, grammar and precedence; this module only lists and edits the
 * stored lines.
 */

import { readFileSync } from "node:fs";

import {
  carbonBudgetConfigPath,
  DurationError,
  formatDuration,
  parseDuration,
  parseKeyValues,
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
  /** The CLI name, `command-timeout` or `llm-timeout`. */
  name: string;
  runner: ProviderName;
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
  if (!def) throw new LimitSettingError(`unknown setting ${JSON.stringify(name)}; use ${RUN_LIMITS.map((d) => d.cliName).join(" or ")}`);
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
 * Store a setting: `value` in the duration grammar or `none`, for all
 * runners or for `runner`. Every other line of the file stays byte for
 * byte. Returns the key and the stored value.
 */
export function setLimit(
  name: string,
  value: string,
  runner: string | undefined,
  configPath: string = carbonBudgetConfigPath(),
): { key: string; value: DurationValue } {
  const def = limitByName(name);
  const key = limitKey(def, runner);
  let parsed: DurationValue;
  try {
    parsed = parseDuration(value);
  } catch (err) {
    if (err instanceof DurationError) throw new LimitSettingError(err.message);
    throw err;
  }
  setEnvFileKey(configPath, key, formatDuration(parsed));
  return { key, value: parsed };
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
    const ms = def.defaults[runner]!;
    groups.set(ms, [...(groups.get(ms) ?? []), runner]);
  }
  if (groups.size === 1) return formatDuration([...groups.keys()][0]!);
  const list = (names: string[]) => (names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);
  return [...groups].map(([ms, runners]) => `${formatDuration(ms)} for ${list(runners)}`).join(", ");
}
