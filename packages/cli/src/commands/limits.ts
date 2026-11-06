/**
 * `tidegap limits [show] | set <setting> <value> [--runner <r>] | reset
 * <setting> [--runner <r>]`: the run time limits stored in
 * `~/.tidegap/config`. A change applies to the next run, with no restart.
 */

import { carbonBudgetConfigPath, formatDuration, type DurationValue } from "@tidegap/core";

import { LimitSettingError, limitsView, NO_TIME_LIMIT_WARNING, resetLimit, setLimit, type LimitsView } from "../limits.js";

export interface LimitsCommandResult {
  exitCode: number;
  /** stdout text. */
  out?: string;
  /** stderr text. */
  err?: string;
}

export interface LimitsCommandOptions {
  json?: boolean;
  runner?: string;
  /** `~/.tidegap/config` override (tests). */
  config?: string;
}

function viewJson(view: LimitsView): string {
  const seconds = (v: DurationValue) => (v === "none" ? "none" : v / 1000);
  return JSON.stringify(
    {
      limits: view.rows.map((r) => ({ setting: r.name, runner: r.runner, value_s: seconds(r.value), source: r.source })),
      ignored: view.ignored,
    },
    null,
    2,
  );
}

/** One line per setting and runner, then the ignored lines and how to change one. */
export function formatLimitsView(view: LimitsView): string {
  const nameWidth = Math.max(...view.rows.map((r) => r.name.length));
  const runnerWidth = Math.max(...view.rows.map((r) => r.runner.length));
  const lines = ["Run time limits (~/.tidegap/config; a change applies to the next run):"];
  for (const r of view.rows) lines.push(`  ${r.name.padEnd(nameWidth)}  ${r.runner.padEnd(runnerWidth)}  ${formatDuration(r.value)} (${r.source})`);
  if (view.ignored.length > 0) {
    lines.push("Ignored lines:");
    for (const i of view.ignored) lines.push(`  ${i.key}=${i.value}: ${i.reason}`);
  }
  lines.push("Change one: tidegap limits set <setting> <value> [--runner <runner>]; none switches a time limit off.");
  return lines.join("\n");
}

export function runLimitsShow(opts: LimitsCommandOptions = {}): LimitsCommandResult {
  const view = limitsView(opts.config ?? carbonBudgetConfigPath());
  return { exitCode: 0, out: opts.json ? viewJson(view) : formatLimitsView(view) };
}

export function runLimitsSet(name: string, value: string, opts: LimitsCommandOptions = {}): LimitsCommandResult {
  const path = opts.config ?? carbonBudgetConfigPath();
  let stored: { key: string; value: DurationValue };
  try {
    stored = setLimit(name, value, opts.runner, path);
  } catch (err) {
    if (err instanceof LimitSettingError) return { exitCode: 2, err: `limits set: ${err.message}` };
    throw err;
  }
  const view = limitsView(path);
  if (opts.json) return { exitCode: 0, out: viewJson(view) };
  const head = [`Set ${stored.key}=${formatDuration(stored.value)} in ~/.tidegap/config.`];
  if (stored.value === "none") head.push(NO_TIME_LIMIT_WARNING);
  return { exitCode: 0, out: `${head.join("\n")}\n${formatLimitsView(view)}` };
}

export function runLimitsReset(name: string, opts: LimitsCommandOptions = {}): LimitsCommandResult {
  const path = opts.config ?? carbonBudgetConfigPath();
  let key: string;
  try {
    key = resetLimit(name, opts.runner, path);
  } catch (err) {
    if (err instanceof LimitSettingError) return { exitCode: 2, err: `limits reset: ${err.message}` };
    throw err;
  }
  const view = limitsView(path);
  if (opts.json) return { exitCode: 0, out: viewJson(view) };
  return { exitCode: 0, out: `Removed ${key} from ~/.tidegap/config; the next layer applies.\n${formatLimitsView(view)}` };
}
