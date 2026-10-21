/** `/api/integrations*` (integrations plan U5) over HTTP against the fake Telegram server. */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mockGridFeed, TaskStore } from "@tidegap/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readSecrets } from "../src/channels/secrets.js";
import { LISTENER_META_KEY } from "../src/channels/serve.js";
import { SETUP_TEXT } from "../src/channels/telegram-setup.js";
import { startUiServer, type UiServer } from "../src/ui/server.js";
import { startFakeTelegram, type FakeTelegram } from "../../core-ts/test/fixtures/fake-telegram.js";
import { startFakeSink } from "./fixtures/fake-sink.js";

const PAGE = "page-token-0123456789";
const BOT_TOKEN = "123456:AAbbCCddEEffGGhhIIjjKKllMMnnOOwXyZ";

describe("/api/integrations", () => {
  let dir: string;
  let envFile: string;
  let tg: FakeTelegram;
  let ui: UiServer;
  let hook: string[];
  /** Raw response texts: none may hold the token. */
  let texts: string[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-ui-integrations-"));
    envFile = join(dir, "env");
    tg = await startFakeTelegram({ token: BOT_TOKEN, maxWaitMs: 50, botUsername: "tg_test_bot" });
    hook = [];
    texts = [];
    ui = await startUiServer({
      token: PAGE,
      dbPath: join(dir, "queue.db"),
      stateDir: dir,
      assetDir: dir,
      feed: mockGridFeed(),
      defaultRegion: "FR",
      quota: () => ({}),
      daemonStatus: () => "unknown",
      integrations: {
        envFile,
        apiBase: tg.baseUrl,
        installListener: (a) => void hook.push(a),
        platform: "linux",
        home: dir,
        pair: { code: "123456", pollTimeoutS: 1 },
      },
    });
  });
  afterEach(async () => {
    for (const t of texts) expect(t).not.toContain(BOT_TOKEN.split(":")[1]);
    await ui.close();
    await tg.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const api = async (path: string, init: { method?: string; json?: unknown; type?: string; body?: string } = {}) => {
    const headers: Record<string, string> = { authorization: `Bearer ${PAGE}` };
    let body = init.body;
    if (init.json !== undefined) {
      headers["content-type"] = init.type ?? "application/json";
      body = JSON.stringify(init.json);
    }
    const res = await fetch(`${ui.url}api/integrations${path}`, { method: init.method ?? (body === undefined ? "GET" : "POST"), headers, body });
    const text = await res.text();
    texts.push(text);
    return { status: res.status, body: JSON.parse(text) as Record<string, any> };
  };
  const post = (path: string, json?: unknown) => api(path, json === undefined ? { method: "POST" } : { json });
  const telegram = async () => (await api("")).body.telegram;

  const pairedRow = (chatId = 55) => {
    const s = new TaskStore({ dbPath: join(dir, "queue.db") });
    s.insertChannel({ id: `telegram-${chatId}`, kind: "telegram", enabled: true, events: ["task_done"], config: { chat_id: chatId }, createdAt: new Date().toISOString() });
    return s;
  };

  it("covers AE1: a saved token shows as its last 4 characters only", async () => {
    expect(await telegram()).toEqual({ state: "not_configured" });
    const saved = await post("/telegram/token", { token: BOT_TOKEN });
    expect(saved.status).toBe(200);
    expect(saved.body.telegram).toEqual({ state: "token_saved", token_hint: "wXyZ", bot_username: "tg_test_bot", profile_set: true });
    for (const m of ["setMyShortDescription", "setMyDescription", "setMyCommands"]) expect(tg.calls(m)).toHaveLength(1);
    const cmds = (tg.calls("setMyCommands")[0]!.body as { commands: { command: string; description: string }[] }).commands;
    expect(cmds.map((c) => c.command)).toEqual(["queue", "later", "run", "cancel", "result", "help"]);
    expect(cmds.every((c) => /^[a-z_]+$/.test(c.command) && c.description.length <= 256)).toBe(true);
    expect(JSON.stringify(saved.body)).not.toContain(BOT_TOKEN);
    expect(await telegram()).toMatchObject({ token_hint: "wXyZ", bot_username: "tg_test_bot" });
    expect(readFileSync(envFile, "utf8")).toContain(`TIDEGAP_TELEGRAM_BOT_TOKEN=${BOT_TOKEN}`);
  });

  it("GET returns the daily summary (send time, last send), which turns on the card's Daily summary chip", async () => {
    expect((await api("")).body.digest).toEqual({ at: "09:00" });
    const s = pairedRow(56);
    s.setMeta("digest_at", "07:30");
    // The window mark alone (an empty day) is not a send.
    s.setMeta("notified:digest", "2026-10-21T07:30:00.000Z");
    s.setMeta("digest_sent", "2026-10-20T07:30:00.000Z");
    s.removeChannel("telegram-56");
    s.close();
    expect((await api("")).body.digest).toEqual({ at: "07:30", last: "2026-10-20T07:30:00.000Z" });
  });

  it("POST /digest sets the send time with the CLI's validation; GET reads it back", async () => {
    expect(await post("/digest", { at: "07:30" })).toEqual({ status: 200, body: { digest: { at: "07:30" } } });
    expect((await api("")).body.digest).toEqual({ at: "07:30" });
    for (const at of ["7:30", "24:00", "07:60", "", "07:30:00"]) {
      expect(await post("/digest", { at })).toEqual({ status: 400, body: { error: "Give the time as HH:MM, 00:00 to 23:59.", code: "invalid", field: "at" } });
    }
    expect((await post("/digest", { at: 730 })).body).toMatchObject({ code: "invalid", field: "at" });
    expect((await post("/digest", { at: "08:00", extra: 1 })).status).toBe(400);
    expect((await api("/digest", { json: { at: "08:00" }, type: "text/plain" })).status).toBe(415);
    expect((await api("/digest")).status).toBe(405);
    expect((await api("")).body.digest).toEqual({ at: "07:30" });
  });

  it("a failed profile call is not fatal: the token is saved, the card gets a sentence, Connect retries", async () => {
    await post("/telegram/disconnect", { forget_token: true });
    tg.fail("setMyDescription", 500, 1);
    const saved = await post("/telegram/token", { token: BOT_TOKEN });
    expect(saved.status).toBe(200);
    expect(saved.body.telegram).toMatchObject({ state: "token_saved", profile_set: false, profile_error: expect.stringContaining("description") });
    expect((await post("/telegram/pair")).status).toBe(202);
    await vi.waitFor(async () => expect((await telegram()).profile_set).toBe(true));
    await post("/telegram/pair/cancel");
  });

  it("the token route keeps the body rules: 415, 400 for an extra field, 400 for a bad format with the env file untouched", async () => {
    expect((await api("/telegram/token", { json: { token: BOT_TOKEN }, type: "text/plain" })).status).toBe(415);
    expect((await post("/telegram/token", { token: "x", extra: 1 })).status).toBe(400);
    const bad = await post("/telegram/token", { token: "not a token" });
    expect(bad).toEqual({ status: 400, body: { error: SETUP_TEXT.format, code: "format" } });
    expect(() => readFileSync(envFile)).toThrow();
    expect((await api("/telegram/pair", { method: "POST", body: "{}" })).status).toBe(400);
    expect((await api("/telegram/token")).status).toBe(405);
    expect((await api("/telegram/nope", { method: "POST" })).status).toBe(404);
  });

  it("covers AE3: save, pair, /start code, paired, test message, disconnect", async () => {
    await post("/telegram/token", { token: BOT_TOKEN });
    const pair = await post("/telegram/pair");
    expect(pair.status).toBe(202);
    expect(pair.body.telegram.pairing).toMatchObject({ code: "123456", link: "https://t.me/tg_test_bot?start=123456" });
    const again = await post("/telegram/pair");
    expect(again.status).toBe(200);
    expect(again.body.telegram.pairing.code).toBe("123456");

    tg.message(77, "/start 123456", { username: "user" });
    await vi.waitFor(async () => expect((await telegram()).state).toBe("paired"), { timeout: 3000 });
    expect((await telegram()).chat).toEqual({ channel_id: "telegram-77", label: "@user" });

    tg.clearCalls();
    expect(await post("/telegram/test")).toEqual({ status: 200, body: { sent: true } });
    expect(tg.calls("sendMessage").map((c) => c.body.chat_id)).toEqual([77]);

    const off = await post("/telegram/disconnect", {});
    expect(off.status).toBe(200);
    expect(off.body.telegram.state).toBe("token_saved");
    expect(hook.at(-1)).toBe("unload");
  });

  it("pair without a token is 409 with the sentence; a 409 from Telegram during pairing shows the error", async () => {
    expect(await post("/telegram/pair")).toEqual({ status: 409, body: { error: SETUP_TEXT.no_token, code: "no_token" } });
    writeFileSync(envFile, `TIDEGAP_TELEGRAM_BOT_TOKEN=${BOT_TOKEN}\n`);
    tg.fail("getUpdates", 409, 1);
    expect((await post("/telegram/pair")).status).toBe(202);
    await vi.waitFor(async () => expect(await telegram()).toMatchObject({ state: "error", error: SETUP_TEXT.pair_conflict }));
  });

  it("rate limits: a second test within 10 s and a sixth token save in a minute get 429 with retry_after_s", async () => {
    pairedRow().close();
    writeFileSync(envFile, `TIDEGAP_TELEGRAM_BOT_TOKEN=${BOT_TOKEN}\n`);
    expect((await post("/telegram/test")).status).toBe(200);
    const second = await post("/telegram/test");
    expect(second.status).toBe(429);
    expect(second.body.retry_after_s).toBeGreaterThan(0);
    for (let i = 0; i < 5; i++) expect((await post("/telegram/token", { token: "bad" })).status).toBe(400);
    expect((await post("/telegram/token", { token: "bad" })).status).toBe(429);
  });

  it("an old heartbeat reads not running; Start listener restarts the unit", async () => {
    writeFileSync(envFile, `TIDEGAP_TELEGRAM_BOT_TOKEN=${BOT_TOKEN}\n`);
    const s = pairedRow();
    s.setMeta(LISTENER_META_KEY, JSON.stringify({ at: new Date(Date.now() - 4 * 60_000).toISOString(), state: "ok" }));
    s.close();
    expect((await telegram()).listener).toEqual({ state: "not_running", message: SETUP_TEXT.listener_not_running });
    expect((await post("/telegram/listener/start")).status).toBe(200);
    expect(hook).toEqual(["unload", "load"]);
  });

  it("server close during pairing ends it and loads the earlier chat's listener again", async () => {
    writeFileSync(envFile, `TIDEGAP_TELEGRAM_BOT_TOKEN=${BOT_TOKEN}\n`);
    pairedRow().close();
    expect((await post("/telegram/pair")).status).toBe(202);
    await ui.close();
    expect(hook).toEqual(["unload", "load"]);
    // afterEach closes again: harmless.
    ui = { ...ui, close: async () => {} };
  });

  it("a failed env-file write is 500 with a fixed sentence and no exception text", async () => {
    mkdirSync(envFile);
    const res = await post("/telegram/token", { token: BOT_TOKEN });
    expect(res).toEqual({ status: 500, body: { error: "Tidegap could not save the change. Try again.", code: "internal" } });
  });

  it("no integrations route writes a task event", async () => {
    await post("/telegram/token", { token: BOT_TOKEN });
    await post("/telegram/pair");
    await post("/telegram/pair/cancel");
    await post("/telegram/disconnect", { forget_token: true });
    const s = new TaskStore({ dbPath: join(dir, "queue.db") });
    const db = (s as unknown as { db: { prepare(sql: string): { get(): { n: number } } } }).db;
    expect(db.prepare("SELECT COUNT(*) AS n FROM task_events").get().n).toBe(0);
    s.close();
  });

  describe("channels (all-channels plan U3, contract docs/plans/2026-10-19-channels-api-contract.md)", () => {
    const HOOK = "/hook/ui-s3cr3t-0123456789abcdef";

    it("covers AE1: a 404 from the receiver is 409 test_failed on the url field, nothing saved", async () => {
      const sink = await startFakeSink();
      try {
        sink.script(HOOK, [{ status: 404 }]);
        const res = await post("/channels/connect", { kind: "webhook", fields: { url: `${sink.baseUrl}${HOOK}` } });
        expect(res.status).toBe(409);
        expect(res.body).toEqual({ error: "The receiver does not know this address. Copy the URL again.", code: "test_failed", field: "url", delivery: "http_404" });
        expect((await api("")).body.channels).toEqual([]);
      } finally {
        await sink.close();
      }
    });

    it("connect, GET, settings, test, disconnect and remove: answers never hold the secret", async () => {
      const sink = await startFakeSink();
      const url = `${sink.baseUrl}${HOOK}`;
      try {
        const connected = await post("/channels/connect", { kind: "webhook", fields: { url }, quiet: "night" });
        expect(connected.status).toBe(200);
        expect(connected.body.channel).toMatchObject({ id: "webhook", state: "connected", quiet: "night", last: { ok: true } });
        expect(readSecrets("webhook", join(dir, ".config", "tidegap", "channel-secrets.json"))).toEqual({ url });
        const all = await api("");
        expect(all.body.kinds.map((k: { kind: string }) => k.kind)).toContain("webhook");
        expect(all.body.channels).toEqual([connected.body.channel]);
        const set = await post("/channels/webhook/settings", { events: ["task_failed"] });
        expect(set).toMatchObject({ status: 200, body: { channel: { events: ["task_failed"], quiet: "night" } } });
        expect(await post("/channels/webhook/test")).toMatchObject({ status: 200, body: { sent: true, channel: { state: "connected" } } });
        expect((await post("/channels/webhook/test")).body).toMatchObject({ code: "rate_limited", retry_after_s: expect.any(Number) });
        const signed = await post("/channels/connect", { kind: "webhook", fields: { secret: "qa-signing-secret-1" } });
        expect(Object.keys(signed.body.channel.secrets).sort()).toEqual(["secret", "url"]);
        const cleared = await post("/channels/connect", { kind: "webhook", clear: ["secret"] });
        expect(Object.keys(cleared.body.channel.secrets)).toEqual(["url"]);
        expect(await post("/channels/connect", { kind: "webhook", clear: ["url"] })).toMatchObject({ status: 400, body: { code: "invalid", field: "url" } });
        expect((await post("/channels/webhook/disconnect")).body.channel.state).toBe("disconnected");
        expect(await post("/channels/webhook/remove")).toEqual({ status: 200, body: { removed: true } });
        expect((await post("/channels/webhook/remove")).body).toMatchObject({ code: "not_found" });
        expect(sink.requests(HOOK)).toHaveLength(4);
        for (const t of texts) expect(t).not.toContain("s3cr3t");
      } finally {
        await sink.close();
      }
    });

    it("the body and route rules: 400 invalid for a bad shape, 404 for an unknown kind or route, 405 for GET", async () => {
      expect(await post("/channels/connect", { kind: "webhook", extra: 1 })).toMatchObject({ status: 400, body: { code: "invalid" } });
      expect(await post("/channels/connect", { fields: {} })).toMatchObject({ status: 400, body: { code: "invalid" } });
      expect(await post("/channels/connect", { kind: "webhook", fields: [] })).toMatchObject({ status: 400, body: { code: "invalid" } });
      expect(await post("/channels/connect", { kind: "webhook", fields: { url: "" } })).toMatchObject({ status: 400, body: { code: "invalid", field: "url" } });
      expect(await post("/channels/connect", { kind: "webhook", fields: { url: `http://127.0.0.1:${new URL(ui.url).port}/x` } })).toMatchObject({ status: 400, body: { code: "invalid", field: "url" } });
      expect(await post("/channels/connect", { kind: "fax" })).toMatchObject({ status: 404, body: { code: "unknown_kind" } });
      expect(await post("/channels/connect", { kind: "telegram" })).toMatchObject({ status: 409, body: { code: "telegram" } });
      expect(await post("/channels/webhook/settings", {})).toMatchObject({ status: 400, body: { code: "invalid" } });
      expect(await post("/channels/webhook/settings", { events: ["x"] })).toMatchObject({ status: 400, body: { code: "invalid", field: "events" } });
      expect((await post("/channels/webhook/test")).status).toBe(404);
      expect((await api("/channels/webhook/test", { method: "POST", body: "{}" })).status).toBe(400);
      expect((await post("/channels/webhook/nope")).status).toBe(404);
      expect((await api("/channels/connect")).status).toBe(405);
    });

    it("settings reach a Telegram row", async () => {
      pairedRow().close();
      const res = await post("/channels/telegram-55/settings", { quiet: "night" });
      expect(res).toMatchObject({ status: 200, body: { channel: { id: "telegram-55", kind: "telegram", quiet: "night" } } });
      expect((await post("/channels/telegram-55/test")).body.code).toBe("telegram");
    });
  });
});
