/**
 * Region helpers for long-lived hosts (the MCP server, the OpenClaw plugin):
 * a cached reader of the stored setting and the check of a tool argument.
 */
import { statSync } from "node:fs";

import { carbonBudgetConfigPath } from "./budget.js";
import { catalogZone, closestRegions, ignoredRegionMessage, loadRegionSetting } from "./region.js";

/** New-issue link for a region request, prefilled with `subject` in the title. */
export function regionRequestUrl(subject?: string): string {
  const base = "https://github.com/tidegap/tidegap/issues/new?template=region_request.md";
  const title = subject?.trim();
  return title ? `${base}&title=${encodeURIComponent(`Region request: ${title}`).replace(/%20/g, "+").replace(/%3A/g, ":")}` : base;
}

/** "Unknown zone X. Closest: A, B. Request a region: <link>" (no "Closest" when none). */
export function unknownRegionMessage(input: string): string {
  const zone = input.trim();
  const closest = closestRegions(zone);
  const hint = closest.length > 0 ? ` Closest: ${closest.join(", ")}.` : "";
  return `Unknown zone ${zone}.${hint} Request a region: ${regionRequestUrl(zone)}`;
}

/**
 * Check a region tool argument. A catalog zone (any case) returns its code.
 * Any other value is an error with the closest zones, unless `passThrough`
 * is set (an Electricity Maps key serves zones beyond the catalog).
 */
export function checkRequestedRegion(
  input: string,
  opts: { passThrough?: boolean } = {},
): { region: string } | { error: string } {
  const zone = catalogZone(input);
  if (zone) return { region: zone };
  if (opts.passThrough) return { region: input.trim() };
  return { error: unknownRegionMessage(input) };
}

export interface RegionSettingReaderOptions {
  /** Config file path; read on each call. Defaults to `~/.tidegap/config`. */
  path?: () => string;
  /** Receives the ignored-setting warning once per file change. */
  warn?: (message: string) => void;
}

/**
 * A reader of the stored region setting for a long-lived process. Each call
 * stats the file and re-reads it only when `(mtimeMs, size)` changed, so a
 * new setting applies on the next call without a restart. A stored value
 * that is not a catalog zone is warned about once per file change.
 */
export function regionSettingReader(opts: RegionSettingReaderOptions = {}): () => string | undefined {
  const pathOf = opts.path ?? carbonBudgetConfigPath;
  let key: string | undefined;
  let value: string | undefined;
  return () => {
    const path = pathOf();
    let stamp: string;
    try {
      const st = statSync(path);
      stamp = `${path}\0${st.mtimeMs}\0${st.size}`;
    } catch {
      stamp = `${path}\0missing`;
    }
    if (stamp === key) return value;
    key = stamp;
    value = loadRegionSetting(path);
    if (value && !catalogZone(value)) opts.warn?.(ignoredRegionMessage(value));
    return value;
  };
}
