/** `GET|POST /api/settings/limits` (limits plan U11, KTD12, KTD13). */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DURATION_ZERO_ERROR, mockGridFeed, RETRY_DELAY_ERROR, TaskStore } from "@tidegap/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NO_TIME_LIMIT_WARNING, type LimitsJson } from "../src/limits.js";
import { handleApi, postBodyKind, type ApiContext } from "../src/ui/api.js";
import { LIMITS_WRITES_PER_MINUTE } from "../src/ui/settings.js";
import type { RegionViewInputs } from "../src/region.js";

describe("/api/settings/limits", () => {
  let dir: string;
  let store: TaskStore;
  let region: RegionViewInputs;
  let ctx: ApiContext;
  let config: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-settings-limits-"));
    store = new TaskStore({ dbPath: join(dir, "q.db") });
    config = join(dir, "config");
    region = { configPath: config, timeZone: "Europe/Berlin" };
    ctx = {
      store,
      dbPath: join(dir, "q.db"),
      feed: mockGridFeed(),
      defaultRegion: "GB",
      region,
      quota: () => ({}),
      daemonStatus: () => "not_installed",
      now: () => new Date("2026-11-08T12:00:00Z"),
    };
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const get = async () => (await handleApi(ctx, "GET", "/api/settings/limits", new URLSearchParams())).body as LimitsJson;
  const post = (body: Record<string, unknown>) => handleApi(ctx, "POST", "/api/settings/limits", new URLSearchParams(), body);
  const setting = (view: LimitsJson, name: string) => view.settings.find((s) => s.setting === name)!;
  const runner = (view: LimitsJson, name: string, r: string) => setting(view, name).runners.find((x) => x.runner === r)!;

  it("POST takes a JSON body", () => {
    expect(postBodyKind("/api/settings/limits")).toBe("json");
  });

  it("GET lists each setting per runner with value, source and ignored lines (AE3's settings)", async () => {
    writeFileSync(config, "TIDEGAP_LLM_TIMEOUT=20m\nTIDEGAP_LLM_TIMEOUT_CLAUDE_CODE=1h\nTIDEGAP_COMMAND_TIMEOUT=0\n");
    const view = await get();
    expect(view.settings.map((s) => s.setting)).toEqual(["command_timeout", "llm_timeout", "retries", "retry_delay"]);
    expect(setting(view, "llm_timeout")).toMatchObject({ name: "llm-timeout", kind: "time_limit", per_runner: true, key: "TIDEGAP_LLM_TIMEOUT", all: { value_s: 1200 } });
    expect(runner(view, "llm_timeout", "claude-code")).toEqual({
      runner: "claude-code",
      effective: { value_s: 3600 },
      source: "setting:claude-code",
      stored: { value_s: 3600 },
      default: { value_s: 1800 },
    });
    expect(runner(view, "llm_timeout", "anthropic")).toMatchObject({ effective: { value_s: 1200 }, source: "setting", stored: null });
    // The ignored 0 leaves the default in force.
    expect(runner(view, "command_timeout", "command")).toMatchObject({ effective: { value_s: 1800 }, source: "default" });
    expect(runner(view, "retries", "command")).toMatchObject({ effective: { value: 1 }, source: "default" });
    expect(view.ignored).toEqual([{ key: "TIDEGAP_COMMAND_TIMEOUT", value: "0", reason: expect.stringContaining("none") }]);
    expect(view.no_time_limit_warning).toBe(NO_TIME_LIMIT_WARNING);
  });

  it("POST command_timeout none writes TIDEGAP_COMMAND_TIMEOUT=none; null clears the key", async () => {
    const res = await post({ setting: "command_timeout", runner: null, value_s: "none" });
    expect(res.status).toBe(200);
    expect(readFileSync(config, "utf8")).toBe("TIDEGAP_COMMAND_TIMEOUT=none\n");
    expect(runner(res.body as LimitsJson, "command_timeout", "command")).toMatchObject({ effective: { value_s: "none" }, source: "setting" });
    expect((await post({ setting: "command_timeout", runner: null, value_s: null })).status).toBe(200);
    expect(readFileSync(config, "utf8")).toBe("");
  });

  it("POST a per-runner value and retries; the effective value and source follow", async () => {
    expect((await post({ setting: "llm_timeout", runner: "claude-code", value_s: 5400 })).status).toBe(200);
    const res = await post({ setting: "retries", runner: "command", value: 0 });
    expect(res.status).toBe(200);
    expect(readFileSync(config, "utf8")).toBe("TIDEGAP_LLM_TIMEOUT_CLAUDE_CODE=90m\nTIDEGAP_RETRIES_COMMAND=0\n");
    const view = res.body as LimitsJson;
    expect(runner(view, "llm_timeout", "claude-code")).toMatchObject({ effective: { value_s: 5400 }, source: "setting:claude-code" });
    expect(runner(view, "retries", "command")).toMatchObject({ effective: { value: 0 }, source: "setting:command" });
  });

  it("value_s 0 is 400 with the none sentence; a bad body is 400 invalid with a fixed sentence", async () => {
    const zero = await post({ setting: "command_timeout", runner: null, value_s: 0 });
    expect(zero).toMatchObject({ status: 400, body: { error: DURATION_ZERO_ERROR, code: "invalid" } });
    expect((await post({ setting: "retry_delay", runner: null, value_s: "none" })).body).toMatchObject({ error: RETRY_DELAY_ERROR });
    for (const body of [
      { setting: "nope", runner: null, value_s: 60 },
      { setting: "command_timeout", runner: "claude-code", value_s: 60 },
      { setting: "llm_timeout", runner: "command", value_s: 60 },
      { setting: "retries", runner: null, value_s: 2 },
      { setting: "retries", runner: null },
      { setting: "llm_timeout", runner: null, value_s: 60, extra: 1 },
      { setting: "llm_timeout", runner: null, value_s: 8 * 86_400 },
      { setting: "retries", runner: null, value: 11 },
    ]) {
      const res = await post(body);
      expect([body, res.status, (res.body as { code: string }).code]).toEqual([body, 400, "invalid"]);
    }
    const extra = await post({ setting: "llm_timeout", runner: null, value_s: 60, "<b>x</b>": 1 });
    expect(extra.body).toMatchObject({ error: 'llm_timeout takes only {"setting", "runner", "value_s"}' });
    expect(() => readFileSync(config, "utf8")).toThrow();
  });

  it(`the ${LIMITS_WRITES_PER_MINUTE + 1}st write in a minute is 429; region writes count apart`, async () => {
    for (let i = 0; i < LIMITS_WRITES_PER_MINUTE; i++) {
      expect((await post({ setting: "retries", runner: null, value: i % 3 })).status).toBe(200);
    }
    expect(await post({ setting: "retries", runner: null, value: 2 })).toMatchObject({ status: 429, body: { code: "rate_limited" } });
    expect((await handleApi(ctx, "POST", "/api/settings/region", new URLSearchParams(), { zone: "FR" })).status).toBe(200);
    expect((await handleApi(ctx, "GET", "/api/settings/limits", new URLSearchParams())).status).toBe(200);
  });
});
