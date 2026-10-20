/**
 * `GET /api/usage`, `limits` in `/api/summary`, Later → after limit reset
 * from the usage cache, and the page's usage panel model (U5). Fixture
 * cache, config and logs under a temp dir; no network, no Keychain.
 */

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { mockGridFeed, TaskStore } from "@tidegap/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ClientRegistry } from "../src/ui/clients.js";
import { startUiServer, type UiServer } from "../src/ui/server.js";
import {
  usageLimitResetSource,
  usageProvider,
  writeUsageCache,
  type FetchLike,
  type SecurityRunner,
  type UsageDocumentOptions,
} from "../src/usage/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "fixtures", "usage");
const UI_DIR = join(HERE, "..", "ui");
const TOKEN = "page-token-0123456789";
const SECRET = "sk-ant-oat01-FIXTURE-TOKEN-do-not-leak";
const H = 3_600_000;

describe("usage over the ui API", () => {
  let dir: string;
  let ui: UiServer;
  let clientToken: string;
  let spendCalls: number;
  let keychainCalls: number;
  let fetchCalls: number;

  const cachePath = () => join(dir, "usage.json");
  const keychain: SecurityRunner = async () => {
    keychainCalls++;
    return { code: 0, stdout: readFileSync(join(FIX, "credentials-oauth.json"), "utf8"), timedOut: false };
  };

  function seedCache(fivePct: number, fetchedAt = new Date()): Date {
    const reset = new Date(Date.now() + 2 * H);
    writeUsageCache(
      {
        version: 1,
        claude: {
          statusline: {
            fetched_at: fetchedAt.toISOString(),
            data: {
              five_hour: { pct: fivePct, resets_at: reset.toISOString() },
              seven_day: { pct: 40, resets_at: new Date(Date.now() + 72 * H).toISOString() },
              scoped: [],
            },
          },
        },
      },
      cachePath(),
    );
    return reset;
  }

  async function start(read: Partial<UsageDocumentOptions> = {}, summaryTimeoutMs = 200): Promise<void> {
    const base: UsageDocumentOptions = {
      cachePath: cachePath(),
      configPath: join(dir, "config"),
      env: {},
      home: join(dir, "home"),
      credentials: { platform: "darwin", runSecurity: keychain, readFile: () => undefined },
      ...read,
    };
    const provider = usageProvider(base, summaryTimeoutMs);
    ui = await startUiServer({
      token: TOKEN,
      dbPath: join(dir, "queue.db"),
      assetDir: UI_DIR,
      stateDir: dir,
      feed: mockGridFeed(),
      defaultRegion: "FR",
      quota: () => ({}),
      daemonStatus: () => "unknown",
      pollMs: 50,
      limitReset: usageLimitResetSource(base),
      // The same provider `tidegap ui` uses, with this test's home, Keychain and fetch.
      usage: (opts) => {
        if (opts.spend) spendCalls++;
        return provider(opts);
      },
    });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-ui-usage-"));
    cpSync(join(FIX, "claude-projects"), join(dir, "home", ".claude", "projects"), { recursive: true });
    ({ token: clientToken } = new ClientRegistry(dir).add({ name: "Chrome", kind: "extension" }));
    spendCalls = 0;
    keychainCalls = 0;
    fetchCalls = 0;
  });
  afterEach(async () => {
    await ui?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const call = (path: string, token: string | null, origin?: string, method = "GET") =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const headers: Record<string, string> = { host: `127.0.0.1:${ui.port}` };
      if (token) headers.authorization = `Bearer ${token}`;
      if (origin) headers.origin = origin;
      const req = request({ host: "127.0.0.1", port: ui.port, path, method, headers }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on("error", reject);
      req.end();
    });

  it("GET /api/usage: usage/v1 for the page and a client token; 401 without one; 403 from a foreign origin", async () => {
    seedCache(72);
    await start();
    const page = await call("/api/usage", TOKEN);
    expect(page.status).toBe(200);
    const doc = JSON.parse(page.body);
    expect(doc).toMatchObject({ schema: "usage/v1", claude: { status: "ok", five_hour: { pct: 72 } }, codex: { status: "not_found" } });
    expect(doc.line).toMatch(/^Claude 5h: 72%, resets /);
    expect(doc).not.toHaveProperty("claude_spend");
    expect((await call("/api/usage", clientToken, "chrome-extension://abcdefghijklmnop")).status).toBe(200);
    expect((await call("/api/usage", null)).status).toBe(401);
    expect((await call("/api/usage", TOKEN, "https://evil.example")).status).toBe(403);
    expect((await call("/api/usage", TOKEN, undefined, "POST")).status).toBe(405);
    expect(spendCalls).toBe(0);
  });

  it("?spend=1 adds claude_spend from the logs", async () => {
    seedCache(72);
    await start();
    const doc = JSON.parse((await call("/api/usage?spend=1", clientToken)).body);
    expect(spendCalls).toBe(1);
    expect(doc.claude_spend).toMatchObject({ window: { basis: "five_hour" }, note: "API list-price estimate, not billed" });
  });

  it("/api/summary carries limits from a fresh cache", async () => {
    const reset = seedCache(72);
    await start();
    const body = JSON.parse((await call("/api/summary", clientToken)).body);
    expect(body.limits).toEqual({
      line: expect.stringMatching(/^Claude 5h: 72%, resets /),
      status: "ok",
      window: "five_hour",
      pct: 72,
      resets_at: reset.toISOString(),
    });
  });

  it("a hanging usage API: /api/summary answers within the cap with the last good line", async () => {
    // A stale statusline reading and the OAuth read on: the server fetches, and the fetch never answers.
    seedCache(72, new Date(Date.now() - 2 * H));
    writeFileSync(join(dir, "config"), "TIDEGAP_USAGE_OAUTH=1\n");
    const hang: FetchLike = (_url, init) => {
      fetchCalls++;
      return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    };
    await start({ fetch: hang });
    const t0 = Date.now();
    const res = await call("/api/summary", clientToken);
    expect(Date.now() - t0).toBeLessThan(2_000);
    const body = JSON.parse(res.body);
    expect(fetchCalls).toBe(1);
    expect(body.limits.status).toBe("ok");
    // A reset after midnight reads "Wed 00:00", one on the same day "14:00".
    expect(body.limits.line).toMatch(/^Claude 5h: 72%, resets (?:\S+ )?\S+ \(as of /);
    expect(res.body).not.toContain(SECRET);
  });

  it("no reading at all: an empty line, so the native clients show nothing", async () => {
    await start();
    const body = JSON.parse((await call("/api/summary", TOKEN)).body);
    expect(body.limits).toMatchObject({ status: "unavailable", line: "", pct: null });
  });

  it("TIDEGAP_USAGE=off in ~/.tidegap/config: limits disabled, the credential reader never runs", async () => {
    seedCache(72);
    writeFileSync(join(dir, "config"), "TIDEGAP_USAGE=off\nTIDEGAP_USAGE_OAUTH=1\n");
    await start();
    const body = JSON.parse((await call("/api/summary", clientToken)).body);
    expect(body.limits).toEqual({ line: "", status: "disabled", window: null, pct: null, resets_at: null });
    expect(JSON.parse((await call("/api/usage", TOKEN)).body).claude.status).toBe("disabled");
    expect(keychainCalls).toBe(0);
  });

  it("no answer leaks the fixture token after a live OAuth read", async () => {
    writeFileSync(join(dir, "config"), "TIDEGAP_USAGE_OAUTH=1\n");
    const ok: FetchLike = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => JSON.parse(readFileSync(join(FIX, "oauth-usage-ok.json"), "utf8")),
    });
    await start({ fetch: ok });
    for (const path of ["/api/usage", "/api/usage?spend=1", "/api/summary"]) {
      const res = await call(path, TOKEN);
      expect(res.status).toBe(200);
      expect(res.body).not.toContain(SECRET);
      expect(res.body).not.toMatch(/accessToken|refreshToken/);
    }
    expect(readFileSync(cachePath(), "utf8")).not.toContain(SECRET);
  });

  it("Later → After limit reset is available on a Claude task when the cache knows the reset", async () => {
    const reset = seedCache(100);
    const store = new TaskStore({ dbPath: join(dir, "queue.db") });
    const body = (provider: string) => JSON.stringify({ type: "provider_call", provider, model: "claude-sonnet-5", prompt: "p" });
    const row = (id: string, provider: string) => ({
      taskId: id,
      status: "scheduled" as const,
      enqueuedAt: new Date().toISOString(),
      scheduledFor: new Date(Date.now() + H).toISOString(),
      deadline: new Date(Date.now() + 24 * H).toISOString(),
      region: "FR",
      title: id,
      bodyJson: body(provider),
    });
    store.upsert(row("claude", "claude-code"));
    store.upsert(row("openai", "openai"));
    store.close();
    await start();
    const list = JSON.parse((await call("/api/tasks?status=scheduled", clientToken)).body) as {
      tasks: Array<{ task_id: string; later_options: Array<Record<string, unknown>> }>;
    };
    const opt = (id: string) => list.tasks.find((t) => t.task_id === id)!.later_options.find((o) => o.preset === "after_limit_reset");
    expect(opt("claude")).toMatchObject({ available: true, not_before: new Date(reset.getTime() + 5 * 60_000).toISOString() });
    // Not a Claude subscription task: the reset-time fallback stays.
    expect(opt("openai")).toMatchObject({ available: false, reason: "needs the reset time" });
  });
});

describe("page usage panel model", () => {
  type View = { pill: { text: string; state: string } | null; sections: Array<{ title: string; rows: Array<{ label: string; pct: number | null; text: string; resets: string }>; note: string; sub?: string }> };
  let mod: {
    usageView: (d: unknown, now?: number) => View;
    spendRows: (s: unknown) => string[][];
    resetClock: (ms: number, now?: number) => string;
  };
  const NOW = Date.parse("2026-10-17T12:00:00.000Z");
  let tz: string | undefined;
  beforeEach(async () => {
    tz = process.env.TZ;
    process.env.TZ = "UTC";
    mod = await import(join(UI_DIR, "usage.js"));
  });
  afterEach(() => {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  });

  const claude = (extra: Record<string, unknown>) => ({
    schema: "usage/v1",
    claude: {
      status: "ok",
      source: "statusline",
      fetched_at: "2026-10-17T11:58:00.000Z",
      stale: false,
      five_hour: { pct: 72, resets_at: "2026-10-17T16:30:00.000Z" },
      seven_day: { pct: 40, resets_at: "2026-10-20T09:00:00.000Z" },
      scoped: [{ model: "Fable", pct: 55, resets_at: "2026-10-20T09:00:00.000Z" }],
      ...extra,
    },
    line: "",
  });

  it("ok: the pill names the fullest window; the dialog lists 5h, 7d and the per-model window", () => {
    const v = mod.usageView(claude({}), NOW);
    expect(v.pill).toEqual({ text: "Claude 5h 72% · resets 16:30", state: "ok" });
    expect(v.sections[0]!.rows.map((r) => [r.label, r.text, r.resets])).toEqual([
      ["5h", "72%", "resets 16:30"],
      ["7d", "40%", "resets Tue 09:00"],
      ["Fable 7d", "55%", "resets Tue 09:00"],
    ]);
    expect(mod.usageView(claude({ five_hour: { pct: 95, resets_at: "2026-10-17T16:30:00.000Z" } }), NOW).pill?.state).toBe("high");
  });

  it("stale: the last good value with the cause", () => {
    const v = mod.usageView(claude({ stale: true, error: { cause: "rate_limited", message: "the usage API is rate-limited; retrying later" } }), NOW);
    expect(v.pill?.state).toBe("stale");
    expect(v.sections[0]!.note).toBe("Last good value. the usage API is rate-limited; retrying later");
  });

  it("unavailable names the cause; disabled hides the pill", () => {
    const u = mod.usageView({ claude: { status: "unavailable", stale: false, scoped: [], error: { cause: "not_logged_in", message: "Claude Code is not logged in" } } }, NOW);
    expect(u.pill).toEqual({ text: "Claude limits ?", state: "unavailable" });
    expect(u.sections[0]!.note).toBe("Claude Code is not logged in");
    const d = mod.usageView({ claude: { status: "disabled", stale: false, scoped: [] } }, NOW);
    expect(d.pill).toBeNull();
    expect(d.sections[0]!.note).toMatch(/off/);
    expect(mod.usageView(null, NOW)).toEqual({ pill: null, sections: [] });
  });

  it("Codex rows; a passed window reads reset since seen", () => {
    const v = mod.usageView(
      {
        ...claude({}),
        codex: {
          status: "ok",
          as_of: "2026-05-21T21:51:01.471Z",
          plan_type: "plus",
          five_hour: { pct: null, resets_at: "2026-05-22T02:01:32.000Z", state: "reset_since_seen" },
          seven_day: { pct: 43, resets_at: "2026-10-18T09:00:00.000Z" },
        },
      },
      NOW,
    );
    expect(v.sections[1]!.title).toBe("Codex");
    expect(v.sections[1]!.rows.map((r) => [r.label, r.pct, r.text])).toEqual([
      ["5h", null, "reset since seen"],
      ["7d", 43, "43%"],
    ]);
  });

  it("spend rows: total, each model, each session; a model with no price says so", () => {
    const row = (input: number, cost: number | null) => ({ input, output: 2_000, cache_write: 0, cache_read: 1_500_000, cost_usd: cost });
    const rows = mod.spendRows({
      total: row(1_200_000, 14.7),
      by_model: [{ model: "claude-sonnet-5", ...row(1_200_000, 14.7) }, { model: "claude-mystery-9", ...row(10, null) }],
      sessions: [{ session_id: "s1", project: "-proj-a", last_activity: "2026-10-17T11:50:00.000Z", ...row(5, 0.01) }],
    });
    expect(rows).toEqual([
      ["Total", "1.2M in · 2k out · 0 cache write · 1.5M cache read", "$14.70"],
      ["claude-sonnet-5", "1.2M in · 2k out · 0 cache write · 1.5M cache read", "$14.70"],
      ["claude-mystery-9", "10 in · 2k out · 0 cache write · 1.5M cache read", "no price"],
      ["-proj-a · 11:50", "5 in · 2k out · 0 cache write · 1.5M cache read", "$0.01"],
    ]);
  });
});
