/**
 * Region precedence on the real server (RS4 / U5): tool argument >
 * TIDEGAP_DEFAULT_REGION > ~/.tidegap/config setting > time zone > GB,
 * with the setting re-read per call.
 */
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mockGridFeed } from "@tidegap/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createEbbServer } from "../src/server.js";

type TextResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

const cleanups: Array<() => void> = [];
const savedKey = process.env.TIDEGAP_ELECTRICITY_MAPS_API_KEY;
beforeEach(() => {
  delete process.env.TIDEGAP_ELECTRICITY_MAPS_API_KEY;
});
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
  if (savedKey === undefined) delete process.env.TIDEGAP_ELECTRICITY_MAPS_API_KEY;
  else process.env.TIDEGAP_ELECTRICITY_MAPS_API_KEY = savedKey;
});

function settingFile(value?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "tidegap-mcp-region-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "config");
  if (value !== undefined) writeFileSync(path, `TIDEGAP_DEFAULT_REGION=${value}\n`);
  return path;
}

/** Rewrite the setting with a later mtime, so the reader sees a change. */
function writeSetting(path: string, value: string, bumpS: number): void {
  writeFileSync(path, `TIDEGAP_DEFAULT_REGION=${value}\n`);
  const t = new Date(Date.now() + bumpS * 1000);
  utimesSync(path, t, t);
}

async function connect(deps: Parameters<typeof createEbbServer>[0]) {
  const built = createEbbServer({ feed: mockGridFeed(), ...deps });
  const client = new Client({ name: "region-test", version: "0.0.0" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([built.server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(() => built.scheduler.shutdown());
  return { ...built, client };
}

async function dryRun(client: Client, region?: string): Promise<TextResult> {
  const deadline = new Date(Date.now() + 12 * 3600_000).toISOString();
  return (await client.callTool({
    name: "schedule_task",
    arguments: { prompt: "p", deadline, dry_run: true, ...(region ? { region } : {}) },
  })) as TextResult;
}

function regionLines(res: TextResult): string[] {
  return res.content[0]!.text.split("\n").filter((l) => /^region(_source)?: /.test(l));
}

describe("MCP region precedence", () => {
  it("env beats the setting", async () => {
    const { client } = await connect({
      defaultRegion: "DE",
      regionSettingPath: settingFile("FR"),
      timeZone: "Europe/London",
    });
    expect(regionLines(await dryRun(client))).toEqual(["region: DE", "region_source: env"]);
  });

  it("the setting beats the time zone", async () => {
    const { client, resolveDefaultRegion } = await connect({
      regionSettingPath: settingFile("fr"),
      timeZone: "Europe/London",
    });
    expect(regionLines(await dryRun(client))).toEqual(["region: FR", "region_source: setting"]);
    expect(resolveDefaultRegion()).toEqual({ region: "FR", source: "setting" });
  });

  it("a setting written after start is used by the next tool call", async () => {
    const path = settingFile();
    const { client } = await connect({ regionSettingPath: path, timeZone: "Europe/London" });
    expect(regionLines(await dryRun(client))).toEqual(["region: GB", "region_source: timezone"]);
    writeSetting(path, "FR", 5);
    expect(regionLines(await dryRun(client))).toEqual(["region: FR", "region_source: setting"]);
  });

  it("a tool argument wins and reports flag; a catalog zone is matched in any case", async () => {
    const { client } = await connect({
      defaultRegion: "DE",
      regionSettingPath: settingFile("FR"),
      timeZone: "Europe/London",
    });
    expect(regionLines(await dryRun(client, "us-cal-ciso"))).toEqual([
      "region: US-CAL-CISO",
      "region_source: flag",
    ]);
  });

  it("an unknown zone argument is rejected with the closest zones", async () => {
    const { client } = await connect({ regionSettingPath: settingFile(), timeZone: "Europe/London" });
    const res = await dryRun(client, "UA");
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("schedule_task rejected: Unknown zone UA. Closest: PL.");
    const forecast = (await client.callTool({
      name: "get_grid_forecast",
      arguments: { region: "XX" },
    })) as TextResult;
    expect(forecast.isError).toBe(true);
    expect(forecast.content[0]!.text).toMatch(/^get_grid_forecast rejected: Unknown zone XX\. Request a region: /);
  });

  it("recommend_window rejects an unknown zone and accepts a lowercase catalog zone", async () => {
    const { client } = await connect({ regionSettingPath: settingFile(), timeZone: "Europe/London" });
    const deadline = new Date(Date.now() + 12 * 3600_000).toISOString();
    const bad = (await client.callTool({
      name: "recommend_window",
      arguments: { deadline, region: "UA" },
    })) as TextResult;
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toMatch(/^recommend_window rejected: Unknown zone UA\. Closest: PL\./);
    const ok = (await client.callTool({
      name: "recommend_window",
      arguments: { deadline, region: "fr" },
    })) as TextResult;
    expect(ok.isError).toBeFalsy();
  });

  it("an unknown zone passes through when an Electricity Maps key is set", async () => {
    process.env.TIDEGAP_ELECTRICITY_MAPS_API_KEY = "test-key";
    const { client } = await connect({ regionSettingPath: settingFile(), timeZone: "Europe/London" });
    expect(regionLines(await dryRun(client, "US-CAR-DUK"))).toEqual([
      "region: US-CAR-DUK",
      "region_source: flag",
    ]);
  });

  it("an unsupported stored value is ignored and warned about once per change", async () => {
    const path = settingFile("XX");
    const warnings: string[] = [];
    const { client } = await connect({
      regionSettingPath: path,
      timeZone: "Europe/Paris",
      warn: (m) => warnings.push(m),
    });
    expect(regionLines(await dryRun(client))).toEqual(["region: FR", "region_source: timezone"]);
    await dryRun(client);
    expect(warnings).toEqual(["Stored region XX is not supported; ignored."]);
    writeSetting(path, "YY", 5);
    await dryRun(client);
    expect(warnings).toHaveLength(2);
  });
});
