/**
 * Guards in the SSOT data generator (scripts/gen-data-validate.mjs): an
 * unknown lifecycle status, a price row on a retired model and a region
 * catalog that differs from the floors or the website's zones all throw.
 */
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs script without type declarations
import { validateTables } from "../../../scripts/gen-data-validate.mjs";

const coeff = { whPerInputToken: 0.001, whPerOutputToken: 0.003, source: "test" };
const price = { inUsdPerMtok: 1, outUsdPerMtok: 5, asOf: "2026-09-01", source: "test" };

describe("gen-data validateTables", () => {
  it("accepts valid tables", () => {
    expect(() =>
      validateTables({
        energy: { coefficients: { live: coeff, old: { ...coeff, status: "retired" } }, families: [] },
        prices: { prices: { live: price } },
      }),
    ).not.toThrow();
  });

  it("throws on an unknown status", () => {
    expect(() =>
      validateTables({
        energy: { coefficients: { m: { ...coeff, status: "retird" } }, families: [] },
        prices: { prices: {} },
      }),
    ).toThrow(/unknown status "retird"/);
  });

  it("throws on a price row for a retired model", () => {
    expect(() =>
      validateTables({
        energy: { coefficients: { m: { ...coeff, status: "retired" } }, families: [] },
        prices: { prices: { m: price } },
      }),
    ).toThrow(/belongs to a retired model/);
  });

  describe("region catalog", () => {
    const entry = { name: "France", country: "FR", countryName: "France", operator: "RTE" };
    const base = {
      energy: { coefficients: {}, families: [] },
      prices: { prices: {} },
    };
    const regions = (catalog: Record<string, unknown>) => ({
      regionFloors: { FR: 60, GB: 220 },
      regionCatalog: catalog,
    });

    it("accepts a catalog equal to the floors and the web zones", () => {
      expect(() =>
        validateTables({
          ...base,
          regions: regions({ FR: entry, GB: { ...entry, name: "Great Britain" } }),
          webZones: ["GB", "FR"],
        }),
      ).not.toThrow();
    });

    it("throws when the catalog misses a floor zone", () => {
      expect(() =>
        validateTables({ ...base, regions: regions({ FR: entry }), webZones: ["FR", "GB"] }),
      ).toThrow(/missing from catalog: GB/);
    });

    it("throws when the catalog differs from the web zones", () => {
      expect(() =>
        validateTables({
          ...base,
          regions: regions({ FR: entry, GB: entry }),
          webZones: ["FR", "GB", "PL"],
        }),
      ).toThrow(/apps\/web\/src\/lib\/regions\.ts — missing from catalog: PL/);
    });

    it("throws on an entry with an empty field", () => {
      expect(() =>
        validateTables({
          ...base,
          regions: regions({ FR: entry, GB: { ...entry, operator: " " } }),
          webZones: ["FR", "GB"],
        }),
      ).toThrow(/"GB" needs a non-empty "operator"/);
    });
  });
});
