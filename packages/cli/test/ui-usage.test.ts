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
import { FakeElement, installFakeDom, textOf, walk } from "./fixtures/fake-dom.js";

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
    // A reset after midnight reads "Wed 00:00", one on the same day "14:00" (clockLabel).
    expect(body.limits.line).toMatch(/^Claude 5h: 72%, resets (?:[A-Z][a-z]{2} )?\d{2}:\d{2} \(as of /);
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
  type Cell = { text: string; title: string };
  type SpendModel = { header: Cell[]; groups: Array<{ title: string | null; rows: Array<{ label: string; title: string; counts: Cell[]; cost: string }> }> };
  let mod: {
    usageView: (d: unknown, now?: number) => View;
    spendTable: (s: unknown) => SpendModel;
    compactCount: (n: number) => string;
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

  it("Codex: every window passed since the reading collapses to one line with its age (AE2)", () => {
    const codex = (as_of: string | undefined, five: Record<string, unknown>, seven: Record<string, unknown>) =>
      mod.usageView({ ...claude({}), codex: { status: "ok", as_of, plan_type: "plus", five_hour: five, seven_day: seven } }, NOW).sections[1]!;
    const passed = (at: string) => ({ pct: null, resets_at: at, state: "reset_since_seen" });
    const old = codex("2026-05-08T12:00:00.000Z", passed("2026-05-08T16:00:00.000Z"), passed("2026-05-14T09:00:00.000Z"));
    expect([old.title, old.sub, old.rows, old.note]).toEqual(["Codex", "plus", [], "No reading for 162 days."]);
    // Under two days the age is in hours.
    const dayOld = codex("2026-10-16T06:00:00.000Z", passed("2026-10-16T10:00:00.000Z"), passed("2026-10-17T09:00:00.000Z"));
    expect([dayOld.rows, dayOld.note]).toEqual([[], "No reading for 30 h."]);
    const undated = codex(undefined, passed("2026-05-08T16:00:00.000Z"), passed("2026-05-14T09:00:00.000Z"));
    expect([undated.sub, undated.rows, undated.note]).toEqual(["plus", [], "No current reading."]);
  });

  it("Codex: only the 5h window passed keeps both rows and the seen age", () => {
    const v = mod.usageView(
      {
        ...claude({}),
        codex: {
          status: "ok",
          as_of: "2026-10-17T06:00:00.000Z",
          plan_type: "plus",
          five_hour: { pct: null, resets_at: "2026-10-17T10:00:00.000Z", state: "reset_since_seen" },
          seven_day: { pct: 43, resets_at: "2026-10-20T09:00:00.000Z" },
        },
      },
      NOW,
    );
    const x = v.sections[1]!;
    expect([x.sub, x.note]).toEqual(["plus · seen 6 h ago", ""]);
    expect(x.rows.map((r) => [r.label, r.pct, r.text])).toEqual([
      ["5h", null, "reset since seen"],
      ["7d", 43, "43%"],
    ]);
  });

  // The owner's Total from the 2026-10-30 report.
  const OWNER_TOTAL = { input: 27_000, output: 5_500_000, cache_write: 25_200_000, cache_read: 1_026_200_000, cost_usd: 711.01 };

  it("spend table (AE1): the owner's Total reads 27k 5.5M 25M 1.0B $711.01; each count's title is the exact value", () => {
    const t = mod.spendTable({ total: OWNER_TOTAL, by_model: [], sessions: [] });
    expect(t.header.map((c) => c.text)).toEqual(["in", "out", "cache w", "cache r", "cost"]);
    expect(t.groups.map((g) => g.title)).toEqual([null]);
    const total = t.groups[0]!.rows[0]!;
    expect([total.label, ...total.counts.map((c) => c.text), total.cost]).toEqual(["Total", "27k", "5.5M", "25M", "1.0B", "$711.01"]);
    expect(total.counts.map((c) => c.title)).toEqual(["27,000", "5,500,000", "25,200,000", "1,026,200,000"]);
  });

  it("compact counts: at most four characters plus a unit; a value that rounds to 1,000 takes the next unit", () => {
    const cases: Array<[number, string]> = [
      [0, "0"],
      [999, "999"],
      [1_000, "1.0k"],
      [9_949, "9.9k"],
      [9_950, "10k"],
      [999_499, "999k"],
      [999_500, "1.0M"],
      [1_000_000, "1.0M"],
      [24_600_000, "25M"],
      [999_600_000, "1.0B"],
      [1_026_200_000, "1.0B"],
      [12_000_000_000, "12B"],
    ];
    expect(cases.map(([n]) => [n, mod.compactCount(n)])).toEqual(cases);
  });

  it("cost: cents under $1,000, whole dollars with separators from $1,000, so the cost column keeps its width", () => {
    const cost = (cost_usd: number | null) => mod.spendTable({ total: { ...OWNER_TOTAL, cost_usd } }).groups[0]!.rows[0]!.cost;
    expect([0, 0.004, 0.01, 999.99, 1_000, 12_345.67, null].map(cost)).toEqual(["$0.00", "$0.00", "$0.01", "$999.99", "$1,000", "$12,346", "no price"]);
  });

  it("spend groups: Total, By model, Recent sessions in order; no price says so; an empty group is left out", () => {
    const row = (input: number, cost: number | null) => ({ input, output: 2_000, cache_write: 0, cache_read: 1_500_000, cost_usd: cost });
    const t = mod.spendTable({
      total: row(1_200_000, 14.7),
      by_model: [{ model: "claude-sonnet-5", ...row(1_200_000, 14.7) }, { model: "claude-mystery-9", ...row(10, null) }],
      sessions: [{ session_id: "s1", project: "-proj-a", last_activity: "2026-10-17T11:50:00.000Z", ...row(5, 0.01) }],
    });
    expect(t.groups.map((g) => [g.title, g.rows.map((r) => [r.label, ...r.counts.map((c) => c.text), r.cost])])).toEqual([
      [null, [["Total", "1.2M", "2.0k", "0", "1.5M", "$14.70"]]],
      ["By model", [["claude-sonnet-5", "1.2M", "2.0k", "0", "1.5M", "$14.70"], ["claude-mystery-9", "10", "2.0k", "0", "1.5M", "no price"]]],
      ["Recent sessions", [["11:50 · -proj-a", "5", "2.0k", "0", "1.5M", "$0.01"]]],
    ]);
    const bare = mod.spendTable({ total: row(5, 0.01), by_model: [], sessions: [] });
    expect(bare.groups.map((g) => g.title)).toEqual([null]);
  });
});

describe("page spend grid (fake DOM)", () => {
  installFakeDom();
  let tz: string | undefined;
  beforeEach(() => {
    tz = process.env.TZ;
    process.env.TZ = "UTC";
  });
  afterEach(() => {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  });

  it("one header row; each data row is a rowheader and five cells, so no breakdown wraps as one text node", async () => {
    const { spendBlock } = (await import(join(UI_DIR, "usage.js"))) as { spendBlock: (s: unknown) => FakeElement };
    const longProject = `-work-${"a-long-project-name-".repeat(5)}`.slice(0, 80);
    const row = (input: number) => ({ input, output: 5_500_000, cache_write: 25_200_000, cache_read: 1_026_200_000, cost_usd: 1.5 });
    const section = spendBlock({
      window: { start: "2026-10-17T11:30:00.000Z", basis: "trailing_5h", label: "trailing 5 h" },
      total: { input: 27_000, output: 5_500_000, cache_write: 25_200_000, cache_read: 1_026_200_000, cost_usd: 711.01 },
      by_model: [{ model: "claude-opus-5-5", ...row(11_000) }, { model: "claude-mystery-9", ...row(10), cost_usd: null }],
      sessions: [{ session_id: "s1", project: longProject, last_activity: "2026-10-17T11:50:00.000Z", ...row(5) }],
      unpriced_models: ["claude-mystery-9"],
      files_scanned: 3,
      note: "API list-price estimate, not billed",
    });
    const table = walk([section]).els.find((e) => e.attrs.role === "table")!;
    expect(table.attrs.class).toBe("usage-spend");
    const rows = table.children.filter((c): c is FakeElement => c instanceof FakeElement && c.attrs.role === "row");
    const roles = (r: FakeElement) => r.children.map((c) => (c as FakeElement).attrs.role);
    const heads = rows.filter((r) => roles(r).includes("columnheader"));
    expect(heads).toHaveLength(1);
    // An empty corner over the label column, then the five value headers.
    expect(heads[0]!.children.map((c) => textOf(c as FakeElement))).toEqual(["", "in", "out", "cache w", "cache r", "cost"]);
    // The corner has a name, so a screen reader announces six headers over six cells.
    expect((heads[0]!.children[0] as FakeElement).attrs["aria-label"]).toBe("Name");
    const data = rows.filter((r) => roles(r).includes("rowheader"));
    expect(data.map(roles)).toEqual(Array(4).fill(["rowheader", "cell", "cell", "cell", "cell", "cell"]));
    expect(data.map((r) => r.children.map((c) => textOf(c as FakeElement)))).toEqual([
      ["Total", "27k", "5.5M", "25M", "1.0B", "$711.01"],
      ["claude-opus-5-5", "11k", "5.5M", "25M", "1.0B", "$1.50"],
      ["claude-mystery-9", "10", "5.5M", "25M", "1.0B", "no price"],
      [`11:50 · ${longProject}`, "5", "5.5M", "25M", "1.0B", "$1.50"],
    ]);
    expect(data[0]!.attrs.class).toBe("usage-spend-row usage-spend-total");
    expect((data[0]!.children[4] as FakeElement).attrs.title).toBe("1,026,200,000");
    const label = data[3]!.children[0] as FakeElement;
    expect([label.attrs.class, label.attrs.title]).toEqual(["usage-spend-label", `11:50 · ${longProject}`]);
    // Group titles are full-width rows of their own.
    const groups = rows.filter((r) => r.attrs.class === "usage-spend-row usage-spend-group");
    expect(groups.map((r) => textOf(r))).toEqual(["By model", "Recent sessions"]);
    expect(longProject).toHaveLength(80);
  });
});
