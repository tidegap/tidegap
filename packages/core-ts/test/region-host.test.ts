import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  checkRequestedRegion,
  regionRequestUrl,
  regionSettingReader,
  unknownRegionMessage,
} from "../src/index.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function configPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "tidegap-region-host-"));
  dirs.push(dir);
  return join(dir, "config");
}

describe("unknownRegionMessage", () => {
  it("AE4: names the closest zone and the prefilled request link", () => {
    expect(unknownRegionMessage("UA")).toBe(
      "Unknown zone UA. Closest: PL. Request a region: " +
        "https://github.com/tidegap/tidegap/issues/new?template=region_request.md&title=Region+request:+UA",
    );
  });

  it("omits Closest when nothing is near", () => {
    expect(unknownRegionMessage("XX")).toBe(`Unknown zone XX. Request a region: ${regionRequestUrl("XX")}`);
  });
});

describe("checkRequestedRegion", () => {
  it("normalizes a catalog zone, rejects a zone with no live feed", () => {
    expect(checkRequestedRegion("fr")).toEqual({ region: "FR", source: "flag" });
    expect(checkRequestedRegion("UA")).toEqual({ error: unknownRegionMessage("UA") });
    expect(checkRequestedRegion("IT")).toEqual({ error: unknownRegionMessage("IT") });
  });

  it("passes a non-catalog zone through when a credential gives it a live feed", () => {
    expect(checkRequestedRegion(" US-CAR-DUK ", { electricityMapsApiKey: "k" })).toEqual({
      region: "US-CAR-DUK",
      source: "flag",
    });
    expect(checkRequestedRegion("IT", { entsoeSecurityToken: "t" })).toEqual({ region: "IT", source: "flag" });
  });

  it("UK suggests GB", () => {
    expect(unknownRegionMessage("UK")).toMatch(/^Unknown zone UK\. Closest: GB\. /);
  });
});

describe("regionSettingReader", () => {
  it("re-reads only on change and warns once per change about an unsupported value", () => {
    const path = configPath();
    const warnings: string[] = [];
    const read = regionSettingReader({ path: () => path, warn: (m) => warnings.push(m) });

    expect(read()).toBeUndefined();
    writeFileSync(path, "TIDEGAP_DEFAULT_REGION=XX\n");
    expect(read()).toBe("XX");
    expect(read()).toBe("XX");
    expect(warnings).toEqual(["Stored region XX is not supported; ignored."]);

    writeFileSync(path, "TIDEGAP_DEFAULT_REGION=FR\n");
    utimesSync(path, new Date(), new Date(Date.now() + 5_000));
    expect(read()).toBe("FR");
    expect(warnings).toHaveLength(1);
  });
});
