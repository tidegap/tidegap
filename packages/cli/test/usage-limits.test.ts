/**
 * The limit state (R1, R2, R4, D1, D2): the statusline hook, the opt-in OAuth
 * read with its cache, and the off switch. Fetch and Keychain are fakes; the
 * cache lives in the hermetic test home.
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  limitsFromStatusline,
  readClaudeLimits,
  readUsageCache,
  recordStatusline,
  resolveUsageSettings,
  runStatuslineHook,
} from "../src/usage/index.js";
import type { FetchLike, SecurityRunner } from "../src/usage/index.js";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "usage");
const fixture = (name: string) => readFileSync(join(FIX, name), "utf8");
const TOKEN = "sk-ant-oat01-FIXTURE-TOKEN-do-not-leak";
const NOW = new Date("2026-10-17T12:00:00.000Z");
const OAUTH = { disabled: false, oauth: true };
const LOCAL = { disabled: false, oauth: false };

interface FakeFetch extends FetchLike {
  calls: Array<{ url: string; headers: Record<string, string> }>;
}
function fakeFetch(status: number, body: unknown, headers: Record<string, string> = {}): FakeFetch {
  const f = (async (url, init) => {
    f.calls.push({ url, headers: init.headers });
    return {
      status,
      headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
      json: async () => body,
    };
  }) as FakeFetch;
  f.calls = [];
  return f;
}
const keychain: SecurityRunner = async () => ({ code: 0, stdout: fixture("credentials-oauth.json"), timedOut: false });
const creds = { platform: "darwin" as const, runSecurity: keychain, readFile: () => undefined };

describe("usage limits", () => {
  let dir: string;
  let cachePath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-usage-"));
    cachePath = join(dir, ".tidegap", "usage.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const read = (extra: Partial<Parameters<typeof readClaudeLimits>[0]> = {}) =>
    readClaudeLimits({ settings: OAUTH, cachePath, now: NOW, credentials: creds, ...extra });

  describe("statusline source", () => {
    it("parses rate_limits (percent, epoch seconds) from the statusline input", () => {
      expect(limitsFromStatusline(JSON.parse(fixture("statusline-input.json")))).toEqual({
        five_hour: { pct: 72, resets_at: "2026-10-17T16:30:00.000Z" },
        seven_day: { pct: 40.5, resets_at: "2026-10-20T09:00:00.000Z" },
        scoped: [],
      });
      expect(limitsFromStatusline(JSON.parse(fixture("statusline-no-limits.json")))).toBeUndefined();
    });

    it("the hook writes usage.json (0600, no token) and the state reads it with OAuth off", async () => {
      expect(await runStatuslineHook(fixture("statusline-input.json"), [], { settings: LOCAL, cachePath, now: NOW })).toBe(0);
      expect(statSync(cachePath).mode & 0o777).toBe(0o600);
      const s = await readClaudeLimits({ settings: LOCAL, cachePath, now: new Date(NOW.getTime() + 60_000) });
      expect(s).toMatchObject({ status: "ok", source: "statusline", stale: false, age_s: 60 });
      expect(s.five_hour?.pct).toBe(72);
    });

    it("an unchanged reading within 30 s is not rewritten; a changed one is", () => {
      const input = fixture("statusline-input.json");
      expect(recordStatusline(input, { settings: LOCAL, cachePath, now: NOW })).toBe(true);
      expect(recordStatusline(input, { settings: LOCAL, cachePath, now: new Date(NOW.getTime() + 10_000) })).toBe(false);
      const changed = input.replace('"used_percentage":72', '"used_percentage":73');
      expect(recordStatusline(changed, { settings: LOCAL, cachePath, now: new Date(NOW.getTime() + 11_000) })).toBe(true);
    });

    it("an input without rate_limits, or garbage, writes nothing", () => {
      expect(recordStatusline(fixture("statusline-no-limits.json"), { settings: LOCAL, cachePath, now: NOW })).toBe(false);
      expect(recordStatusline("not json", { settings: LOCAL, cachePath, now: NOW })).toBe(false);
      expect(readUsageCache(cachePath).claude).toEqual({});
    });

    it("passes stdin to the wrapped command and returns its exit code", async () => {
      const out = join(dir, "seen.json");
      const code = await runStatuslineHook(
        fixture("statusline-input.json"),
        [process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(out)}, require("fs").readFileSync(0)); process.exit(3)`],
        { settings: LOCAL, cachePath, now: NOW },
      );
      expect(code).toBe(3);
      expect(readFileSync(out, "utf8")).toBe(fixture("statusline-input.json"));
    });

    it("a cache it cannot write still runs the wrapped command; a missing command gives 1", async () => {
      const blocker = join(dir, "not-a-dir");
      writeFileSync(blocker, "x");
      const out = join(dir, "ran");
      const code = await runStatuslineHook(
        fixture("statusline-input.json"),
        [process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(out)}, "1")`],
        { settings: LOCAL, cachePath: join(blocker, "usage.json"), now: NOW },
      );
      expect(code).toBe(0);
      expect(readFileSync(out, "utf8")).toBe("1");
      expect(await runStatuslineHook("garbage", [join(dir, "no-such-command")], { settings: LOCAL, cachePath, now: NOW })).toBe(1);
      expect(await runStatuslineHook("garbage", [], { settings: LOCAL, cachePath, now: NOW })).toBe(0);
    });

    it("an old reading is served stale; no reading is unavailable with cause no_data", async () => {
      expect((await readClaudeLimits({ settings: LOCAL, cachePath, now: NOW })).error?.cause).toBe("no_data");
      recordStatusline(fixture("statusline-input.json"), { settings: LOCAL, cachePath, now: NOW });
      const s = await readClaudeLimits({ settings: LOCAL, cachePath, now: new Date(NOW.getTime() + 3_600_000) });
      expect(s).toMatchObject({ status: "ok", stale: true });
    });
  });

  describe("OAuth source (opt-in)", () => {
    it("sends the token header, the beta header and a tidegap/ User-Agent", async () => {
      const f = fakeFetch(200, JSON.parse(fixture("oauth-usage-ok.json")));
      const s = await read({ fetch: f });
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0]!.url).toBe("https://api.anthropic.com/api/oauth/usage");
      expect(f.calls[0]!.headers.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(f.calls[0]!.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
      expect(f.calls[0]!.headers["User-Agent"]).toMatch(/^tidegap\/\d/);
      expect(s).toMatchObject({
        status: "ok",
        source: "api",
        five_hour: { pct: 72, resets_at: "2026-10-17T16:30:00.000Z" },
        seven_day: { pct: 40, resets_at: "2026-10-20T09:00:00.000Z" },
        scoped: [],
      });
    });

    it("normalizes a scoped weekly window", async () => {
      const s = await read({ fetch: fakeFetch(200, JSON.parse(fixture("oauth-usage-scoped.json"))) });
      expect(s.scoped).toEqual([{ model: "Fable", pct: 100, resets_at: "2026-10-19T18:00:00.000Z" }]);
    });

    it("a second read within the TTL is served from the cache; after it, fetched again", async () => {
      const f = fakeFetch(200, JSON.parse(fixture("oauth-usage-ok.json")));
      await read({ fetch: f });
      const again = await read({ fetch: f, now: new Date(NOW.getTime() + 200_000) });
      expect(again.source).toBe("cache");
      expect(f.calls).toHaveLength(1);
      await read({ fetch: f, now: new Date(NOW.getTime() + 301_000) });
      expect(f.calls).toHaveLength(2);
    });

    it("a fresh statusline reading wins and costs no request", async () => {
      recordStatusline(fixture("statusline-input.json"), { settings: OAUTH, cachePath, now: NOW });
      const f = fakeFetch(200, JSON.parse(fixture("oauth-usage-ok.json")));
      expect((await read({ fetch: f })).source).toBe("statusline");
      expect(f.calls).toHaveLength(0);
    });

    it("a 429 with Retry-After 30 blocks requests for 60 min and serves the last good value", async () => {
      await read({ fetch: fakeFetch(200, JSON.parse(fixture("oauth-usage-ok.json"))) });
      const later = new Date(NOW.getTime() + 400_000);
      const limited = fakeFetch(429, {}, { "retry-after": "30" });
      const s = await read({ fetch: limited, now: later });
      expect(s).toMatchObject({ status: "ok", stale: true, error: { cause: "rate_limited" }, fetched_at: NOW.toISOString() });
      const entry = readUsageCache(cachePath).claude.oauth!;
      expect(entry.retry_at).toBe(new Date(later.getTime() + 3_600_000).toISOString());
      const f = fakeFetch(200, JSON.parse(fixture("oauth-usage-ok.json")));
      await read({ fetch: f, now: new Date(later.getTime() + 30 * 60_000) });
      expect(f.calls).toHaveLength(0);
    });

    it("a failed fetch keeps the last good data and its fetched_at", async () => {
      await read({ fetch: fakeFetch(200, JSON.parse(fixture("oauth-usage-ok.json"))) });
      const s = await read({ fetch: fakeFetch(503, {}), now: new Date(NOW.getTime() + 400_000) });
      expect(s).toMatchObject({ stale: true, fetched_at: NOW.toISOString(), error: { cause: "api_error" } });
      expect(s.five_hour?.pct).toBe(72);
    });

    it("an expired token: no request, cause token_expired", async () => {
      const f = fakeFetch(200, {});
      const s = await read({
        fetch: f,
        credentials: { platform: "linux", readFile: (p: string) => (p.endsWith(".credentials.json") ? fixture("credentials-expired.json") : undefined) },
      });
      expect(f.calls).toHaveLength(0);
      expect(s).toMatchObject({ status: "unavailable", error: { cause: "token_expired" } });
    });

    it("off by default: no credential read, no fetch", async () => {
      const f = fakeFetch(200, {});
      let keychainCalls = 0;
      const s = await readClaudeLimits({
        settings: LOCAL,
        cachePath,
        now: NOW,
        fetch: f,
        credentials: { platform: "darwin", runSecurity: async () => ((keychainCalls += 1), { code: 0, stdout: "", timedOut: false }) },
      });
      expect(s.error?.cause).toBe("no_data");
      expect(f.calls).toHaveLength(0);
      expect(keychainCalls).toBe(0);
    });

    it("the cache file and every result never contain the token", async () => {
      const results = [
        await read({ fetch: fakeFetch(200, JSON.parse(fixture("oauth-usage-ok.json"))) }),
        await read({ fetch: fakeFetch(429, {}), now: new Date(NOW.getTime() + 400_000) }),
        await read({ fetch: fakeFetch(401, {}), now: new Date(NOW.getTime() + 8_000_000) }),
        await read({
          fetch: (async () => {
            throw new Error(`boom ${TOKEN}`);
          }) as FetchLike,
          now: new Date(NOW.getTime() + 16_000_000),
        }),
      ];
      const text = JSON.stringify(results) + readFileSync(cachePath, "utf8");
      expect(text).not.toContain(TOKEN);
      expect(text).not.toMatch(/accessToken|refreshToken|Authorization|Bearer/);
      expect(statSync(cachePath).mode & 0o777).toBe(0o600);
    });
  });

  describe("settings", () => {
    it("env first, then ~/.tidegap/config; OAuth is off unless turned on", () => {
      const cfg = join(dir, "config");
      expect(resolveUsageSettings({}, cfg)).toEqual({ disabled: false, oauth: false });
      writeFileSync(cfg, "TIDEGAP_USAGE_OAUTH=1\n");
      expect(resolveUsageSettings({}, cfg).oauth).toBe(true);
      expect(resolveUsageSettings({ oauth: "0" }, cfg).oauth).toBe(false);
      writeFileSync(cfg, "TIDEGAP_USAGE=off\n");
      expect(resolveUsageSettings({}, cfg).disabled).toBe(true);
    });

    it("TIDEGAP_USAGE=off: status disabled, no credential read, no fetch, the hook writes nothing", async () => {
      const f = fakeFetch(200, {});
      const off = { disabled: true, oauth: true };
      expect(await readClaudeLimits({ settings: off, cachePath, now: NOW, fetch: f })).toMatchObject({ status: "disabled" });
      expect(f.calls).toHaveLength(0);
      expect(recordStatusline(fixture("statusline-input.json"), { settings: off, cachePath, now: NOW })).toBe(false);
    });
  });
});
