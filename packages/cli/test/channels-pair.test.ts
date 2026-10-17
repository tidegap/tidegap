/** `tidegap channels add telegram` pairing (coherence U14, KTD14) against the fake Telegram server. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TaskStore } from "@tidegap/core";

import { DEDICATED_BOT } from "../src/channels/pair.js";
import { OFFSET_META_KEY } from "../src/channels/serve.js";
import { runChannelsAdd, runChannelsList, runChannelsRemove, type ChannelsOptions } from "../src/commands/channels.js";
import { startFakeTelegram, type FakeTelegram } from "../../core-ts/test/fixtures/fake-telegram.js";

const TOKEN = "555:pair-token";
const VARS = ["TIDEGAP_TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_TOKEN", "TIDEGAP_TELEGRAM_API_BASE"] as const;

describe("channels add telegram", () => {
  let dir: string;
  let db: string;
  let tg: FakeTelegram;
  let lines: string[];
  let hook: string[];
  const saved = new Map<string, string | undefined>();

  beforeEach(async () => {
    for (const k of VARS) saved.set(k, process.env[k]);
    dir = mkdtempSync(join(tmpdir(), "tidegap-pair-"));
    db = join(dir, "q.db");
    tg = await startFakeTelegram({ token: TOKEN, maxWaitMs: 50 });
    process.env.TIDEGAP_TELEGRAM_BOT_TOKEN = TOKEN;
    delete process.env.TELEGRAM_BOT_TOKEN;
    process.env.TIDEGAP_TELEGRAM_API_BASE = tg.baseUrl;
    lines = [];
    hook = [];
  });
  afterEach(async () => {
    await tg.close();
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const opts = (over: Partial<ChannelsOptions> = {}): ChannelsOptions => ({
    db,
    envFile: join(dir, "no-env"),
    out: (l) => lines.push(l),
    installListener: (a) => void hook.push(a),
    pairCode: "123456",
    pairTimeoutMs: 400,
    pairPollTimeoutS: 1,
    ...over,
  });

  it("pairs the private chat that sends the right code, unloads then loads the listener, stores the offset", async () => {
    tg.message(77, "/start 999999");
    const id = tg.message(77, "/pair 123456", { username: "vit" });
    const code = await runChannelsAdd("telegram", {}, opts());
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("/pair 123456");
    expect(tg.sent(77).at(-1)).toMatch(/^Paired/);
    expect(hook).toEqual(["unload", "load"]);
    const s = new TaskStore({ dbPath: db });
    expect(s.listChannels().map((c) => c.config)).toEqual([{ chat_id: 77, label: "@vit" }]);
    expect(s.getMeta(OFFSET_META_KEY)).toBe(String(id + 1));
    s.close();
    expect(runChannelsList({}, opts())).toContain("telegram-77");
  });

  it("ignores the right code from a group chat", async () => {
    tg.message(-100, "/pair 123456", { chatType: "group" });
    expect(await runChannelsAdd("telegram", {}, opts())).toBe(1);
    expect(tg.sent()).toEqual([]);
    expect(lines.at(-1)).toContain("timed out");
  });

  it("stops after five wrong codes", async () => {
    for (let i = 0; i < 5; i++) tg.message(77, `/pair 00000${i}`);
    expect(await runChannelsAdd("telegram", {}, opts())).toBe(1);
    expect(lines.at(-1)).toContain("pairing stopped");
    expect(new TaskStore({ dbPath: db }).listChannels()).toEqual([]);
  });

  const pairedBefore = (chatId: number) => {
    const s = new TaskStore({ dbPath: db });
    s.insertChannel({ id: `telegram-${chatId}`, kind: "telegram", enabled: true, events: ["task_done"], config: { chat_id: chatId }, createdAt: new Date().toISOString() });
    s.close();
  };

  it("a pairing that times out loads the listener of the earlier pairing again", async () => {
    pairedBefore(55);
    expect(await runChannelsAdd("telegram", {}, opts())).toBe(1);
    expect(lines.at(-1)).toContain("timed out");
    expect(hook).toEqual(["unload", "load"]);
    expect(new TaskStore({ dbPath: db }).listChannels().map((c) => c.id)).toEqual(["telegram-55"]);
  });

  it("a new pairing replaces the earlier chat", async () => {
    pairedBefore(55);
    tg.message(77, "/pair 123456");
    expect(await runChannelsAdd("telegram", {}, opts())).toBe(0);
    expect(hook).toEqual(["unload", "load"]);
    expect(new TaskStore({ dbPath: db }).listChannels().map((c) => c.id)).toEqual(["telegram-77"]);
  });

  it("without a token exits 1 naming the env file", async () => {
    delete process.env.TIDEGAP_TELEGRAM_BOT_TOKEN;
    expect(await runChannelsAdd("telegram", {}, opts())).toBe(1);
    expect(lines.join("\n")).toContain("~/.config/tidegap/env");
  });

  it("refuses a bot with a webhook", async () => {
    tg.setWebhook("https://elsewhere.example/hook");
    expect(await runChannelsAdd("telegram", {}, opts())).toBe(1);
    expect(lines.at(-1)).toContain(DEDICATED_BOT);
    expect(hook).toEqual([]);
  });

  it("--no-load skips loading; remove of the last telegram channel unloads", async () => {
    tg.message(77, "/pair 123456");
    expect(await runChannelsAdd("telegram", { noLoad: true }, opts())).toBe(0);
    expect(hook).toEqual(["unload"]);
    expect(await runChannelsRemove("telegram-77", opts())).toContain("Removed channel telegram-77");
    expect(hook).toEqual(["unload", "unload"]);
    await expect(runChannelsRemove("telegram-77", opts())).rejects.toThrow("no channel with id telegram-77");
  });
});
