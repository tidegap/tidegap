/** `GET|POST /api/settings/region` and the per-request region (region plan U3, KTD7, AE3). */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mockGridFeed, TaskStore } from "@tidegap/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleApi, postBodyKind, type ApiContext } from "../src/ui/api.js";
import { REGION_WRITES_PER_MINUTE } from "../src/ui/settings.js";
import type { RegionViewInputs } from "../src/region.js";

describe("/api/settings/region", () => {
  let dir: string;
  let store: TaskStore;
  let region: RegionViewInputs;
  let ctx: ApiContext;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-settings-region-"));
    store = new TaskStore({ dbPath: join(dir, "q.db") });
    region = { configPath: join(dir, "config"), timeZone: "Europe/Kyiv" };
    ctx = {
      store,
      dbPath: join(dir, "q.db"),
      feed: mockGridFeed(),
      defaultRegion: "GB",
      region,
      quota: () => ({}),
      daemonStatus: () => "not_installed",
      now: () => new Date("2026-10-20T12:00:00Z"),
    };
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const get = () => handleApi(ctx, "GET", "/api/settings/region", new URLSearchParams());
  const post = (body: Record<string, unknown>) => handleApi(ctx, "POST", "/api/settings/region", new URLSearchParams(), body);

  it("POST takes a JSON body", () => {
    expect(postBodyKind("/api/settings/region")).toBe("json");
    expect(postBodyKind("/api/settings/other")).toBeUndefined();
  });

  it("GET reports the resolution and the 31-zone catalog", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown> & { catalog: unknown[] };
    expect(body).toMatchObject({
      effective: "PL",
      source: "timezone",
      stored: null,
      timeZone: "Europe/Kyiv",
      detected: { region: "PL", source: "timezone", approximate: { country: "UA" } },
      approximate: { country: "UA" },
    });
    expect(body.catalog).toHaveLength(31);
    expect(body.catalog[0]).toMatchObject({ zone: expect.any(String), name: expect.any(String), operator: expect.any(String), dataSource: { id: expect.any(String) } });
  });

  it("POST fr stores FR and answers the new resolution; auto clears it", async () => {
    const res = await post({ zone: "fr" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ effective: "FR", source: "setting", stored: "FR" });
    expect(readFileSync(region.configPath!, "utf8")).toBe("TIDEGAP_DEFAULT_REGION=FR\n");
    expect((await post({ zone: "auto" })).body).toMatchObject({ effective: "PL", source: "timezone", stored: null });
  });

  it("POST UA is 400 unknown_zone with the readable closest-match sentence", async () => {
    const res = await post({ zone: "UA" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "unknown_zone", error: expect.stringMatching(/^Unknown zone UA\. Closest: PL\. Request a region: https:/) });
  });

  it("POST with an extra key, no zone or a non-string zone is 400 invalid", async () => {
    for (const body of [{ zone: "FR", extra: 1 }, {}, { zone: 5 }, { zone: "" }]) {
      const res = await post(body);
      expect([body, res.status, (res.body as { code: string }).code]).toEqual([body, 400, "invalid"]);
    }
  });

  it("other methods are 405; other settings paths are 404; no region inputs means no route", async () => {
    expect((await handleApi(ctx, "DELETE", "/api/settings/region", new URLSearchParams())).status).toBe(405);
    expect((await handleApi(ctx, "GET", "/api/settings/other", new URLSearchParams())).status).toBe(404);
    const { region: _omit, ...fixed } = ctx;
    expect((await handleApi(fixed, "GET", "/api/settings/region", new URLSearchParams())).status).toBe(404);
  });

  it("covers AE3: with an env override the POST still stores; effective stays the env value", async () => {
    region.env = "DE";
    const res = await post({ zone: "FR" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ effective: "DE", source: "env", stored: "FR" });
  });

  it(`the ${REGION_WRITES_PER_MINUTE + 1}st write in a minute is 429 rate_limited`, async () => {
    for (let i = 0; i < REGION_WRITES_PER_MINUTE; i++) expect((await post({ zone: i % 2 ? "FR" : "DE" })).status).toBe(200);
    const res = await post({ zone: "FR" });
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ code: "rate_limited", retry_after_s: 60 });
    expect((await get()).status).toBe(200);
  });

  it("summary and status follow a stored change without a restart and carry region_source", async () => {
    const summary = async () => (await handleApi(ctx, "GET", "/api/summary", new URLSearchParams())).body as Record<string, unknown>;
    expect(await summary()).toMatchObject({ region: "PL", region_source: "timezone" });
    await post({ zone: "FR" });
    expect(await summary()).toMatchObject({ region: "FR", region_source: "setting" });
    expect((await handleApi(ctx, "GET", "/api/status", new URLSearchParams())).body).toMatchObject({ default_region: "FR", region_source: "setting" });
  });
});
