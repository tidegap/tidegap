/**
 * Grid-region resolution shared by every Tidegap integration — the CLI,
 * the MCP server and the OpenClaw plugin.
 *
 * Precedence (first match wins):
 *   1. an explicit request region (a `--region` flag or a tool argument),
 *   2. a host-configured default (`TIDEGAP_DEFAULT_REGION` in the
 *      environment, or OpenClaw's plugin `defaultRegion`),
 *   3. the stored setting (`TIDEGAP_DEFAULT_REGION` in `~/.tidegap/config`),
 *   4. a guess from the host machine's IANA time zone,
 *   5. FALLBACK_REGION.
 *
 * Core stays environment-pure: hosts read their own environment and pass
 * the configured value and the stored setting in.
 */
import { existsSync, readFileSync } from "node:fs";

import { carbonBudgetConfigPath, parseKeyValues } from "./budget.js";
import { REGION_CATALOG } from "./data/tables.generated.js";

/** Fallback when nothing else resolves — GB has key-less live data. */
export const FALLBACK_REGION = "GB";

/** Key of the region setting in `~/.tidegap/config` (and the env override). */
export const REGION_SETTING_KEY = "TIDEGAP_DEFAULT_REGION";

/** One supported grid zone, described for people. */
export interface RegionCatalogEntry {
  /** Zone name, e.g. "France" or "California". */
  name: string;
  /** ISO 3166-1 alpha-2 country code. */
  country: string;
  /** Country name, e.g. "United States". */
  countryName: string;
  /** Grid operator, e.g. "RTE". */
  operator: string;
}

export { REGION_CATALOG };

/**
 * Best-effort IANA-timezone → grid-region map. Only timezones whose
 * dominant grid is unambiguous are listed; a time zone that spans several
 * grids (Oslo, Stockholm, Copenhagen, Rome, Tokyo, Kolkata, Toronto,
 * Chicago) resolves to FALLBACK_REGION and the user sets the region.
 */
export const TIMEZONE_REGION: Readonly<Record<string, string>> = {
  "Europe/London": "GB",
  "Europe/Paris": "FR",
  "Europe/Berlin": "DE",
  "Europe/Busingen": "DE",
  "Europe/Warsaw": "PL",
  "Europe/Vienna": "AT",
  "Europe/Madrid": "ES",
  "Europe/Amsterdam": "NL",
  "Europe/Brussels": "BE",
  "Europe/Dublin": "IE",
  "Europe/Helsinki": "FI",
  "America/Los_Angeles": "US-CAL-CISO",
  "America/New_York": "US-MIDA-PJM",
  "America/Detroit": "US-MIDA-PJM",
  "Asia/Seoul": "KR",
  "Asia/Singapore": "SG",
  "Asia/Dubai": "AE",
  "Australia/Sydney": "AU-NSW",
  "Africa/Johannesburg": "ZA",
  "Pacific/Auckland": "NZ",
};

/** Why a time-zone guess is only approximate. */
export interface RegionApproximation {
  /** ISO country code of the time zone's own (unsupported) grid. */
  country: string;
  note: string;
}

const UA_NOTE =
  "No Ukrainian grid data yet; using Poland (PL), the nearest grid in the same synchronous area.";

const UA_APPROXIMATION = Object.freeze({
  region: "PL",
  approximate: Object.freeze({ country: "UA", note: UA_NOTE }),
});

/**
 * Time zones whose own grid is not in the catalog, mapped to the nearest
 * catalog zone. PL is the only catalog zone that borders Ukraine and shares
 * its synchronous area (Continental Europe, since March 2022): hour-of-day
 * timing carries over, absolute grams do not.
 */
export const APPROXIMATE_TIMEZONE_REGION: Readonly<
  Record<string, { region: string; approximate: RegionApproximation }>
> = {
  "Europe/Kyiv": UA_APPROXIMATION,
  "Europe/Kiev": UA_APPROXIMATION,
  "Europe/Uzhgorod": UA_APPROXIMATION,
  "Europe/Zaporozhye": UA_APPROXIMATION,
};

/**
 * How a resolved region was chosen: `flag` (request / tool argument), `env`
 * (`TIDEGAP_DEFAULT_REGION` in the environment), `config` (a host's own
 * config, e.g. OpenClaw `defaultRegion`), `setting` (`~/.tidegap/config`),
 * `timezone` (guess) or `fallback` (GB).
 */
export type RegionSource = "flag" | "env" | "config" | "setting" | "timezone" | "fallback";

export interface RegionResolution {
  region: string;
  source: RegionSource;
  /** The IANA time zone consulted; set when source is `timezone` or `fallback`. */
  timeZone?: string;
  /** Set when the time-zone guess stands in for an unsupported grid. */
  approximate?: RegionApproximation;
  /** A stored setting that is not a catalog zone and was skipped. */
  ignored?: string;
}

export interface ResolveRegionInput {
  /** `--region` flag or tool argument. */
  requested?: string;
  /** Host default: the env variable (`env`) or the host's own config (`config`). */
  configured?: { value?: string; source: "env" | "config" };
  /** Raw stored setting (see loadRegionSetting). Ignored unless a catalog zone. */
  setting?: string;
  /**
   * IANA time zone to guess from. Defaults to the host machine's when the
   * key is absent; an explicit `undefined` skips the guess.
   */
  timeZone?: string;
}

/** The catalog zone for `input` (case-insensitive), or undefined. */
export function catalogZone(input: string | undefined): string | undefined {
  if (!input) return undefined;
  const zone = input.trim().toUpperCase();
  return Object.hasOwn(REGION_CATALOG, zone) ? zone : undefined;
}

/** Map an IANA timezone to a supported grid region, or undefined. */
export function regionForTimezone(timeZone: string): string | undefined {
  return guessRegionFromTimeZone(timeZone)?.region;
}

/** The host machine's IANA time zone, or undefined when it cannot be read. */
export function hostTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Guess a catalog zone from an IANA time zone: an exact map entry, else an
 * approximate one (with the reason), else undefined.
 */
export function guessRegionFromTimeZone(
  timeZone: string | undefined,
): { region: string; approximate?: RegionApproximation } | undefined {
  if (!timeZone) return undefined;
  const exact = Object.hasOwn(TIMEZONE_REGION, timeZone) ? TIMEZONE_REGION[timeZone] : undefined;
  if (exact) return { region: exact };
  return Object.hasOwn(APPROXIMATE_TIMEZONE_REGION, timeZone)
    ? APPROXIMATE_TIMEZONE_REGION[timeZone]
    : undefined;
}

/** Guess the grid region from the host machine's IANA timezone. */
export function detectRegionFromTimezone(): string | undefined {
  return regionForTimezone(hostTimeZone() ?? "");
}

/** Warning text for a stored region that is not a catalog zone. */
export function ignoredRegionMessage(value: string): string {
  return `Stored region ${value} is not supported; ignored.`;
}

/**
 * Resolve a grid region with the precedence in the module comment.
 *
 * The positional form `(requested, configuredDefault)` is kept for existing
 * callers; it reports a configured default as `config` and reads no setting.
 */
export function resolveRegion(input: ResolveRegionInput): RegionResolution;
export function resolveRegion(requested?: string, configuredDefault?: string): RegionResolution;
export function resolveRegion(
  inputOrRequested?: ResolveRegionInput | string,
  configuredDefault?: string,
): RegionResolution {
  const input: ResolveRegionInput =
    typeof inputOrRequested === "object" && inputOrRequested !== null
      ? inputOrRequested
      : {
          requested: inputOrRequested,
          configured: { value: configuredDefault, source: "config" },
        };

  if (input.requested) return { region: input.requested, source: "flag" };
  const configured = input.configured;
  if (configured?.value) return { region: configured.value, source: configured.source };

  const raw = input.setting?.trim();
  const stored = catalogZone(raw);
  if (stored) return { region: stored, source: "setting" };
  const ignored = raw ? { ignored: raw } : {};

  const timeZone = "timeZone" in input ? input.timeZone : hostTimeZone();
  const zoneInfo = timeZone ? { timeZone } : {};
  const guess = guessRegionFromTimeZone(timeZone);
  if (guess) return { ...guess, source: "timezone", ...zoneInfo, ...ignored };
  return { region: FALLBACK_REGION, source: "fallback", ...zoneInfo, ...ignored };
}

/**
 * The raw region setting from `~/.tidegap/config` (or `path`), or undefined
 * when the file or the key is missing, empty or unreadable. Not validated:
 * resolveRegion skips a value that is not a catalog zone.
 */
export function loadRegionSetting(path: string = carbonBudgetConfigPath()): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const value = parseKeyValues(readFileSync(path, "utf8"))[REGION_SETTING_KEY]?.trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

/** Edit distance (Levenshtein) between two short strings. */
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (cur[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length] ?? 0;
}

/**
 * Largest edit distance still offered as a closest match: 1 for inputs of up
 * to 3 characters (any two 2-letter codes are within distance 2, so a wider
 * bound would suggest unrelated zones), else 2.
 */
function maxSuggestDistance(text: string): number {
  return text.length <= 3 ? 1 : 2;
}

/** Common codes that are not the ISO code of their catalog zone. */
export const COUNTRY_ALIASES: Readonly<Record<string, string>> = { UK: "GB" };

/**
 * Up to `limit` catalog zones closest to an unknown input, in catalog order
 * within each rule. The first rule with a result decides:
 *   1. the zone of a common alias (UK → GB), or the approximate-map
 *      target of a typed country code (UA → PL),
 *   2. zones whose code, name, country code or country name starts with it,
 *   3. zones whose code is within edit distance 2 (1 for inputs of up to
 *      3 characters), nearest first.
 */
export function closestRegions(input: string, limit = 3): string[] {
  const text = input.trim().toUpperCase();
  if (!text) return [];
  const zones = Object.keys(REGION_CATALOG);

  if (Object.hasOwn(COUNTRY_ALIASES, text)) return [COUNTRY_ALIASES[text]!];
  const approximate = [
    ...new Set(
      Object.values(APPROXIMATE_TIMEZONE_REGION)
        .filter((a) => a.approximate.country === text)
        .map((a) => a.region),
    ),
  ];
  if (approximate.length > 0) return approximate.slice(0, limit);

  const prefixed = Object.entries(REGION_CATALOG)
    .filter(([zone, e]) =>
      [zone, e.name, e.country, e.countryName].some((f) => f.toUpperCase().startsWith(text)),
    )
    .map(([zone]) => zone);
  if (prefixed.length > 0) return prefixed.slice(0, limit);

  const maxDistance = maxSuggestDistance(text);
  return zones
    .map((zone, order) => ({ zone, order, d: editDistance(text, zone) }))
    .filter((m) => m.d <= maxDistance)
    .sort((x, y) => x.d - y.d || x.order - y.order)
    .slice(0, limit)
    .map((m) => m.zone);
}
