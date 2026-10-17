/**
 * Fixture-level regression tests for the grid feeds (audit §0.4 / P25).
 *
 * Fixtures under test/fixtures/ are realistic recorded-response shapes:
 *   - entsoe-a75-de.xml          ENTSO-E realised generation (A75) with a
 *                                consumption TimeSeries (outBiddingZone),
 *                                a multi-Period TimeSeries, and a
 *                                Point-position gap (curveType A03).
 *   - entsoe-acknowledgement.xml ENTSO-E "no data" error envelope.
 *   - eia-fuel-mix-lagged.json   EIA hourly fuel mix whose last observation
 *                                is 4h behind the test's faked "now" —
 *                                the phase-rotation regression fixture.
 *   - uk-fw48h-page1/2.json      Two UK Carbon Intensity /fw48h pages with
 *                                a misaligned leading half-period and an
 *                                overlapping boundary period.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  eiaFeed,
  entsoeFeed,
  parseEntsoeXml,
  ukCarbonIntensityFeed,
  wattTimeFeed,
} from "../src/grid.js";
import type { GridFeed } from "../src/types.js";

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Fake only Date so `new Date()` is deterministic without stalling fetch/promises. */
function fakeNow(iso: string): void {
  vi.useFakeTimers({ now: new Date(iso), toFake: ["Date"] });
}

// ---------------------------------------------------------------------------
// ENTSO-E A75 XML
// ---------------------------------------------------------------------------

describe("parseEntsoeXml (A75 fixture)", () => {
  it("skips consumption TimeSeries and keeps only generation series", () => {
    const series = parseEntsoeXml(fixture("entsoe-a75-de.xml"));
    // Fixture has 3 TimeSeries; the B11 pumped-storage-pumping one is
    // marked with outBiddingZone_Domain.mRID and must be excluded.
    expect(series.map((s) => s.psrType)).toEqual(["B14", "B05"]);
  });

  it("parses multi-Period TimeSeries per Period", () => {
    const series = parseEntsoeXml(fixture("entsoe-a75-de.xml"));
    const nuclear = series.find((s) => s.psrType === "B14")!;
    expect(nuclear.periods.length).toBe(2);
    expect(nuclear.periods[0]?.start).toBe("2026-05-13T10:00Z");
    expect(nuclear.periods[1]?.start).toBe("2026-05-13T22:00Z");
    expect(nuclear.periods[0]?.points.length).toBe(12);
    expect(nuclear.periods[1]?.points.length).toBe(12);
  });

  it("captures Point positions so gaps stay holes (curveType A03)", () => {
    const series = parseEntsoeXml(fixture("entsoe-a75-de.xml"));
    const coal = series.find((s) => s.psrType === "B05")!;
    const positions = coal.periods[0]!.points.map((p) => p.position);
    expect(positions).not.toContain(3);
    expect(positions).toContain(4);
    expect(positions.length).toBe(23);
  });

  it("throws on an Acknowledgement_MarketDocument instead of returning empty", () => {
    expect(() => parseEntsoeXml(fixture("entsoe-acknowledgement.xml"))).toThrow(
      /Acknowledgement.*No matching data found/,
    );
  });

  // The feed text is external input: unclosed tags must not make the
  // block scan quadratic (CodeQL js/polynomial-redos).
  const N = 100_000;
  const timed = <T>(fn: () => T): { result: T; ms: number } => {
    const t0 = performance.now();
    const result = fn();
    return { result, ms: performance.now() - t0 };
  };

  it("unclosed <text> in an Acknowledgement finishes in linear time", () => {
    const xml = "<Acknowledgement_MarketDocument>" + "<text>".repeat(N);
    const { ms } = timed(() =>
      expect(() => parseEntsoeXml(xml)).toThrow(/no reason text in document/),
    );
    expect(ms).toBeLessThan(1000);
  });

  it("unclosed <TimeSeries> finishes in linear time", () => {
    const { result, ms } = timed(() => parseEntsoeXml("<TimeSeries>".repeat(N)));
    expect(result).toEqual([]);
    expect(ms).toBeLessThan(1000);
  });

  it("unclosed <Period> finishes in linear time", () => {
    const xml =
      "<TimeSeries><psrType>B01</psrType>" + "<Period>".repeat(N) + "</TimeSeries>";
    const { result, ms } = timed(() => parseEntsoeXml(xml));
    expect(result).toEqual([]);
    expect(ms).toBeLessThan(1000);
  });

  const period = (start: string, qty: number) =>
    `<Period><timeInterval><start>${start}</start></timeInterval>` +
    `<resolution>PT60M</resolution>` +
    `<Point><position>1</position><quantity>${qty}</quantity></Point></Period>`;

  it("a stray unclosed <Period> drops only itself", () => {
    const xml =
      `<TimeSeries><psrType>B14</psrType>${period("2026-05-13T10:00Z", 5)}<Period>stray</TimeSeries>` +
      `<TimeSeries><psrType>B05</psrType>${period("2026-05-13T11:00Z", 7)}</TimeSeries>`;
    expect(parseEntsoeXml(xml)).toEqual([
      {
        psrType: "B14",
        periods: [
          { start: "2026-05-13T10:00Z", resolutionMin: 60, points: [{ position: 1, quantity: 5 }] },
        ],
      },
      {
        psrType: "B05",
        periods: [
          { start: "2026-05-13T11:00Z", resolutionMin: 60, points: [{ position: 1, quantity: 7 }] },
        ],
      },
    ]);
  });

  // Pins the lazy-regex semantics the scan replaced: each open pairs with
  // the nearest close after it, and the first match wins.
  it("an unclosed <TimeSeries> pairs with the next close; the first psrType wins", () => {
    const xml =
      `<TimeSeries><psrType>B01</psrType>` +
      `<TimeSeries><psrType>B14</psrType>${period("2026-05-13T10:00Z", 5)}</TimeSeries>`;
    expect(parseEntsoeXml(xml)).toEqual([
      {
        psrType: "B01",
        periods: [
          { start: "2026-05-13T10:00Z", resolutionMin: 60, points: [{ position: 1, quantity: 5 }] },
        ],
      },
    ]);
  });

  it("an unclosed <Period> before a valid one merges into a single period", () => {
    const xml =
      `<TimeSeries><psrType>B14</psrType><Period>stray${period("2026-05-13T10:00Z", 5)}</TimeSeries>`;
    expect(parseEntsoeXml(xml)).toEqual([
      {
        psrType: "B14",
        periods: [
          { start: "2026-05-13T10:00Z", resolutionMin: 60, points: [{ position: 1, quantity: 5 }] },
        ],
      },
    ]);
  });

  it("an Acknowledgement reports the first <text>, empty when it is empty", () => {
    const ack = (body: string) => `<Acknowledgement_MarketDocument><Reason>${body}</Reason>`;
    expect(() => parseEntsoeXml(ack("<text> first </text><text>second</text>"))).toThrow(
      /Acknowledgement document: first$/,
    );
    expect(() => parseEntsoeXml(ack("<text></text><text>second</text>"))).toThrow(
      /Acknowledgement document: $/,
    );
  });
});

describe("entsoeFeed (A75 fixture)", () => {
  // Fixture mix per hour: nuclear 1000 MW (12 g) + coal 1000 MW (820 g)
  // → (12 + 820) / 2 = 416 g — EXCEPT the coal gap hour (position 3 →
  // period start 10:00Z + 2h = 12:00Z), which is nuclear-only → 12 g.
  // The consumption series (8000 MW hydro-factored) would drag every
  // hour to ~102 g if it were wrongly counted as generation.
  const expected = (hourOfDay: number): number => (hourOfDay === 12 ? 12 : 416);

  it("excludes consumption and keeps the position gap from shifting later hours", async () => {
    globalThis.fetch = (async () =>
      new Response(fixture("entsoe-a75-de.xml"), {
        status: 200,
      })) as typeof fetch;

    const fc = await entsoeFeed("test-token").fetchForecast("DE", 24);
    expect(fc.source).toBe("entsoe");
    expect(fc.kind).toBe("persistence");
    expect(fc.entries.length).toBe(24);
    for (const e of fc.entries) {
      const hod = new Date(e.datetime).getUTCHours();
      expect(
        e.carbonIntensityGCo2PerKwh,
        `hour-of-day ${hod} (${e.datetime})`,
      ).toBe(expected(hod));
    }
    // Regression pin for the index-based bucketing bug: ignoring
    // <position> shifted every post-gap coal hour one hour earlier,
    // yielding 416 at hod 12 and 12 (nuclear-only) at hod 9.
    const at = (hod: number) =>
      fc.entries.find((e) => new Date(e.datetime).getUTCHours() === hod)!;
    expect(at(12).carbonIntensityGCo2PerKwh).toBe(12);
    expect(at(9).carbonIntensityGCo2PerKwh).toBe(416);
  });

  it("falls back to mock (via throw) on an Acknowledgement document", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    globalThis.fetch = (async () =>
      new Response(fixture("entsoe-acknowledgement.xml"), {
        status: 200,
      })) as typeof fetch;

    const fc = await entsoeFeed("test-token").fetchForecast("DE", 6);
    expect(fc.source).toBe("mock");
    expect(fc.entries.length).toBe(6);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Acknowledgement"),
    );
  });
});

// ---------------------------------------------------------------------------
// EIA fuel mix — publication-lag phase regression
// ---------------------------------------------------------------------------

describe("eiaFeed (lagged fuel-mix fixture)", () => {
  // Fixture: 24 hourly observations 2026-05-13T22 .. 2026-05-14T21 UTC,
  // with COL = hod MW and NUC = (24 - hod) MW, so each observation's
  // intensity uniquely encodes its hour-of-day:
  const expected = (hourOfDay: number): number =>
    Math.round((hourOfDay * 820 + (24 - hourOfDay) * 12) / 24);

  it("serves future hours by hour-of-day despite a 4h publication lag", async () => {
    // "Now" is 4h after the last observation (2026-05-14T21).
    fakeNow("2026-05-15T01:20:00Z");
    globalThis.fetch = (async () =>
      new Response(fixture("eia-fuel-mix-lagged.json"), {
        status: 200,
      })) as typeof fetch;

    const fc = await eiaFeed("test-key").fetchForecast("US-CAL-CISO", 72);
    expect(fc.source).toBe("eia");
    expect(fc.kind).toBe("persistence");
    expect(fc.entries.length).toBe(72);
    expect(fc.entries[0]?.datetime).toBe("2026-05-15T01:00:00.000Z");
    for (const e of fc.entries) {
      const hod = new Date(e.datetime).getUTCHours();
      expect(
        e.carbonIntensityGCo2PerKwh,
        `hour-of-day ${hod} (${e.datetime})`,
      ).toBe(expected(hod));
    }
    // Phase pin: the old tiling anchored the last-24 tail at wall-clock
    // "now", so the 01:00 slot got the 4h-stale 22:00 observation (753)
    // instead of the real 01:00 observation (46).
    expect(fc.entries[0]?.carbonIntensityGCo2PerKwh).toBe(expected(1)); // 46
    expect(fc.entries[0]?.carbonIntensityGCo2PerKwh).not.toBe(expected(22)); // 753
  });

  it("serves EIA when the last 19 hours are not yet published", async () => {
    // Production 2026-10-17: EIA's newest row was 19h old, so a 30h window
    // held only 11 hours-of-day and every US ISO fell back to the mock.
    fakeNow("2026-10-17T22:19:00Z");
    globalThis.fetch = (async (input: unknown) => {
      const params = new URL(String(input)).searchParams;
      const start = Date.parse(`${params.get("start")}:00:00Z`);
      const lastPublished = Date.parse("2026-10-17T03:00:00Z");
      const data = [];
      for (let t = start; t <= lastPublished; t += 3_600_000) {
        const period = new Date(t).toISOString().slice(0, 13);
        data.push({ period, respondent: "CISO", fueltype: "NG", value: 100 });
      }
      return new Response(JSON.stringify({ response: { data } }), { status: 200 });
    }) as typeof fetch;

    const fc = await eiaFeed("test-key").fetchForecast("US-CAL-CISO", 24);
    expect(fc.source).toBe("eia");
  });

  it("degrades to mock when history covers fewer than 24 hours-of-day", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const full = JSON.parse(fixture("eia-fuel-mix-lagged.json")) as {
      response: { data: unknown[] };
    };
    // Keep only the first 10 hours (2 rows per hour) — a short tail must
    // not be tiled onto a 24h diurnal cycle.
    full.response.data = full.response.data.slice(0, 20);
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(full), { status: 200 })) as typeof fetch;

    const fc = await eiaFeed("test-key").fetchForecast("US-CAL-CISO", 24);
    expect(fc.source).toBe("mock");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("hours-of-day"),
    );
  });
});

// ---------------------------------------------------------------------------
// UK Carbon Intensity — 72h pagination + top-of-hour alignment
// ---------------------------------------------------------------------------

describe("ukCarbonIntensityFeed (two-page fw48h fixtures)", () => {
  // Half-hour value at index j (from 2026-05-14T12:00Z) is 10*j, so the
  // hourly bucket i must average to 20*i + 5. Page 1 leads with a
  // misaligned 11:30 period valued 9999; page 2 starts one period early,
  // overlapping page 1's last period.
  function stubPages(): ReturnType<typeof vi.fn> {
    const stub = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/intensity/2026-05-14T12:00Z/fw48h")) {
        return new Response(fixture("uk-fw48h-page1.json"), { status: 200 });
      }
      if (url.includes("/intensity/2026-05-16T12:00Z/fw48h")) {
        return new Response(fixture("uk-fw48h-page2.json"), { status: 200 });
      }
      throw new Error(`unexpected URL: ${url}`);
    });
    globalThis.fetch = stub as unknown as typeof fetch;
    return stub;
  }

  it("fetches a second page for horizons beyond 48h and returns 72 aligned buckets", async () => {
    fakeNow("2026-05-14T12:05:00Z");
    const stub = stubPages();

    const fc = await ukCarbonIntensityFeed().fetchForecast("GB", 72);
    expect(stub).toHaveBeenCalledTimes(2);
    expect(String(stub.mock.calls[1]?.[0])).toContain(
      "/intensity/2026-05-16T12:00Z/fw48h",
    );

    expect(fc.source).toBe("ukCarbonIntensity");
    expect(fc.kind).toBe("forecast");
    expect(fc.entries.length).toBe(72);
    for (let i = 0; i < fc.entries.length; i++) {
      const e = fc.entries[i]!;
      const t = new Date(e.datetime);
      // Buckets must be aligned to [HH:00, HH+1:00) and hourly-contiguous.
      expect(t.getUTCMinutes(), e.datetime).toBe(0);
      expect(e.datetime).toBe(
        new Date(Date.UTC(2026, 4, 14, 12 + i)).toISOString(),
      );
      expect(e.carbonIntensityGCo2PerKwh, e.datetime).toBe(20 * i + 5);
    }
    expect(fc.entries[71]?.datetime).toBe("2026-05-17T11:00:00.000Z");
    expect(fc.entries[71]?.carbonIntensityGCo2PerKwh).toBe(1425);
  });

  it("drops the misaligned leading half-period instead of skewing bucket 0", async () => {
    fakeNow("2026-05-14T12:05:00Z");
    stubPages();

    const fc = await ukCarbonIntensityFeed().fetchForecast("GB", 72);
    // If the 11:30 period (9999) were paired in, bucket 0 would be
    // avg(9999, 0) ≈ 5000 at 11:30 instead of avg(0, 10) = 5 at 12:00.
    expect(fc.entries[0]?.datetime).toBe("2026-05-14T12:00:00.000Z");
    expect(fc.entries[0]?.carbonIntensityGCo2PerKwh).toBe(5);
  });

  it("stays on a single page for horizons within 48h", async () => {
    fakeNow("2026-05-14T12:05:00Z");
    const stub = stubPages();

    const fc = await ukCarbonIntensityFeed().fetchForecast("GB", 48);
    expect(stub).toHaveBeenCalledTimes(1);
    expect(fc.entries.length).toBe(48);
    expect(fc.entries[0]?.carbonIntensityGCo2PerKwh).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// UTC-hour floor — UK / EIA / ENTSO-E request windows and forecast start
// must not depend on the host time zone.
// ---------------------------------------------------------------------------

describe("feed hour floor is UTC whatever the host time zone", () => {
  // 01:30Z on 2026-10-25 is inside Kyiv's repeated DST hour (03:30 local,
  // second pass; a local floor resolves 03:00 to the first pass = 00:00Z).
  // Kolkata is UTC+05:30, so a local floor lands on 01:30Z.
  const NOW = "2026-10-25T01:30:00Z";
  const ZONES: ReadonlyArray<readonly [string, number]> = [
    ["Asia/Kolkata", -330],
    ["Europe/Kyiv", -120],
  ];

  /** Run `body` under each zone, restoring TZ afterwards. */
  async function eachZone(body: (tz: string) => Promise<void>): Promise<void> {
    const prevTz = process.env.TZ;
    try {
      for (const [tz, offsetMin] of ZONES) {
        process.env.TZ = tz;
        // Guard: the zone must actually take effect, or the test is vacuous.
        expect(new Date(NOW).getTimezoneOffset(), tz).toBe(offsetMin);
        await body(tz);
      }
    } finally {
      if (prevTz === undefined) delete process.env.TZ;
      else process.env.TZ = prevTz;
    }
  }

  /** Stub fetch to serve `body` for every URL and record the URLs. */
  function captureFetch(body: string): string[] {
    const urls: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      urls.push(String(input));
      return new Response(body, { status: 200 });
    }) as typeof fetch;
    return urls;
  }

  it("UK requests fw48h from the UTC hour", async () => {
    fakeNow(NOW);
    await eachZone(async (tz) => {
      const urls = captureFetch(fixture("uk-fw48h-page1.json"));
      await ukCarbonIntensityFeed().fetchForecast("GB", 24);
      expect(urls[0], tz).toContain("/intensity/2026-10-25T01:00Z/fw48h");
    });
  });

  it("EIA ends its window and starts the forecast on the UTC hour", async () => {
    fakeNow(NOW);
    await eachZone(async (tz) => {
      const urls = captureFetch(fixture("eia-fuel-mix-lagged.json"));
      const fc = await eiaFeed("test-key").fetchForecast("US-CAL-CISO", 24);
      const params = new URL(urls[0]!).searchParams;
      expect(params.get("end"), tz).toBe("2026-10-25T01");
      expect(params.get("start"), tz).toBe("2026-10-22T01");
      expect(fc.source, tz).toBe("eia");
      expect(fc.entries[0]?.datetime, tz).toBe("2026-10-25T01:00:00.000Z");
    });
  });

  it("ENTSO-E ends its period and starts the forecast on the UTC hour", async () => {
    fakeNow(NOW);
    await eachZone(async (tz) => {
      const urls = captureFetch(fixture("entsoe-a75-de.xml"));
      const fc = await entsoeFeed("test-token").fetchForecast("DE", 24);
      const params = new URL(urls[0]!).searchParams;
      expect(params.get("periodEnd"), tz).toBe("202610250100");
      expect(params.get("periodStart"), tz).toBe("202610240100");
      expect(fc.source, tz).toBe("entsoe");
      expect(fc.entries[0]?.datetime, tz).toBe("2026-10-25T01:00:00.000Z");
    });
  });
});

// ---------------------------------------------------------------------------
// WattTime v3 — marginal (co2_moer) forecast, unit conversion, auth refresh,
// fallthrough + precedence-over-EIA routing (roadmap item 2).
// ---------------------------------------------------------------------------

describe("wattTimeFeed (v3 marginal MOER)", () => {
  const CREDS = { username: "u", password: "p" } as const;
  const LOGIN_URL = "https://api.watttime.org/login";
  const FORECAST_URL = "https://api.watttime.org/v3/forecast";

  /** A stub fallback feed with a distinguishable source, for fallthrough. */
  function markerFallback(source = "eia"): GridFeed {
    return {
      source: source as GridFeed["source"],
      fetchForecast: vi.fn(async (region: string, hours: number) => ({
        region,
        source: source as GridFeed["source"],
        generatedAt: "2026-05-14T12:00:00.000Z",
        kind: "persistence" as const,
        entries: Array.from({ length: hours }, (_, i) => ({
          datetime: new Date(Date.UTC(2026, 4, 14, 12 + i)).toISOString(),
          carbonIntensityGCo2PerKwh: 111,
          band: "clean" as const,
        })),
      })),
    };
  }

  it("logs in, fetches co2_moer, and converts lbs/MWh → gCO2/kWh into hourly buckets", async () => {
    const login = vi.fn();
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (url.startsWith(LOGIN_URL)) {
        login();
        return new Response(fixture("watttime-login.json"), { status: 200 });
      }
      if (url.startsWith(FORECAST_URL)) {
        // Assert the request targeted the co2_moer signal + mapped region.
        expect(url).toContain("signal_type=co2_moer");
        expect(url).toContain("region=CAISO_NORTH");
        return new Response(fixture("watttime-forecast-caiso.json"), {
          status: 200,
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    }) as typeof fetch;

    const fc = await wattTimeFeed(CREDS).fetchForecast("US-CAL-CISO", 24);
    expect(fc.source).toBe("wattTime");
    expect(fc.kind).toBe("forecast");
    expect(fc.signalType).toBe("marginal");
    expect(fc.entries.length).toBe(2);
    // 12:00Z bucket avg(900,1100)=1000 lbs/MWh × 453.592/1000 = 453.592 → 454.
    expect(fc.entries[0]?.datetime).toBe("2026-05-14T12:00:00.000Z");
    expect(fc.entries[0]?.carbonIntensityGCo2PerKwh).toBe(454);
    expect(fc.entries[0]?.signalType).toBe("marginal");
    // 13:00Z bucket avg(600,400)=500 lbs/MWh × 453.592/1000 = 226.796 → 227.
    expect(fc.entries[1]?.carbonIntensityGCo2PerKwh).toBe(227);
    expect(login).toHaveBeenCalledTimes(1);
  });

  it("caches the bearer token across calls (single login for two forecasts)", async () => {
    const login = vi.fn();
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (url.startsWith(LOGIN_URL)) {
        login();
        return new Response(fixture("watttime-login.json"), { status: 200 });
      }
      return new Response(fixture("watttime-forecast-caiso.json"), {
        status: 200,
      });
    }) as typeof fetch;

    const feed = wattTimeFeed(CREDS);
    await feed.fetchForecast("US-CAL-CISO", 24);
    await feed.fetchForecast("US-CAL-CISO", 24);
    expect(login).toHaveBeenCalledTimes(1);
  });

  it("re-logs in exactly once on a 401 and retries the forecast", async () => {
    const login = vi.fn();
    let forecastCalls = 0;
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (url.startsWith(LOGIN_URL)) {
        login();
        return new Response(fixture("watttime-login.json"), { status: 200 });
      }
      forecastCalls += 1;
      // First forecast attempt: token rejected. Second: succeeds.
      if (forecastCalls === 1) {
        return new Response("unauthorized", { status: 401 });
      }
      return new Response(fixture("watttime-forecast-caiso.json"), {
        status: 200,
      });
    }) as typeof fetch;

    const fc = await wattTimeFeed(CREDS).fetchForecast("US-CAL-CISO", 24);
    expect(fc.source).toBe("wattTime");
    expect(fc.entries[0]?.carbonIntensityGCo2PerKwh).toBe(454);
    // One initial login + one refresh after the 401 = 2.
    expect(login).toHaveBeenCalledTimes(2);
    expect(forecastCalls).toBe(2);
  });

  it("falls through to the fallback feed on a persistent forecast error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (url.startsWith(LOGIN_URL)) {
        return new Response(fixture("watttime-login.json"), { status: 200 });
      }
      // 500 is not a 401/403, so no refresh — straight to fallthrough.
      return new Response("boom", { status: 500 });
    }) as typeof fetch;

    const fallback = markerFallback("eia");
    const fc = await wattTimeFeed({ ...CREDS, fallback }).fetchForecast(
      "US-CAL-CISO",
      24,
    );
    expect(fc.source).toBe("eia");
    expect(fc.entries[0]?.carbonIntensityGCo2PerKwh).toBe(111);
    expect(fallback.fetchForecast).toHaveBeenCalledWith("US-CAL-CISO", 24);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("watttime"));
  });

  it("routes zones WattTime does not cover straight to the fallback (no login)", async () => {
    const login = vi.fn();
    globalThis.fetch = (async (input: unknown) => {
      if (String(input).startsWith(LOGIN_URL)) login();
      return new Response(fixture("watttime-login.json"), { status: 200 });
    }) as typeof fetch;

    const fallback = markerFallback("entsoe");
    const fc = await wattTimeFeed({ ...CREDS, fallback }).fetchForecast(
      "FR",
      24,
    );
    expect(fc.source).toBe("entsoe");
    expect(login).not.toHaveBeenCalled();
  });

  it("with no credentials the feed IS the fallback (precedence wiring is inert)", async () => {
    const fallback = markerFallback("eia");
    // No username/password, no env — must collapse to the fallback so
    // buildDefaultGridFeed's wattTimeFeed({fallback: eiaFeed()}) === eiaFeed().
    const feed = wattTimeFeed({ fallback });
    expect(feed).toBe(fallback);
    const fc = await feed.fetchForecast("US-CAL-CISO", 24);
    expect(fc.source).toBe("eia");
  });

  it("takes precedence over EIA for a covered zone when credentials are present", async () => {
    // Precedence-over-EIA routing test: same zone, same fallback (EIA),
    // WattTime succeeds → the marginal WattTime forecast wins.
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (url.startsWith(LOGIN_URL)) {
        return new Response(fixture("watttime-login.json"), { status: 200 });
      }
      return new Response(fixture("watttime-forecast-caiso.json"), {
        status: 200,
      });
    }) as typeof fetch;

    const eia = markerFallback("eia");
    const fc = await wattTimeFeed({ ...CREDS, fallback: eia }).fetchForecast(
      "US-CAL-CISO",
      24,
    );
    expect(fc.source).toBe("wattTime");
    expect(fc.signalType).toBe("marginal");
    // EIA fallback must NOT have been consulted when WattTime succeeds.
    expect(eia.fetchForecast).not.toHaveBeenCalled();
  });
});
