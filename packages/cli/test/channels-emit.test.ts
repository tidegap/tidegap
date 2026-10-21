/** Channel events from the tick and readiness (coherence U14, KTD12). */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assessReadiness, osChannel, TaskStore, TelegramClient, type Readiness } from "@tidegap/core";

import { capPayload, CHANNEL_LAST_META_PREFIX, channelSender, emitEvents, MAX_PAYLOAD_TEXT, MAX_PAYLOAD_TITLE, sendJobs, TICKER_CODES } from "../src/channels/emit.js";
import { startFakeTelegram, type FakeTelegram } from "../../core-ts/test/fixtures/fake-telegram.js";
import { startFakeSink, type FakeSink } from "./fixtures/fake-sink.js";

const TOKEN = "888:emit-token";
const PAIRED = 77;

function notReady(providers: string[]): Readiness {
  return assessReadiness({
    daemon: "loaded",
    lastTickAt: new Date(),
    runners: { providers: [], unknown: [], source: "probe" },
    pendingByProvider: Object.fromEntries(providers.map((p) => [p, 1])),
  });
}

describe("emitEvents", () => {
  let dir: string;
  let store: TaskStore;
  let tg: FakeTelegram;
  let send: ReturnType<typeof channelSender>;
  let logs: string[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-emit-"));
    store = new TaskStore({ dbPath: join(dir, "q.db") });
    store.insertChannel({ id: "telegram-77", kind: "telegram", enabled: true, events: ["task_done", "task_failed", "clean_window", "not_ready"], config: { chat_id: PAIRED }, createdAt: new Date().toISOString() });
    tg = await startFakeTelegram({ token: TOKEN });
    send = channelSender({ telegram: new TelegramClient({ token: TOKEN, baseUrl: tg.baseUrl }) });
    logs = [];
  });
  afterEach(async () => {
    await tg.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const emit = (over: Partial<Parameters<typeof emitEvents>[0]> = {}) => emitEvents({ store, send, log: (l) => logs.push(l), ...over });

  it("the same not-ready set twice sends one message; a changed set sends a second", async () => {
    await emit({ readiness: notReady(["openai"]) });
    await emit({ readiness: notReady(["openai"]) });
    expect(tg.sent(PAIRED)).toHaveLength(1);
    expect(tg.sent(PAIRED)[0]).toContain("1 openai task has no runner");
    await emit({ readiness: notReady(["openai", "gemini"]) });
    expect(tg.sent(PAIRED)).toHaveLength(2);
  });

  it("not ready, ready, the same not ready: two messages", async () => {
    await emit({ readiness: notReady(["openai"]) });
    await emit({ readiness: notReady([]) });
    await emit({ readiness: notReady(["openai"]) });
    expect(tg.sent(PAIRED)).toHaveLength(2);
  });

  it("the tick and the listener keep their own codes under one key", async () => {
    const stale = assessReadiness({ daemon: "loaded", lastTickAt: new Date(Date.now() - 3_600_000), runners: null, pendingByProvider: {} });
    await emit({ readiness: stale, readinessScope: TICKER_CODES });
    await emit({ readiness: notReady(["openai"]) });
    await emit({ readiness: stale, readinessScope: TICKER_CODES });
    await emit({ readiness: notReady(["openai"]) });
    expect(tg.sent(PAIRED)).toHaveLength(2);
  });

  it("a clean window starting sends one message per window start", async () => {
    const now = new Date();
    const window = { start: new Date(now.getTime() - 60_000).toISOString(), end: new Date(now.getTime() + 3_600_000).toISOString(), g: 80 };
    await emit({ cleanWindow: window, now });
    await emit({ cleanWindow: window, now });
    expect(tg.sent(PAIRED)).toHaveLength(1);
    expect(tg.sent(PAIRED)[0]).toMatch(/^Clean window starting: .*80 gCO2e\/kWh/);
    await emit({ cleanWindow: { ...window, start: new Date(now.getTime() + 60_000).toISOString() }, now });
    expect(tg.sent(PAIRED)).toHaveLength(1);
  });

  it("a finished task sends the done message with its preview and a Result button", async () => {
    store.upsert({ taskId: "t-9", status: "completed", enqueuedAt: now(), completedAt: now(), region: "DE", title: "Digest", result: { text: "all good" } });
    await emit({ results: [{ taskId: "t-9", status: "completed" }, { taskId: "t-x", status: "submitted" }], extraChannels: [osChannel(false)] });
    const [call] = tg.calls("sendMessage");
    expect(String(call!.body.text)).toContain("Done: Digest");
    expect(String(call!.body.text)).toContain("all good");
    expect(call!.body.reply_markup).toEqual({ inline_keyboard: [[{ text: "Result", callback_data: "r:t-9" }]] });
    expect(tg.calls("sendMessage")).toHaveLength(1);
  });

  it("a registry kind without secrets and driver context fails its job with a log line and does not count as sent", async () => {
    store.insertChannel({ id: "webhook", kind: "webhook", enabled: true, events: ["not_ready"], config: {}, createdAt: new Date().toISOString() });
    store.removeChannel("telegram-77");
    const res = await emit({ readiness: notReady(["openai"]) });
    expect(res).toEqual({ sent: 0, failed: 1 });
    expect(logs).toEqual(["tidegap: webhook: not_ready not sent: delivery failed: not_configured"]);
  });

  it("a Telegram failure is one log line and does not throw", async () => {
    tg.fail("sendMessage", 500);
    const res = await emit({ readiness: notReady(["openai"]) });
    expect(res).toEqual({ sent: 0, failed: 1 });
    expect(logs).toEqual(["tidegap: telegram-77: not_ready not sent: Telegram sendMessage: HTTP 500: fake 500"]);
  });

  it("a not-ready message that failed to send is sent on the first run after the channel's backoff", async () => {
    tg.fail("sendMessage", 500);
    const t0 = Date.now();
    const at = (ms: number) => ({ readiness: notReady(["openai"]), now: new Date(t0 + ms) });
    expect(await emit(at(0))).toEqual({ sent: 0, failed: 1 });
    expect(await emit(at(30_000))).toEqual({ sent: 0, failed: 0 });
    expect(await emit(at(61_000))).toEqual({ sent: 1, failed: 0 });
    expect(await emit(at(120_000))).toEqual({ sent: 0, failed: 0 });
  });
});

describe("registry kinds through the drivers (integrations plan U2)", () => {
  /** The secret path part of the fixture URL: must never reach a log line. */
  const SECRET_PATH = "/services/T0001/B0001/hooksSecretXyZ";
  let dir: string;
  let store: TaskStore;
  let sink: FakeSink;
  let logs: string[];
  let secrets: Record<string, Record<string, string>>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-emit-reg-"));
    store = new TaskStore({ dbPath: join(dir, "q.db") });
    sink = await startFakeSink();
    secrets = { webhook: { url: `${sink.baseUrl}${SECRET_PATH}` } };
    logs = [];
  });
  afterEach(async () => {
    for (const l of logs) expect(l).not.toContain(SECRET_PATH);
    await sink.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const webhookRow = (config: Record<string, unknown> = {}) =>
    store.insertChannel({ id: "webhook", kind: "webhook", enabled: true, events: ["task_done", "not_ready"], config, createdAt: new Date().toISOString() });
  const sender = () =>
    channelSender({ secrets: (id) => secrets[id], driver: { http: { uiPorts: [47821], sleep: async () => {} } } });
  const emit = (over: Partial<Parameters<typeof emitEvents>[0]> = {}) => emitEvents({ store, send: sender(), log: (l) => logs.push(l), ...over });
  const last = (id = "webhook") => JSON.parse(store.getMeta(`${CHANNEL_LAST_META_PREFIX}${id}`) ?? "null");

  it("a webhook channel gets the Tidegap JSON body and channel_last records ok", async () => {
    webhookRow();
    expect(await emit({ readiness: notReady(["openai"]) })).toEqual({ sent: 1, failed: 0 });
    const [req] = sink.requests(SECRET_PATH);
    const body = JSON.parse(req!.body);
    expect(body).toMatchObject({ version: 1, event: "not_ready", level: "warning" });
    expect(body.text).toContain("openai");
    expect(last()).toMatchObject({ ok: true });
    expect(last().code).toBeUndefined();
  });

  it("a quiet channel at 23:10 gets no job; its channel_last is unchanged", async () => {
    webhookRow({ quiet: "night" });
    const d = new Date();
    const late = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 10);
    expect(await emit({ readiness: notReady(["openai"]), now: late })).toEqual({ sent: 0, failed: 0 });
    expect(sink.requests()).toHaveLength(0);
    expect(store.getMeta(`${CHANNEL_LAST_META_PREFIX}webhook`)).toBeUndefined();
    // Held, not sent: the same problem goes out once the quiet hours end.
    const morning = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 9, 5);
    expect(await emit({ readiness: notReady(["openai"]), now: morning })).toEqual({ sent: 1, failed: 0 });
    expect(await emit({ readiness: notReady(["openai"]), now: morning })).toEqual({ sent: 0, failed: 0 });
  });

  it("a quiet and an awake channel on the same event at 23:10: the awake one sends, the quiet one does not, and the event is not replayed in the morning", async () => {
    webhookRow({ quiet: "night" });
    store.insertChannel({ id: "webhook-awake", kind: "webhook", enabled: true, events: ["task_done", "not_ready"], config: {}, createdAt: new Date().toISOString() });
    const awakePath = "/hook/awake-0123456789";
    secrets["webhook-awake"] = { url: `${sink.baseUrl}${awakePath}` };
    const d = new Date();
    const late = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 10);
    expect(await emit({ readiness: notReady(["openai"]), now: late })).toEqual({ sent: 1, failed: 0 });
    expect(sink.requests(awakePath)).toHaveLength(1);
    expect(sink.requests(SECRET_PATH)).toHaveLength(0);
    expect(store.getMeta(`${CHANNEL_LAST_META_PREFIX}webhook`)).toBeUndefined();
    expect(last("webhook-awake")).toMatchObject({ ok: true });
    // Another channel got it, so it is not held for the quiet one.
    const morning = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 9, 5);
    expect(await emit({ readiness: notReady(["openai"]), now: morning })).toEqual({ sent: 0, failed: 0 });
    expect(sink.requests(SECRET_PATH)).toHaveLength(0);
  });

  it("a title over 256 characters is cut to 256 with an ellipsis; a 256-character title is sent whole", async () => {
    expect(MAX_PAYLOAD_TITLE).toBe(256);
    expect(capPayload({ event: "digest", level: "info", title: "t".repeat(256), text: "x", at: "" }).title).toBe("t".repeat(256));
    const cut = capPayload({ event: "digest", level: "info", title: "t".repeat(257), text: "x", at: "" }).title;
    expect([cut.length, cut.endsWith("…")]).toEqual([256, true]);
    store.insertChannel({ id: "webhook", kind: "webhook", enabled: true, events: ["digest"], config: {}, createdAt: new Date().toISOString() });
    const channel = store.listChannels()[0]!;
    await sendJobs([{ channel, event: { kind: "digest", title: "T".repeat(300), text: "body" } }], sender(), (l) => logs.push(l));
    const body = JSON.parse(sink.requests(SECRET_PATH)[0]!.body);
    expect(body.title).toBe(`${"T".repeat(255)}…`);
  });

  it("a failing driver is one log line with the id and the code, no URL path, and channel_last records the code", async () => {
    webhookRow();
    sink.script(SECRET_PATH, [{ status: 404, body: `unknown ${SECRET_PATH}` }]);
    expect(await emit({ readiness: notReady(["openai"]) })).toEqual({ sent: 0, failed: 1 });
    expect(logs).toEqual(["tidegap: webhook: not_ready not sent: delivery failed: http_404"]);
    expect(last()).toMatchObject({ ok: false, code: "http_404" });
  });

  it("a missing secret fails invalid_config: a Pushover row with no keys, a webhook with no URL", async () => {
    store.insertChannel({ id: "pushover", kind: "pushover", enabled: true, events: ["not_ready"], config: {}, createdAt: new Date().toISOString() });
    webhookRow();
    delete secrets.webhook;
    await emit({ readiness: notReady(["openai"]) });
    expect(last("pushover")).toMatchObject({ ok: false, code: "invalid_config" });
    expect(last()).toMatchObject({ ok: false, code: "invalid_config" });
  });

  it("stored headers that break KTD13 fail invalid_config and nothing is sent", async () => {
    webhookRow();
    secrets.webhook = { ...secrets.webhook!, headers: "Host: evil" };
    await emit({ readiness: notReady(["openai"]) });
    expect(last()).toMatchObject({ ok: false, code: "invalid_config" });
    expect(sink.requests(SECRET_PATH)).toEqual([]);
  });

  it("a blocked URL fails with its policy code and nothing is sent", async () => {
    webhookRow();
    secrets.webhook = { url: "http://169.254.169.254/latest/meta-data" };
    await emit({ readiness: notReady(["openai"]) });
    expect(last()).toMatchObject({ ok: false, code: "blocked_address" });
  });

  it("a long digest text is capped at the transport boundary", async () => {
    store.insertChannel({ id: "webhook", kind: "webhook", enabled: true, events: ["digest"], config: {}, createdAt: new Date().toISOString() });
    const channel = store.listChannels()[0]!;
    const res = await sendJobs([{ channel, event: { kind: "digest", title: "Daily summary", text: "y".repeat(20_000) } }], sender(), (l) => logs.push(l));
    expect(res.sent).toBe(1);
    const body = JSON.parse(sink.requests(SECRET_PATH)[0]!.body);
    expect(body.text.length).toBe(MAX_PAYLOAD_TEXT);
    expect(body.text.endsWith("…")).toBe(true);
  });
});

function now(): string {
  return new Date().toISOString();
}
