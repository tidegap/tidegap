/**
 * `tidegap region show | set <zone> | detect | list` (region plan R11-R14).
 * The stored setting is `TIDEGAP_DEFAULT_REGION` in `~/.tidegap/config`;
 * `set auto` clears it so the time-zone guess applies again.
 */

import { hostTimeZone, REGION_CATALOG } from "@tidegap/core";

import { readEnvCredentials } from "../env.js";
import {
  detectRegion,
  regionCatalog,
  regionView,
  storeRegion,
  formatDetected,
  formatRegionView,
  UnknownRegionError,
  type RegionViewInputs,
} from "../region.js";
import { loadEnvFileIntoProcess } from "./env-file.js";

export interface RegionCommandResult {
  exitCode: number;
  /** stdout text. */
  out?: string;
  /** stderr text. */
  err?: string;
}

/** The environment's override and grid credentials, after the secrets file is loaded. */
function hostInputs(): RegionViewInputs {
  loadEnvFileIntoProcess();
  const env = readEnvCredentials();
  return { env: env.defaultRegion, credentials: env.grid };
}

export function runRegionShow(opts: { json?: boolean } = {}, inputs: RegionViewInputs = hostInputs()): RegionCommandResult {
  const view = regionView(inputs);
  return { exitCode: 0, out: opts.json ? JSON.stringify(view, null, 2) : formatRegionView(view) };
}

export function runRegionSet(
  zone: string,
  opts: { json?: boolean } = {},
  inputs: RegionViewInputs = hostInputs(),
): RegionCommandResult {
  let stored: string | undefined;
  try {
    stored = storeRegion(zone, inputs.configPath);
  } catch (err) {
    if (err instanceof UnknownRegionError) return { exitCode: 2, err: err.message };
    throw err;
  }
  const view = regionView(inputs);
  if (opts.json) return { exitCode: 0, out: JSON.stringify(view, null, 2) };
  const head = stored
    ? `Region set to ${REGION_CATALOG[stored]!.name} (${stored}).`
    : "Stored region cleared; the time-zone guess applies.";
  return { exitCode: 0, out: `${head}\n${formatRegionView(view)}` };
}

export function runRegionDetect(
  opts: { json?: boolean } = {},
  timeZone: string | undefined = hostTimeZone(),
): RegionCommandResult {
  const d = detectRegion(timeZone);
  if (opts.json) return { exitCode: 0, out: JSON.stringify(d, null, 2) };
  const out = `${formatDetected(d)}\nNothing stored. \`tidegap region set auto\` clears a stored region so this guess applies.`;
  return { exitCode: 0, out };
}

export function runRegionList(opts: { json?: boolean } = {}, inputs: RegionViewInputs = hostInputs()): RegionCommandResult {
  const items = regionCatalog(inputs.credentials);
  if (opts.json) return { exitCode: 0, out: JSON.stringify(items, null, 2) };
  const width = Math.max(...items.map((i) => i.zone.length));
  const out = items.map(
    (i) => `${i.zone.padEnd(width)}  ${i.name}, ${i.countryName} · ${i.operator} · ${i.dataSource.label}`,
  );
  return { exitCode: 0, out: out.join("\n") };
}
