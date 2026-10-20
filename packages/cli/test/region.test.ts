/** The region host module and `tidegap region` (region plan U2, R11-R14, AE1, AE4, AE5). */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mockGridFeed, REGION_CATALOG } from "@tidegap/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runRegionDetect, runRegionList, runRegionSet, runRegionShow } from "../src/commands/region.js";
import { actionScheduler } from "../src/commands/queue.js";
import { currentRegion, liveEnvRegion, parseRegionInput, regionGetter, regionView, storeRegion } from "../src/region.js";
import { envFilePath, loadEnvFileIntoProcess } from "../src/commands/env-file.js";

describe("region host module and command", () => {
  let dir: string;
  let configPath: string;
  const kyiv = () => ({ configPath, timeZone: "Europe/Kyiv" });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-region-"));
    configPath = join(dir, "config");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("covers AE1: Kyiv with nothing stored → PL, approximate, with the note", () => {
    const res = runRegionShow({}, kyiv());
    expect(res.exitCode).toBe(0);
    expect(res.out!.split("\n")[0]).toBe("PL Poland — guessed from time zone Europe/Kyiv (approximate: no UA data yet)");
    expect(res.out).toContain("No Ukrainian grid data yet");
    expect(res.out).toContain("template=region_request.md&title=Region+request:+UA");
    const json = JSON.parse(runRegionShow({ json: true }, kyiv()).out!);
    expect(json).toMatchObject({
      effective: "PL",
      source: "timezone",
      stored: null,
      timeZone: "Europe/Kyiv",
      approximate: { country: "UA" },
      dataSource: { id: "electricitymaps", live: false },
    });
  });

  it("set fr stores FR, keeps other lines and comments, writes 0600; set auto removes the key", () => {
    writeFileSync(configPath, "# my settings\nTIDEGAP_NOTIFY=0\n\nTIDEGAP_DEFAULT_REGION=GB\n");
    const res = runRegionSet("fr", {}, kyiv());
    expect(res.exitCode).toBe(0);
    expect(res.out!.split("\n").slice(0, 2)).toEqual(["Region set to France (FR).", "FR France — stored setting (tidegap region set)"]);
    expect(readFileSync(configPath, "utf8")).toBe("# my settings\nTIDEGAP_NOTIFY=0\n\nTIDEGAP_DEFAULT_REGION=FR\n");
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(runRegionSet("auto", {}, kyiv()).out!.split("\n")[0]).toBe("Stored region cleared; the time-zone guess applies.");
    expect(readFileSync(configPath, "utf8")).toBe("# my settings\nTIDEGAP_NOTIFY=0\n\n");
    expect(currentRegion(kyiv())).toMatchObject({ region: "PL", source: "timezone" });
  });

  it("covers AE4: set UA exits 2 with the closest zone and the request link; nothing is written", () => {
    const res = runRegionSet("UA", {}, kyiv());
    expect(res).toEqual({
      exitCode: 2,
      err: "Unknown zone UA. Closest: PL. Request a region: https://github.com/tidegap/tidegap/issues/new?template=region_request.md&title=Region+request:+UA",
    });
    expect(() => statSync(configPath)).toThrow();
    expect(runRegionSet("ua", {}, kyiv()).err).toContain("Closest: PL.");
    expect(runRegionSet("fx", {}, kyiv()).err).toMatch(/Closest: FR\b/);
  });

  it("accepts any case and the UK alias; refuses the rest", () => {
    expect(parseRegionInput("us-cal-ciso")).toBe("US-CAL-CISO");
    expect(parseRegionInput("uk")).toBe("GB");
    expect(parseRegionInput(" Auto ")).toBe("auto");
    expect(parseRegionInput("XX")).toBeUndefined();
    expect(storeRegion("uk", configPath)).toBe("GB");
    expect(readFileSync(configPath, "utf8")).toBe("TIDEGAP_DEFAULT_REGION=GB\n");
  });

  it("precedence: flag > env > setting > time zone, each with its source", () => {
    storeRegion("FR", configPath);
    expect(currentRegion({ ...kyiv(), flag: "de", env: "NL" })).toEqual({ region: "DE", source: "flag" });
    expect(currentRegion({ ...kyiv(), env: "nl" })).toEqual({ region: "NL", source: "env" });
    expect(currentRegion(kyiv())).toEqual({ region: "FR", source: "setting" });
    expect(currentRegion({ configPath: join(dir, "none"), timeZone: "America/Chicago" })).toMatchObject({ region: "GB", source: "fallback" });
  });

  it("an env getter is read on each call; liveEnvRegion follows the env file", () => {
    storeRegion("FR", configPath);
    let env: string | undefined = "DE";
    const read = regionGetter({ ...kyiv(), env: () => env });
    expect(read()).toBe("DE");
    env = undefined;
    expect(read()).toBe("FR");

    const envFile = envFilePath();
    try {
      mkdirSync(join(envFile, ".."), { recursive: true });
      writeFileSync(envFile, "TIDEGAP_DEFAULT_REGION=NL\n");
      expect(currentRegion({ ...kyiv(), env: liveEnvRegion })).toEqual({ region: "NL", source: "env" });
      writeFileSync(envFile, "# nothing\n");
      expect(currentRegion({ ...kyiv(), env: liveEnvRegion })).toEqual({ region: "FR", source: "setting" });
    } finally {
      rmSync(envFile, { force: true });
      loadEnvFileIntoProcess();
    }
  });

  it("a write is seen even when the rewrite keeps the file's mtime and size", () => {
    storeRegion("FR", configPath);
    const { atime, mtime } = statSync(configPath);
    const read = regionGetter(kyiv());
    expect(read()).toBe("FR");
    storeRegion("DE", configPath);
    utimesSync(configPath, atime, mtime);
    expect(read()).toBe("DE");
  });

  it("env set: show reports env and names the stored value that waits", () => {
    storeRegion("FR", configPath);
    const out = runRegionShow({}, { ...kyiv(), env: "DE" }).out!;
    expect(out.split("\n")[0]).toBe("DE Germany — set by TIDEGAP_DEFAULT_REGION");
    expect(out).toContain("Stored setting FR applies when the override is removed.");
    expect(JSON.parse(runRegionShow({ json: true }, { ...kyiv(), env: "DE" }).out!)).toMatchObject({ effective: "DE", source: "env", stored: "FR" });
  });

  it("covers AE5: a hand-edited unknown value is ignored with a warning", () => {
    writeFileSync(configPath, "TIDEGAP_DEFAULT_REGION=XX\n");
    const view = regionView(kyiv());
    expect(view).toMatchObject({ effective: "PL", source: "timezone", stored: "XX", ignored: "XX" });
    expect(runRegionShow({}, kyiv()).out).toContain("Stored region XX is not supported; ignored.");
  });

  it("detect prints the guess and stores nothing", () => {
    writeFileSync(configPath, "TIDEGAP_DEFAULT_REGION=FR\n");
    const res = runRegionDetect({}, "Europe/Kyiv");
    expect(res.out!.split("\n")[0]).toBe("PL Poland — guessed from time zone Europe/Kyiv (approximate: no UA data yet)");
    expect(res.out).toContain("Nothing stored.");
    expect(JSON.parse(runRegionDetect({ json: true }, "Europe/Paris").out!)).toEqual({ region: "FR", source: "timezone", timeZone: "Europe/Paris" });
    expect(runRegionDetect({}, "Asia/Tokyo").out!.split("\n")[0]).toBe("GB Great Britain — default: time zone Asia/Tokyo is not mapped");
    expect(readFileSync(configPath, "utf8")).toBe("TIDEGAP_DEFAULT_REGION=FR\n");
  });

  it("list prints every catalog zone with name, country, operator and data source", () => {
    const lines = runRegionList({}, {}).out!.split("\n");
    expect(lines).toHaveLength(Object.keys(REGION_CATALOG).length);
    expect(lines.find((l) => l.startsWith("FR "))).toMatch(/France, France · RTE · ENTSO-E$/);
    const json = JSON.parse(runRegionList({ json: true }, { credentials: { entsoeSecurityToken: "t" } }).out!);
    expect(json.find((i: { zone: string }) => i.zone === "FR").dataSource).toMatchObject({ id: "entsoe", live: true });
  });

  it("a getter sees a changed setting without a restart; queued tasks keep their region", async () => {
    const read = regionGetter(kyiv());
    expect(read()).toBe("PL");
    storeRegion("FR", configPath);
    expect(read()).toBe("FR");

    storeRegion("auto", configPath);
    const scheduler = actionScheduler({ dbPath: join(dir, "q.db"), feed: mockGridFeed(), region: regionGetter(kyiv()) });
    const spec = { type: "provider_call" as const, provider: "anthropic", model: "m", prompt: "hi" };
    const deadline = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const before = await scheduler.enqueueProviderCall(spec, { deadline });
    storeRegion("FR", configPath);
    const after = await scheduler.enqueueProviderCall(spec, { deadline });
    expect([before.region, after.region]).toEqual(["PL", "FR"]);
    scheduler.shutdown();
  });
});
