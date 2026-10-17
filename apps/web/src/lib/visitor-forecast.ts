/**
 * The visitor's 24-hour grid forecast for the homepage curve (KTD11).
 *
 * Region comes from the Vercel geo headers (`resolveVisitorRegion`). A
 * forecast counts as live only when its feed is not the mock, it has
 * entries, and every value is above 0. When the visitor's grid is not live,
 * the helper shows the live GB forecast instead (`fallback: "GB"`); when GB
 * is not live either, it returns the mock curve with `live: false`, and the
 * page must then show no values.
 */

import { mockGridFeed } from "@tidegap/core/grid";

import { getGridForecast } from "./grid";
import { resolveVisitorRegion } from "./geo";
import { REGION_BY_ZONE, type Region } from "./regions";
import type { GridForecast, GridForecastEntry } from "./types";

const HOURS = 24;

export type VisitorForecast = {
  /** The region the curve shows (GB when `fallback` is set). */
  region: Region;
  /** IANA time zone of `region`, for the hour labels. */
  timeZone: string;
  /** Whether the visitor's own region was detected from geo headers. */
  geo: boolean;
  /** Set when the visitor's grid had no live feed and GB is shown instead. */
  fallback?: "GB";
  live: boolean;
  source: GridForecast["source"];
  entries: GridForecastEntry[];
  now: GridForecastEntry;
  cleanest: GridForecastEntry;
};

/** IANA zones for the covered grids, so hour labels follow local DST. */
const TIME_ZONE: Record<string, string> = {
  "US-CAL-CISO": "America/Los_Angeles",
  "US-NW-BPAT": "America/Los_Angeles",
  "US-TEX-ERCO": "America/Chicago",
  "US-MIDW-MISO": "America/Chicago",
  "US-NE-ISNE": "America/New_York",
  "US-NY-NYIS": "America/New_York",
  "US-MIDA-PJM": "America/New_York",
  "US-FLA-FPL": "America/New_York",
  "CA-ON": "America/Toronto",
  GB: "Europe/London",
  IE: "Europe/Dublin",
  FR: "Europe/Paris",
  DE: "Europe/Berlin",
  NL: "Europe/Amsterdam",
  BE: "Europe/Brussels",
  ES: "Europe/Madrid",
  AT: "Europe/Vienna",
  PL: "Europe/Warsaw",
  "IT-NO": "Europe/Rome",
  "SE-SE3": "Europe/Stockholm",
  "NO-NO1": "Europe/Oslo",
  FI: "Europe/Helsinki",
  "DK-DK1": "Europe/Copenhagen",
  "JP-TK": "Asia/Tokyo",
  KR: "Asia/Seoul",
  SG: "Asia/Singapore",
  "IN-WE": "Asia/Kolkata",
  AE: "Asia/Dubai",
  ZA: "Africa/Johannesburg",
  "AU-NSW": "Australia/Sydney",
  NZ: "Pacific/Auckland",
};

export function timeZoneFor(zone: string): string {
  return TIME_ZONE[zone] ?? "UTC";
}

/** KTD11 live rule. */
export function isLive(forecast: GridForecast | null | undefined): forecast is GridForecast {
  return (
    !!forecast &&
    forecast.source !== "mock" &&
    forecast.entries.length > 0 &&
    forecast.entries.slice(0, HOURS).every((e) => e.carbonIntensityGCo2PerKwh > 0)
  );
}

/**
 * Pick what the curve shows from the visitor's forecast, the GB forecast
 * (null when the visitor is already on GB) and the mock curve. Pure, so the
 * fallback order can be checked without the network.
 */
export function chooseForecast(input: {
  region: Region;
  geo: boolean;
  local: GridForecast | null;
  gb: GridForecast | null;
  mock: GridForecast;
}): VisitorForecast {
  const gbRegion = REGION_BY_ZONE.GB!;
  const pick =
    isLive(input.local)
      ? { region: input.region, forecast: input.local, live: true }
      : isLive(input.gb)
        ? { region: gbRegion, forecast: input.gb, live: true, fallback: "GB" as const }
        : { region: input.region, forecast: input.mock, live: false };

  const entries = pick.forecast.entries.slice(0, HOURS);
  const cleanest = entries.reduce((a, b) =>
    b.carbonIntensityGCo2PerKwh < a.carbonIntensityGCo2PerKwh ? b : a,
  );
  return {
    region: pick.region,
    timeZone: timeZoneFor(pick.region.zone),
    geo: input.geo,
    fallback: pick.fallback,
    live: pick.live,
    source: pick.forecast.source,
    entries,
    now: entries[0]!,
    cleanest,
  };
}

export async function getVisitorForecast(headers: Headers): Promise<VisitorForecast> {
  const { region, source } = resolveVisitorRegion(headers);
  const safe = (zone: string) => getGridForecast(zone, HOURS).catch(() => null);
  const local = await safe(region.zone);
  const gb = region.zone === "GB" || isLive(local) ? null : await safe("GB");
  const mock = await mockGridFeed().fetchForecast(region.zone, HOURS);
  return chooseForecast({ region, geo: source === "geo", local, gb, mock });
}
