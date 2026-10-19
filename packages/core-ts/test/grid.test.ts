import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  eiaFeed,
  entsoeFeed,
  mockGridFeed,
  multiSourceGridFeed,
  regionDataSource,
  ukCarbonIntensityFeed,
} from "../src/grid.js";
import { REGION_CATALOG } from "../src/region.js";

type FetchInput = Parameters<typeof fetch>[0];

const originalFetch = globalThis.fetch;

beforeEach(() => {
  // No-op default; individual tests replace with a stub.
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Build a UK API response covering N hourly buckets (each = 2x 30-min entries). */
function ukResponse(intensities: number[]) {
  const now = new Date();
  now.setUTCMinutes(0, 0, 0);
  const data: Array<{
    from: string;
    to: string;
    intensity: { forecast: number | null; actual: number | null };
  }> = [];
  intensities.forEach((g, i) => {
    const start = new Date(now.getTime() + i * 30 * 60 * 1000);
    const end = new Date(start.getTime() + 30 * 60 * 1000);
    data.push({
      from: start.toISOString(),
      to: end.toISOString(),
      intensity: { forecast: g, actual: null },
    });
  });
  return { data };
}

describe("ukCarbonIntensityFeed", () => {
  it("rolls 30-min intervals up to hourly buckets by averaging", async () => {
    // 4 30-min entries → 2 hourly. Averages: (100+200)/2=150, (300+400)/2=350.
    const stub = vi.fn(async (_input: FetchInput) =>
      new Response(JSON.stringify(ukResponse([100, 200, 300, 400])), {
        status: 200,
      }),
    );
    globalThis.fetch = stub as unknown as typeof fetch;

    const feed = ukCarbonIntensityFeed();
    const fc = await feed.fetchForecast("GB", 24);

    expect(fc.source).toBe("ukCarbonIntensity");
    expect(fc.region).toBe("GB");
    expect(fc.entries.length).toBe(2);
    expect(fc.entries[0]?.carbonIntensityGCo2PerKwh).toBe(150);
    expect(fc.entries[1]?.carbonIntensityGCo2PerKwh).toBe(350);
    expect(fc.entries[0]?.band).toBe("clean"); // 150 → 100..250 = clean
    expect(fc.entries[1]?.band).toBe("average"); // 350 → 250..450 = average
    expect(stub).toHaveBeenCalledOnce();
  });

  it("prefers `actual` over `forecast` when both populated", async () => {
    const stub = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              from: "2026-05-14T12:00Z",
              to: "2026-05-14T12:30Z",
              // Forecast=999 but actual=100. Should use actual.
              intensity: { forecast: 999, actual: 100 },
            },
            {
              from: "2026-05-14T12:30Z",
              to: "2026-05-14T13:00Z",
              intensity: { forecast: 999, actual: 200 },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    globalThis.fetch = stub as unknown as typeof fetch;

    const fc = await ukCarbonIntensityFeed().fetchForecast("GB", 24);
    expect(fc.entries[0]?.carbonIntensityGCo2PerKwh).toBe(150);
  });

  it("respects the `hours` argument as a cap on rolled-up buckets", async () => {
    // 8 entries → 4 hourly buckets, but we request only 2.
    const stub = vi.fn(async () =>
      new Response(
        JSON.stringify(ukResponse([10, 20, 30, 40, 50, 60, 70, 80])),
        { status: 200 },
      ),
    );
    globalThis.fetch = stub as unknown as typeof fetch;

    const fc = await ukCarbonIntensityFeed().fetchForecast("GB", 2);
    expect(fc.entries.length).toBe(2);
  });

  it("falls back to mock for non-GB zones", async () => {
    const stub = vi.fn();
    globalThis.fetch = stub as unknown as typeof fetch;

    const fc = await ukCarbonIntensityFeed().fetchForecast("US-CAL-CISO", 6);
    expect(fc.source).toBe("mock");
    expect(fc.region).toBe("US-CAL-CISO");
    expect(fc.entries.length).toBe(6);
    // Should not have hit the network at all.
    expect(stub).not.toHaveBeenCalled();
  });

  it("falls back to mock when the API returns non-OK", async () => {
    globalThis.fetch = (async () =>
      new Response("Service Unavailable", { status: 503 })) as typeof fetch;

    const fc = await ukCarbonIntensityFeed().fetchForecast("GB", 4);
    expect(fc.source).toBe("mock");
    expect(fc.entries.length).toBe(4);
  });

  it("falls back to mock when the API returns an empty data array", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
      })) as typeof fetch;

    const fc = await ukCarbonIntensityFeed().fetchForecast("GB", 4);
    expect(fc.source).toBe("mock");
  });

  it("falls back to mock when the network throws", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;

    const fc = await ukCarbonIntensityFeed().fetchForecast("GB", 4);
    expect(fc.source).toBe("mock");
  });
});

describe("multiSourceGridFeed", () => {
  it("routes per zone to the matching feed", async () => {
    const ukStub = vi.fn(async () => ({
      region: "GB",
      source: "ukCarbonIntensity" as const,
      generatedAt: new Date().toISOString(),
      entries: [],
    }));
    const emStub = vi.fn(async () => ({
      region: "US-CAL-CISO",
      source: "electricityMaps" as const,
      generatedAt: new Date().toISOString(),
      entries: [],
    }));

    const feed = multiSourceGridFeed({
      feeds: {
        GB: { source: "ukCarbonIntensity", fetchForecast: ukStub },
        "US-CAL-CISO": { source: "electricityMaps", fetchForecast: emStub },
      },
    });

    await feed.fetchForecast("GB", 12);
    expect(ukStub).toHaveBeenCalledOnce();
    expect(emStub).not.toHaveBeenCalled();

    await feed.fetchForecast("US-CAL-CISO", 12);
    expect(emStub).toHaveBeenCalledOnce();
  });

  it("uses the fallback feed for unmapped zones", async () => {
    const fallbackStub = vi.fn(async () => ({
      region: "FR",
      source: "mock" as const,
      generatedAt: new Date().toISOString(),
      entries: [],
    }));

    const feed = multiSourceGridFeed({
      feeds: { GB: { source: "mock", fetchForecast: vi.fn() } },
      fallback: { source: "mock", fetchForecast: fallbackStub },
    });

    await feed.fetchForecast("FR", 12);
    expect(fallbackStub).toHaveBeenCalledOnce();
  });

  it("defaults to mockGridFeed when no fallback is supplied", async () => {
    const feed = multiSourceGridFeed({ feeds: {} });
    const fc = await feed.fetchForecast("DE", 6);
    expect(fc.source).toBe("mock");
    expect(fc.entries.length).toBe(6);
  });
});

describe("eiaFeed", () => {
  it("returns mock when no API key is configured", async () => {
    delete process.env.TIDEGAP_EIA_API_KEY;
    const fc = await eiaFeed().fetchForecast("US-CAL-CISO", 6);
    expect(fc.source).toBe("mock");
    expect(fc.entries.length).toBe(6);
  });

  it("returns mock for zones EIA does not cover", async () => {
    const fc = await eiaFeed("test-key").fetchForecast("GB", 6);
    expect(fc.source).toBe("mock");
  });

  it("computes intensity from fuel mix via emission factors", async () => {
    // CAISO is half coal (820 g) + half nuclear (12 g) for every hour.
    // Expected weighted average: (820 + 12) / 2 = 416 → rounded 416.
    // The persistence synthesis requires all 24 hours-of-day covered.
    const rows: Array<{
      period: string;
      respondent: string;
      fueltype: string;
      value: number;
    }> = [];
    for (let h = 0; h < 24; h++) {
      const period = `2026-05-14T${String(h).padStart(2, "0")}`;
      rows.push({ period, respondent: "CISO", fueltype: "COL", value: 500 });
      rows.push({ period, respondent: "CISO", fueltype: "NUC", value: 500 });
    }
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ response: { data: rows } }), {
        status: 200,
      })) as typeof fetch;
    const fc = await eiaFeed("test-key").fetchForecast("US-CAL-CISO", 3);
    expect(fc.source).toBe("eia");
    expect(fc.entries.length).toBe(3);
    // Every entry should reflect the same fuel-mix intensity (416 g).
    for (const e of fc.entries) {
      expect(e.carbonIntensityGCo2PerKwh).toBe(416);
      expect(e.band).toBe("average"); // 250-450 → average
    }
  });

  it("skips fuel-types it does not recognise without crashing", async () => {
    // 24 hours of pure coal, plus one unknown fuel-type row that must be
    // ignored rather than crash or skew the weighted average.
    const rows: Array<{
      period: string;
      respondent: string;
      fueltype: string;
      value: number;
    }> = [
      { period: "2026-05-14T10", respondent: "CISO", fueltype: "XXX_UNKNOWN", value: 9999 },
    ];
    for (let h = 0; h < 24; h++) {
      const period = `2026-05-14T${String(h).padStart(2, "0")}`;
      rows.push({ period, respondent: "CISO", fueltype: "COL", value: 100 });
    }
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ response: { data: rows } }), {
        status: 200,
      })) as typeof fetch;
    const fc = await eiaFeed("test-key").fetchForecast("US-CAL-CISO", 1);
    // 100% coal at 820 g → intensity 820.
    expect(fc.entries[0]?.carbonIntensityGCo2PerKwh).toBe(820);
  });

  it("falls back to mock when EIA returns 5xx", async () => {
    globalThis.fetch = (async () =>
      new Response("oops", { status: 503 })) as typeof fetch;
    const fc = await eiaFeed("test-key").fetchForecast("US-CAL-CISO", 4);
    expect(fc.source).toBe("mock");
  });

  it("falls back to mock when EIA returns empty data", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ response: { data: [] } }), {
        status: 200,
      })) as typeof fetch;
    const fc = await eiaFeed("test-key").fetchForecast("US-CAL-CISO", 4);
    expect(fc.source).toBe("mock");
  });
});

describe("entsoeFeed", () => {
  it("returns mock when no security token is configured", async () => {
    delete process.env.TIDEGAP_ENTSOE_SECURITY_TOKEN;
    const fc = await entsoeFeed().fetchForecast("FR", 6);
    expect(fc.source).toBe("mock");
  });

  it("returns mock for zones ENTSO-E does not cover", async () => {
    const fc = await entsoeFeed("test-token").fetchForecast("US-CAL-CISO", 6);
    expect(fc.source).toBe("mock");
  });

  it("parses XML, computes intensity from psrType mix", async () => {
    // FR: 24 hours of all nuclear (B14, 12 g), at 1000 MW.
    // Expected: weighted avg = 12 g/kWh → very_clean.
    // The persistence synthesis requires all 24 hours-of-day covered.
    const points = Array.from(
      { length: 24 },
      (_, i) =>
        `<Point><position>${i + 1}</position><quantity>1000</quantity></Point>`,
    ).join("\n            ");
    const xml = `
      <GL_MarketDocument>
        <TimeSeries>
          <MktPSRType><psrType>B14</psrType></MktPSRType>
          <Period>
            <timeInterval><start>2026-05-14T00:00Z</start><end>2026-05-15T00:00Z</end></timeInterval>
            <resolution>PT60M</resolution>
            ${points}
          </Period>
        </TimeSeries>
      </GL_MarketDocument>`;
    globalThis.fetch = (async () =>
      new Response(xml, { status: 200 })) as typeof fetch;
    const fc = await entsoeFeed("test-token").fetchForecast("FR", 2);
    expect(fc.source).toBe("entsoe");
    expect(fc.entries[0]?.carbonIntensityGCo2PerKwh).toBe(12);
    expect(fc.entries[0]?.band).toBe("very_clean");
  });

  it("blends two psrTypes by weighted MWh", async () => {
    // DE: half coal (820 g) + half wind (11 g) at 1000 each, all 24 hours.
    // Expected: weighted avg = (1000*820 + 1000*11) / 2000 = 415.5 → rounded 416.
    const points = Array.from(
      { length: 24 },
      (_, i) =>
        `<Point><position>${i + 1}</position><quantity>1000</quantity></Point>`,
    ).join("\n            ");
    const period = `
          <Period>
            <timeInterval><start>2026-05-14T00:00Z</start><end>2026-05-15T00:00Z</end></timeInterval>
            <resolution>PT60M</resolution>
            ${points}
          </Period>`;
    const xml = `
      <GL_MarketDocument>
        <TimeSeries>
          <MktPSRType><psrType>B05</psrType></MktPSRType>
          ${period}
        </TimeSeries>
        <TimeSeries>
          <MktPSRType><psrType>B19</psrType></MktPSRType>
          ${period}
        </TimeSeries>
      </GL_MarketDocument>`;
    globalThis.fetch = (async () =>
      new Response(xml, { status: 200 })) as typeof fetch;
    const fc = await entsoeFeed("test-token").fetchForecast("DE", 2);
    expect(fc.entries[0]?.carbonIntensityGCo2PerKwh).toBe(416);
  });

  it("falls back to mock when ENTSO-E returns a 4xx (typical for bad token)", async () => {
    globalThis.fetch = (async () =>
      new Response("Unauthorized", { status: 401 })) as typeof fetch;
    const fc = await entsoeFeed("bad-token").fetchForecast("FR", 4);
    expect(fc.source).toBe("mock");
  });

  it("falls back to mock when XML has no TimeSeries blocks", async () => {
    const xml = "<GL_MarketDocument></GL_MarketDocument>";
    globalThis.fetch = (async () =>
      new Response(xml, { status: 200 })) as typeof fetch;
    const fc = await entsoeFeed("test-token").fetchForecast("FR", 4);
    expect(fc.source).toBe("mock");
  });
});

describe("mockGridFeed (unchanged baseline)", () => {
  it("returns deterministic entries given UTC-aligned hour", async () => {
    const a = await mockGridFeed().fetchForecast("US-CAL-CISO", 3);
    const b = await mockGridFeed().fetchForecast("US-CAL-CISO", 3);
    expect(a.entries.length).toBe(3);
    expect(a.entries[0]?.carbonIntensityGCo2PerKwh).toBe(
      b.entries[0]?.carbonIntensityGCo2PerKwh,
    );
  });

  it("starts on the current UTC hour whatever the local time zone", async () => {
    // 01:30 UTC on 2026-10-25 is inside Kyiv's repeated DST hour (03:xx
    // local twice); a local-time floor resolved it to 00:00 UTC. In a
    // half-hour zone a local floor lands on :30 UTC.
    const prevTz = process.env.TZ;
    try {
      for (const tz of ["Europe/Kyiv", "Asia/Kolkata", "America/Los_Angeles", "UTC"]) {
        process.env.TZ = tz;
        const f = await mockGridFeed(() => new Date("2026-10-25T01:30:00.000Z")).fetchForecast("DE", 2);
        expect(f.entries[0]?.datetime, tz).toBe("2026-10-25T01:00:00.000Z");
      }
    } finally {
      if (prevTz === undefined) delete process.env.TZ;
      else process.env.TZ = prevTz;
    }
  });
});

describe("regionDataSource", () => {
  it("names the feed each zone routes to", () => {
    expect(regionDataSource("GB")).toEqual({ id: "neso", label: "NESO Carbon Intensity API", live: true });
    expect(regionDataSource("FR")).toMatchObject({
      id: "entsoe",
      keyVar: "TIDEGAP_ENTSOE_SECURITY_TOKEN",
      live: false,
    });
    expect(regionDataSource("US-CAL-CISO")).toMatchObject({ id: "watttime-eia", live: false });
    expect(regionDataSource("JP-TK")).toMatchObject({
      id: "electricitymaps",
      keyVar: "TIDEGAP_ELECTRICITY_MAPS_API_KEY",
      live: false,
    });
    // No PL ENTSO-E zone until a live A75 answer for PL is verified.
    expect(regionDataSource("PL").id).toBe("electricitymaps");
    expect(regionDataSource("IT-NO").id).toBe("electricitymaps");
  });

  it("is live when the matching credential is passed", () => {
    expect(regionDataSource("FR", { entsoeSecurityToken: "t" }).live).toBe(true);
    expect(regionDataSource("FR", { electricityMapsApiKey: "k" }).live).toBe(false);
    expect(regionDataSource("US-MIDA-PJM", { eiaApiKey: "k" }).live).toBe(true);
    expect(regionDataSource("US-MIDA-PJM", { wattTimeUsername: "u" }).live).toBe(false);
    expect(
      regionDataSource("US-MIDA-PJM", { wattTimeUsername: "u", wattTimePassword: "p" }).live,
    ).toBe(true);
    expect(regionDataSource("NZ", { electricityMapsApiKey: "k" }).live).toBe(true);
  });

  it("every catalog zone has a data source", () => {
    for (const zone of Object.keys(REGION_CATALOG)) {
      expect(regionDataSource(zone).label, zone).not.toBe("");
    }
  });
});
