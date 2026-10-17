/** The channel listener (coherence U14, KTD11) against the fake Telegram server. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  assessReadiness,
  commandContextFor,
  LAST_TICK_META_KEY,
  LIMIT_RESET_HINT_META_KEY,
  mockGridFeed,
  Scheduler,
  TaskStore,
  TelegramClient,
  type Readiness,
} from "@tidegap/core";

import { ChannelListener, OFFSET_META_KEY, tickerReadiness } from "../src/channels/serve.js";
import { runChannelsServe } from "../src/commands/channels.js";
import { startFakeTelegram, type FakeTelegram } from "../../core-ts/test/fixtures/fake-telegram.js";

const TOKEN = "666:serve-token";
const PAIRED = 77;
const SPEC = { type: "provider_call" as const, provider: "anthropic" as const, model: "claude-sonnet-4-6", prompt: "Summarize the changelog" };
const READY: Readiness = assessReadiness({ daemon: "loaded", lastTickAt: new Date(), runners: null, pendingByProvider: {} });

function hhmm(iso: string | undefined): string {
  const d = new Date(iso!);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

describe("ChannelListener", () => {
  let dir: string;
  let store: TaskStore;
  let scheduler: Scheduler;
  let tg: FakeTelegram;
  let logs: string[];

  beforeEach(async () => {
    // 08:00 local: a task due within 2 h plans before 14:10 and tonight.
    const d = new Date();
    vi.useFakeTimers({ now: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 8, 0, 0), toFake: ["Date"] });
    dir = mkdtempSync(join(tmpdir(), "tidegap-serve-"));
    store = new TaskStore({ dbPath: join(dir, "q.db") });
    scheduler = new Scheduler({ store, feed: mockGridFeed(), signing: false, eager: false, rng: () => 0 });
    store.insertChannel({ id: "telegram-77", kind: "telegram", enabled: true, events: ["task_done", "task_failed", "clean_window", "not_ready"], config: { chat_id: PAIRED }, createdAt: new Date().toISOString() });
    tg = await startFakeTelegram({ token: TOKEN, maxWaitMs: 20 });
    logs = [];
  });
  afterEach(async () => {
    vi.useRealTimers();
    await tg.close();
    scheduler.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  function listener(over: { token?: string; readiness?: () => Readiness; sleep?: (ms: number) => Promise<void>; signal?: AbortSignal } = {}) {
    return new ChannelListener({
      store,
      client: new TelegramClient({ token: over.token ?? TOKEN, baseUrl: tg.baseUrl }),
      commands: commandContextFor(scheduler, store),
      readiness: over.readiness ?? (() => READY),
      log: (l) => logs.push(l),
      pollTimeoutS: 1,
      sleep: over.sleep,
      signal: over.signal,
    });
  }

  const enqueue = (prompt: string, hours = 2) =>
    scheduler.enqueueProviderCall({ ...SPEC, prompt }, { deadline: new Date(Date.now() + hours * 3_600_000), region: "DE" });

  it("an update from another chat gets no reply and changes nothing", async () => {
    const t = await enqueue("Other chat");
    tg.message(999, `/cancel ${t.taskId}`);
    await listener().cycle();
    expect(tg.sent()).toEqual([]);
    expect(store.get(t.taskId)!.status).not.toBe("cancelled");
  });

  it("a chat removed between two updates loses access on the second", async () => {
    const t = await enqueue("Removed chat");
    const l = listener();
    tg.message(PAIRED, "/help");
    await l.cycle();
    expect(tg.sent(PAIRED)).toHaveLength(1);
    store.removeChannel("telegram-77");
    tg.message(PAIRED, `/cancel ${t.taskId}`);
    await l.cycle();
    expect(tg.sent(PAIRED)).toHaveLength(1);
    expect(store.get(t.taskId)!.status).not.toBe("cancelled");
  });

  it("/cancel 2 with no /queue since start asks for /queue and writes nothing", async () => {
    await enqueue("One");
    const t2 = await enqueue("Two");
    tg.message(PAIRED, "/cancel 2");
    await listener().cycle();
    expect(tg.sent(PAIRED)[0]).toMatch(/^Send \/queue first/);
    expect(store.get(t2.taskId)!.status).not.toBe("cancelled");
  });

  it("/queue lists numbered tasks with buttons; /run 1 runs the first and names it", async () => {
    const t = await enqueue("Weekly digest", 1);
    await enqueue("Second", 2);
    const l = listener();
    tg.message(PAIRED, "/queue");
    await l.cycle();
    const [queueCall] = tg.calls("sendMessage");
    expect(String(queueCall!.body.text)).toContain("1. Weekly digest");
    expect(JSON.stringify(queueCall!.body.reply_markup)).toContain(`"x:${t.taskId}"`);
    tg.message(PAIRED, "/run 1");
    await l.cycle();
    expect(tg.sent(PAIRED).at(-1)).toBe("Runs at the next tick: Weekly digest.");
    expect(store.get(t.taskId)!.intensitySource).toBe("expedited");
  });

  it("/later <id> reset without a known reset asks for the time", async () => {
    const t = await enqueue("Reset me");
    tg.message(PAIRED, `/later ${t.taskId} reset`);
    await listener().cycle();
    expect(tg.sent(PAIRED)[0]).toContain(`needs the reset time: /later ${t.taskId} reset HH:MM`);
  });

  it("/later <id> reset 14:05 postpones to 14:10 and stores the hint", async () => {
    const t = await enqueue("Reset me");
    tg.message(PAIRED, `/later ${t.taskId} reset 14:05`);
    await listener().cycle();
    expect(tg.sent(PAIRED)[0]).toBe("Moved: Reset me. Not before 14:10.");
    expect(hhmm(store.get(t.taskId)!.notBefore)).toBe("14:10");
    expect(store.getMeta(LIMIT_RESET_HINT_META_KEY)).toBeTruthy();
  });

  it("a Cancel press cancels, answers the query and removes the buttons", async () => {
    const t = await enqueue("Press me");
    tg.callback(PAIRED, `c:${t.taskId}`, { messageId: 5 });
    await listener().cycle();
    expect(store.get(t.taskId)!.status).toBe("cancelled");
    expect(tg.calls("answerCallbackQuery")).toHaveLength(1);
    expect(tg.calls("editMessageReplyMarkup")[0]!.body).toMatchObject({ chat_id: PAIRED, message_id: 5, reply_markup: { inline_keyboard: [] } });
    expect(tg.sent(PAIRED)).toEqual(["Cancelled: Press me."]);
  });

  it("a restart continues from the stored offset", async () => {
    const id = tg.message(PAIRED, "/help");
    await listener().cycle();
    expect(store.getMeta(OFFSET_META_KEY)).toBe(String(id + 1));
    tg.clearCalls();
    await listener().cycle();
    expect(tg.calls("getUpdates")[0]!.body.offset).toBe(id + 1);
    expect(tg.sent()).toEqual([]);
  });

  it("no tick for 11 minutes sends one not-ready message; the next cycle sends none", async () => {
    const home = join(dir, "home");
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(join(home, "Library", "LaunchAgents", "com.tidegap.tick.plist"), "<plist/>");
    store.setMeta(LAST_TICK_META_KEY, new Date(Date.now() - 11 * 60_000).toISOString());
    const l = listener({ readiness: () => tickerReadiness(store, { platform: "darwin", home }) });
    await l.cycle();
    await l.cycle();
    const sent = tg.sent(PAIRED);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^Tidegap: the tick daemon is not running\.\nTasks may not run: the tick daemon last ran 11 minutes ago/);
  });

  it("401 logs and sleeps 10 minutes instead of looping", async () => {
    const controller = new AbortController();
    const sleeps: number[] = [];
    const l = listener({
      token: "wrong",
      signal: controller.signal,
      sleep: async (ms) => {
        sleeps.push(ms);
        controller.abort();
      },
    });
    await l.run();
    expect(sleeps).toEqual([600_000]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("HTTP 401");
    expect(logs[0]).not.toContain("wrong");
  });

  it("409 backs off 5 s, then doubles", async () => {
    tg.fail("getUpdates", 409, 2);
    const controller = new AbortController();
    const sleeps: number[] = [];
    const l = listener({
      signal: controller.signal,
      sleep: async (ms) => {
        sleeps.push(ms);
        if (sleeps.length === 2) controller.abort();
      },
    });
    await l.run();
    expect(sleeps).toEqual([5_000, 10_000]);
    expect(logs[0]).toContain("another program polls this bot");
  });

  it("channels serve --once answers the paired chat and exits 0; no token exits 1", async () => {
    const saved = [process.env.TIDEGAP_TELEGRAM_BOT_TOKEN, process.env.TIDEGAP_TELEGRAM_API_BASE];
    process.env.TIDEGAP_TELEGRAM_BOT_TOKEN = TOKEN;
    process.env.TIDEGAP_TELEGRAM_API_BASE = tg.baseUrl;
    try {
      tg.message(PAIRED, "/help");
      const opts = { db: join(dir, "q.db"), envFile: join(dir, "no-env"), log: (l: string) => logs.push(l), pollTimeoutS: 1, readiness: () => READY };
      expect(await runChannelsServe({ once: true }, opts)).toBe(0);
      expect(tg.sent(PAIRED)[0]).toMatch(/^Tidegap commands:/);
      delete process.env.TIDEGAP_TELEGRAM_BOT_TOKEN;
      expect(await runChannelsServe({ once: true }, opts)).toBe(1);
      expect(logs.at(-1)).toContain("~/.config/tidegap/env");
    } finally {
      if (saved[0] === undefined) delete process.env.TIDEGAP_TELEGRAM_BOT_TOKEN;
      else process.env.TIDEGAP_TELEGRAM_BOT_TOKEN = saved[0];
      if (saved[1] === undefined) delete process.env.TIDEGAP_TELEGRAM_API_BASE;
      else process.env.TIDEGAP_TELEGRAM_API_BASE = saved[1];
    }
  });
});
