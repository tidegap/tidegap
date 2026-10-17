/** Channel events from the tick and readiness (coherence U14, KTD12). */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assessReadiness, osChannel, TaskStore, TelegramClient, type Readiness } from "@tidegap/core";

import { channelSender, emitEvents, TICKER_CODES } from "../src/channels/emit.js";
import { startFakeTelegram, type FakeTelegram } from "../../core-ts/test/fixtures/fake-telegram.js";

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

  it("a Telegram failure is one log line and does not throw", async () => {
    tg.fail("sendMessage", 500);
    const res = await emit({ readiness: notReady(["openai"]) });
    expect(res).toEqual({ sent: 0, failed: 1 });
    expect(logs).toEqual(["tidegap: telegram-77: not_ready not sent: Telegram sendMessage: HTTP 500: fake 500"]);
  });
});

function now(): string {
  return new Date().toISOString();
}
