import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { REGION_FLOORS } from "../src/data/tables.generated.js";
import {
  APPROXIMATE_TIMEZONE_REGION,
  FALLBACK_REGION,
  REGION_CATALOG,
  catalogZone,
  closestRegions,
  guessRegionFromTimeZone,
  ignoredRegionMessage,
  loadRegionSetting,
  regionForTimezone,
  resolveRegion,
} from "../src/region.js";

const UA_NOTE =
  "No Ukrainian grid data yet; using Poland (PL), the nearest grid in the same synchronous area.";

describe("regionForTimezone", () => {
  it("maps known timezones to grid regions", () => {
    expect(regionForTimezone("Europe/London")).toBe("GB");
    expect(regionForTimezone("Europe/Paris")).toBe("FR");
    expect(regionForTimezone("Europe/Berlin")).toBe("DE");
    expect(regionForTimezone("America/Los_Angeles")).toBe("US-CAL-CISO");
    expect(regionForTimezone("America/New_York")).toBe("US-MIDA-PJM");
  });

  it("maps every time zone added for the region setting", () => {
    const added: Record<string, string> = {
      "Europe/Warsaw": "PL",
      "Europe/Vienna": "AT",
      "Europe/Madrid": "ES",
      "Europe/Amsterdam": "NL",
      "Europe/Brussels": "BE",
      "Europe/Dublin": "IE",
      "Europe/Helsinki": "FI",
      "Asia/Seoul": "KR",
      "Asia/Singapore": "SG",
      "Australia/Sydney": "AU-NSW",
      "Africa/Johannesburg": "ZA",
      "Asia/Dubai": "AE",
      "Pacific/Auckland": "NZ",
    };
    for (const [tz, zone] of Object.entries(added)) {
      expect(regionForTimezone(tz), tz).toBe(zone);
    }
  });

  it("returns undefined for unmapped or multi-grid timezones", () => {
    expect(regionForTimezone("Antarctica/Troll")).toBeUndefined();
    expect(regionForTimezone("not-a-timezone")).toBeUndefined();
    expect(regionForTimezone("Europe/Oslo")).toBeUndefined();
    expect(regionForTimezone("America/Chicago")).toBeUndefined();
    expect(regionForTimezone("constructor")).toBeUndefined();
  });

  it("maps only to catalog zones", () => {
    for (const tz of ["Europe/London", "Europe/Kyiv", "Pacific/Auckland"]) {
      expect(REGION_CATALOG[regionForTimezone(tz) ?? ""], tz).toBeDefined();
    }
  });
});

describe("guessRegionFromTimeZone", () => {
  it.each(["Europe/Kyiv", "Europe/Kiev", "Europe/Uzhgorod", "Europe/Zaporozhye"])(
    "%s → PL, approximate for UA",
    (tz) => {
      expect(guessRegionFromTimeZone(tz)).toEqual({
        region: "PL",
        approximate: { country: "UA", note: UA_NOTE },
      });
    },
  );

  it("an exact entry has no approximation", () => {
    expect(guessRegionFromTimeZone("Europe/Warsaw")).toEqual({ region: "PL" });
    expect(guessRegionFromTimeZone(undefined)).toBeUndefined();
  });
});

describe("resolveRegion (object form)", () => {
  const all = {
    requested: "US-TEX-ERCO",
    configured: { value: "DE", source: "env" as const },
    setting: "FR",
    timeZone: "Europe/Warsaw",
  };

  it("each layer wins over every lower one", () => {
    expect(resolveRegion(all)).toEqual({ region: "US-TEX-ERCO", source: "flag" });
    expect(resolveRegion({ ...all, requested: undefined })).toEqual({ region: "DE", source: "env" });
    expect(
      resolveRegion({ ...all, requested: undefined, configured: { value: "DE", source: "config" } }),
    ).toEqual({ region: "DE", source: "config" });
    expect(resolveRegion({ ...all, requested: undefined, configured: undefined })).toEqual({
      region: "FR",
      source: "setting",
    });
    expect(
      resolveRegion({ ...all, requested: undefined, configured: undefined, setting: undefined }),
    ).toEqual({ region: "PL", source: "timezone", timeZone: "Europe/Warsaw" });
    expect(resolveRegion({ timeZone: "America/Chicago" })).toEqual({
      region: FALLBACK_REGION,
      source: "fallback",
      timeZone: "America/Chicago",
    });
  });

  it("an empty configured value falls through", () => {
    expect(
      resolveRegion({ configured: { value: "", source: "env" }, setting: "FR", timeZone: "Europe/London" }),
    ).toEqual({ region: "FR", source: "setting" });
  });

  it("AE1: Kyiv with no setting resolves PL, approximate", () => {
    expect(resolveRegion({ timeZone: "Europe/Kyiv" })).toEqual({
      region: "PL",
      source: "timezone",
      timeZone: "Europe/Kyiv",
      approximate: { country: "UA", note: UA_NOTE },
    });
  });

  it("AE5: a stored zone outside the catalog is ignored and reported", () => {
    expect(resolveRegion({ setting: "XX", timeZone: "Europe/Paris" })).toEqual({
      region: "FR",
      source: "timezone",
      timeZone: "Europe/Paris",
      ignored: "XX",
    });
    expect(resolveRegion({ setting: "XX", timeZone: "Antarctica/Troll" })).toMatchObject({
      region: "GB",
      source: "fallback",
      ignored: "XX",
    });
    expect(ignoredRegionMessage("XX")).toBe("Stored region XX is not supported; ignored.");
  });

  it("a stored zone is matched case-insensitively and canonicalised", () => {
    expect(resolveRegion({ setting: " fr ", timeZone: "Europe/London" })).toEqual({
      region: "FR",
      source: "setting",
    });
    expect(resolveRegion({ setting: "us-cal-ciso" }).region).toBe("US-CAL-CISO");
  });

  it("an explicit undefined time zone skips the host guess", () => {
    expect(resolveRegion({ timeZone: undefined })).toEqual({ region: "GB", source: "fallback" });
  });
});

describe("resolveRegion (positional form)", () => {
  it("an explicit request region wins over everything", () => {
    expect(resolveRegion("US-TEX-ERCO", "GB")).toEqual({ region: "US-TEX-ERCO", source: "flag" });
  });

  it("reports a configured default as config", () => {
    expect(resolveRegion(undefined, "FR")).toEqual({ region: "FR", source: "config" });
  });

  it("falls back to a timezone guess or FALLBACK_REGION", () => {
    const r = resolveRegion(undefined, undefined);
    expect(["timezone", "fallback"]).toContain(r.source);
    if (r.source === "fallback") expect(r.region).toBe(FALLBACK_REGION);
  });

  it("treats an empty-string request/default as absent", () => {
    expect(resolveRegion("", "DE")).toEqual({ region: "DE", source: "config" });
  });

  it("treats a null request from an unvalidated tool call as absent", () => {
    expect(resolveRegion(null as unknown as string, "DE")).toEqual({ region: "DE", source: "config" });
  });
});

describe("loadRegionSetting", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-region-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("missing file → undefined", () => {
    expect(loadRegionSetting(join(dir, "config"))).toBeUndefined();
  });

  it("reads the key past comments, other keys and quotes", () => {
    const path = join(dir, "config");
    writeFileSync(
      path,
      '# region\nTIDEGAP_USAGE=on\n# TIDEGAP_DEFAULT_REGION=DE\nTIDEGAP_DEFAULT_REGION="fr"\n',
    );
    expect(loadRegionSetting(path)).toBe("fr");
  });

  it("missing or empty key → undefined", () => {
    const path = join(dir, "config");
    writeFileSync(path, "TIDEGAP_USAGE=on\nTIDEGAP_DEFAULT_REGION=\n");
    expect(loadRegionSetting(path)).toBeUndefined();
  });

  it.skipIf(process.getuid?.() === 0)("unreadable file → undefined", () => {
    const path = join(dir, "config");
    writeFileSync(path, "TIDEGAP_DEFAULT_REGION=FR\n");
    chmodSync(path, 0o000);
    expect(loadRegionSetting(path)).toBeUndefined();
  });

  it("a directory at the path → undefined", () => {
    expect(loadRegionSetting(dir)).toBeUndefined();
  });
});

describe("catalog", () => {
  it("has the 31 zones of the synthetic curve, each fully described", () => {
    expect(Object.keys(REGION_CATALOG)).toEqual(Object.keys(REGION_FLOORS));
    expect(Object.keys(REGION_CATALOG)).toHaveLength(31);
    for (const [zone, e] of Object.entries(REGION_CATALOG)) {
      expect(e.name, zone).not.toBe("");
      expect(e.country, zone).toMatch(/^[A-Z]{2}$/);
      expect(e.countryName, zone).not.toBe("");
      expect(e.operator, zone).not.toBe("");
    }
  });

  it("catalogZone is case-insensitive and rejects unknown zones", () => {
    expect(catalogZone("pl")).toBe("PL");
    expect(catalogZone("it-no")).toBe("IT-NO");
    expect(catalogZone("UA")).toBeUndefined();
    expect(catalogZone("constructor")).toBeUndefined();
    expect(catalogZone(undefined)).toBeUndefined();
  });

  it("every approximate target is a catalog zone", () => {
    for (const { region } of Object.values(APPROXIMATE_TIMEZONE_REGION)) {
      expect(catalogZone(region)).toBe(region);
    }
  });
});

describe("closestRegions", () => {
  it("AE4: a country code with an approximate target returns only that target", () => {
    expect(closestRegions("UA")).toEqual(["PL"]);
    expect(closestRegions("ua")).toEqual(["PL"]);
  });

  it("prefix matches on code, name, country code or country name", () => {
    expect(closestRegions("pol")).toEqual(["PL"]);
    expect(closestRegions("US-N")).toEqual(["US-NE-ISNE", "US-NY-NYIS", "US-NW-BPAT"]);
    expect(closestRegions("Calif")).toEqual(["US-CAL-CISO"]);
    expect(closestRegions("japan")).toEqual(["JP-TK"]);
  });

  it("edit distance, nearest first, catalog order on ties", () => {
    expect(closestRegions("fx")[0]).toBe("FR");
    expect(closestRegions("fx")).toEqual(["FR", "FI"]);
    expect(closestRegions("US-TEX-ERCX")).toEqual(["US-TEX-ERCO"]);
  });

  it("short inputs only match within edit distance 1 (no unrelated 2-letter zones)", () => {
    expect(closestRegions("XX")).toEqual([]);
    expect(closestRegions("ZZ")).toEqual(["ZA", "NZ"]);
  });

  it("nothing close → empty", () => {
    expect(closestRegions("zzzzzzzz")).toEqual([]);
    expect(closestRegions("  ")).toEqual([]);
  });
});
