/**
 * The grid region on this machine, for every CLI surface (region plan KTD6):
 * `tidegap region`, `tidegap tick`, `tidegap queue` writes, `tidegap ui` and
 * its `/api/settings/region` routes, and the Telegram listener.
 *
 * Precedence (KTD2): `--region` flag > `TIDEGAP_DEFAULT_REGION` in the
 * environment (keys from `~/.config/tidegap/env` included) > the stored
 * setting (`TIDEGAP_DEFAULT_REGION` in `~/.tidegap/config`) > the time-zone
 * guess > GB. The setting is read on every call, so a change applies to the
 * next tick, request or task without a restart (KTD11).
 */

import {
  carbonBudgetConfigPath,
  catalogZone,
  COUNTRY_ALIASES,
  guessRegionFromTimeZone,
  hostTimeZone,
  ignoredRegionMessage,
  REGION_CATALOG,
  REGION_SETTING_KEY,
  regionDataSource,
  regionRequestUrl,
  regionSettingReader,
  resolveRegion,
  unknownRegionMessage,
  FALLBACK_REGION,
  type GridFeedCredentials,
  type RegionApproximation,
  type RegionDataSource,
  type RegionResolution,
} from "@tidegap/core";

import { setEnvFileKey } from "./commands/env-file.js";

/** A region a flag, the env variable or `/api/forecast?region=` may name. */
export const REGION_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface RegionInputs {
  /** `--region` (source `flag`). */
  flag?: string;
  /** `TIDEGAP_DEFAULT_REGION` from the environment (source `env`). */
  env?: string;
  /** The config file; defaults to `~/.tidegap/config`. */
  configPath?: string;
  /**
   * IANA time zone to guess from. Defaults to the host's when the key is
   * absent; an explicit `undefined` skips the guess.
   */
  timeZone?: string;
}

/** An override value: a catalog zone in its catalog spelling, else as typed when it passes REGION_RE. */
function override(value: string | undefined): string | undefined {
  const v = value?.trim();
  if (!v || !REGION_RE.test(v)) return undefined;
  return catalogZone(v) ?? v;
}

const readers = new Map<string, () => string | undefined>();

/** The raw stored setting; the file is re-read only when its (mtime, size) changed. */
function storedSetting(configPath: string = carbonBudgetConfigPath()): string | undefined {
  let read = readers.get(configPath);
  if (!read) {
    read = regionSettingReader({ path: () => configPath });
    readers.set(configPath, read);
  }
  return read();
}

function resolveWith(inputs: RegionInputs, setting: string | undefined): RegionResolution {
  return resolveRegion({
    requested: override(inputs.flag),
    configured: { value: override(inputs.env), source: "env" },
    setting,
    ...("timeZone" in inputs ? { timeZone: inputs.timeZone } : {}),
  });
}

/** The region now, with its source. A changed setting file applies on the next call. */
export function currentRegion(inputs: RegionInputs = {}): RegionResolution {
  return resolveWith(inputs, storedSetting(inputs.configPath));
}

/** A getter for long-lived hosts (scheduler, ui): the region of {@link currentRegion} on each call. */
export function regionGetter(inputs: RegionInputs = {}): () => string {
  return () => currentRegion(inputs).region;
}

/** The catalog zone `input` names (any case, or a common alias such as UK), `"auto"`, or undefined. */
export function parseRegionInput(input: string): string | undefined {
  const text = input.trim();
  if (text.toLowerCase() === "auto") return "auto";
  const upper = text.toUpperCase();
  return catalogZone(text) ?? (Object.hasOwn(COUNTRY_ALIASES, upper) ? COUNTRY_ALIASES[upper] : undefined);
}

export class UnknownRegionError extends Error {
  readonly code = "unknown_zone";
  constructor(readonly input: string) {
    super(unknownRegionMessage(input));
  }
}

/**
 * Store `input` (a catalog zone or alias) as the setting, or clear it with
 * `"auto"`. Other lines of the file stay byte for byte; the write is atomic
 * and locked (the env-file writer). Throws UnknownRegionError for anything
 * else. Returns the stored zone, or undefined after `auto`.
 */
export function storeRegion(input: string, configPath: string = carbonBudgetConfigPath()): string | undefined {
  const zone = parseRegionInput(input);
  if (!zone) throw new UnknownRegionError(input);
  const value = zone === "auto" ? undefined : zone;
  setEnvFileKey(configPath, REGION_SETTING_KEY, value);
  return value;
}

export interface RegionCatalogItem {
  zone: string;
  name: string;
  country: string;
  countryName: string;
  operator: string;
  dataSource: RegionDataSource;
}

/** The supported zones, catalog order, each with its data source. */
export function regionCatalog(credentials: GridFeedCredentials = {}): RegionCatalogItem[] {
  return Object.entries(REGION_CATALOG).map(([zone, e]) => ({
    zone,
    ...e,
    dataSource: regionDataSource(zone, credentials),
  }));
}

/** The time-zone guess alone (what `region detect` and Auto-detect show). */
export interface DetectedRegion {
  region: string;
  source: "timezone" | "fallback";
  timeZone?: string;
  approximate?: RegionApproximation;
}

/** Guess from `timeZone` (default: the host's); GB when the zone is not mapped. */
export function detectRegion(timeZone: string | undefined = hostTimeZone()): DetectedRegion {
  const zoneInfo = timeZone ? { timeZone } : {};
  const guess = guessRegionFromTimeZone(timeZone);
  if (guess) return { ...guess, source: "timezone", ...zoneInfo };
  return { region: FALLBACK_REGION, source: "fallback", ...zoneInfo };
}

/** Everything `region show --json` and `GET /api/settings/region` report. */
export interface RegionView {
  /** The region in use. */
  effective: string;
  source: RegionResolution["source"];
  name?: string;
  dataSource: RegionDataSource;
  /** The stored setting (raw, even when ignored), or null. */
  stored: string | null;
  /** A stored value that is not a catalog zone and was skipped. */
  ignored?: string;
  /** The host's IANA time zone, or null. */
  timeZone: string | null;
  /** The time-zone guess, whatever the source. */
  detected: DetectedRegion;
  /** Set when the effective region is an approximate time-zone guess. */
  approximate?: RegionApproximation;
  /** A request link when the region is approximate or the GB fallback. */
  requestUrl?: string;
}

export interface RegionViewInputs extends RegionInputs {
  credentials?: GridFeedCredentials;
}

/** The current region and its context. */
export function regionView(inputs: RegionViewInputs = {}): RegionView {
  const timeZone = "timeZone" in inputs ? inputs.timeZone : hostTimeZone();
  const stored = storedSetting(inputs.configPath) ?? null;
  const r = resolveWith({ ...inputs, timeZone }, stored ?? undefined);
  const name = Object.hasOwn(REGION_CATALOG, r.region) ? REGION_CATALOG[r.region]!.name : undefined;
  const subject = r.approximate?.country ?? (r.source === "fallback" ? timeZone : undefined);
  return {
    effective: r.region,
    source: r.source,
    ...(name ? { name } : {}),
    dataSource: regionDataSource(r.region, inputs.credentials),
    stored,
    ...(r.ignored ? { ignored: r.ignored } : {}),
    timeZone: timeZone ?? null,
    detected: detectRegion(timeZone),
    ...(r.approximate ? { approximate: r.approximate } : {}),
    ...(r.approximate || r.source === "fallback" ? { requestUrl: regionRequestUrl(subject) } : {}),
  };
}

/** One phrase for how the region was chosen, e.g. "guessed from time zone Europe/Kyiv". */
export function sourceText(
  source: RegionResolution["source"],
  timeZone: string | null | undefined,
  approximate?: RegionApproximation,
): string {
  switch (source) {
    case "flag":
      return "set by --region";
    case "env":
      return "set by TIDEGAP_DEFAULT_REGION";
    case "config":
      return "set by the host config";
    case "setting":
      return "stored setting (tidegap region set)";
    case "timezone":
      return `guessed from time zone ${timeZone}${approximate ? ` (approximate: no ${approximate.country} data yet)` : ""}`;
    case "fallback":
      return timeZone ? `default: time zone ${timeZone} is not mapped` : "default: no time zone";
  }
}

/** "PL Poland — guessed from time zone Europe/Kyiv (…)". */
function headline(region: string, text: string): string {
  const name = Object.hasOwn(REGION_CATALOG, region) ? ` ${REGION_CATALOG[region]!.name}` : "";
  return `${region}${name} — ${text}`;
}

/** The data source line: live feed, or the sample curve and the key that turns it live. */
function dataSourceText(d: RegionDataSource): string {
  if (d.live) return `Data: ${d.label} (live)`;
  return `Data: ${d.label} (sample curve${d.keyVar ? `: add ${d.keyVar}` : ""})`;
}

/** `tidegap region show` text: zone, name, source, data source, then notes. */
export function formatRegionView(v: RegionView): string {
  const lines = [headline(v.effective, sourceText(v.source, v.timeZone, v.approximate)), dataSourceText(v.dataSource)];
  if (v.approximate) lines.push(v.approximate.note);
  if (v.ignored) lines.push(ignoredRegionMessage(v.ignored));
  if ((v.source === "flag" || v.source === "env") && v.stored && v.stored !== v.effective && !v.ignored) {
    lines.push(`Stored setting ${v.stored} applies when the override is removed.`);
  }
  if (v.requestUrl) lines.push(`Request your region: ${v.requestUrl}`);
  return lines.join("\n");
}

/** `tidegap region detect` text: the guess, its notes and the request link. */
export function formatDetected(d: DetectedRegion): string {
  const lines = [headline(d.region, sourceText(d.source, d.timeZone, d.approximate))];
  if (d.approximate) lines.push(d.approximate.note);
  if (d.approximate || d.source === "fallback") {
    lines.push(`Request your region: ${regionRequestUrl(d.approximate?.country ?? d.timeZone)}`);
  }
  return lines.join("\n");
}
