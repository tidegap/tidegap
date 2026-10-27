/** The channel listener (coherence U14, KTD11) against the fake Telegram server. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  assessReadiness,
  commandContextFor,
  createJob,
  getJob,
  LAST_TICK_META_KEY,
  LIMIT_RESET_HINT_META_KEY,
  mockGridFeed,
  Scheduler,
  TaskStore,
  TelegramClient,
  TICK_BY_META_KEY,
  TICKER_CODES,
  type Readiness,
} from "@tidegap/core";

import { channelSender, notReadyEvent } from "../src/channels/emit.js";
import { BOT_ID_META_KEY, ChannelListener, LISTENER_META_KEY, OFFSET_META_KEY, readHeartbeat, tickerReadiness } from "../src/channels/serve.js";
import { TelegramSetup } from "../src/channels/telegram-setup.js";
import type { ProbeExec } from "../src/readiness.js";
import { runChannelsServe } from "../src/commands/channels.js";
import { startFakeTelegram, type FakeTelegram } from "../../core-ts/test/fixtures/fake-telegram.js";
import { startFakeSink } from "./fixtures/fake-sink.js";

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

  it("/jobs pause from another chat gets no reply and leaves the job active", async () => {
    const job = await createJob(scheduler, {
      title: "Mail triage",
      cadence: { kind: "daily" },
      timeZone: "UTC",
      template: { runner: "prompt", prompt: "check my mail", provider: "anthropic", tools: "none" },
    });
    // The paired chat's /jobs sets the numbers; the other chat must not reach them.
    tg.message(PAIRED, "/jobs");
    await listener().cycle();
    expect(tg.sent(PAIRED)).toHaveLength(1);
    tg.message(999, "/jobs pause 1");
    tg.message(999, `/jobs pause ${job.jobId}`);
    await listener().cycle();
    expect(tg.sent(999)).toEqual([]);
    expect(tg.sent()).toHaveLength(1);
    expect(getJob(scheduler, job.jobId)).toMatchObject({ status: "active", revision: job.revision });
  });

  it("a button press from another chat answers nothing and changes nothing", async () => {
    const t = await enqueue("Other chat button");
    tg.callback(999, `c:${t.taskId}`, { messageId: 5 });
    await listener().cycle();
    expect(store.get(t.taskId)!.status).not.toBe("cancelled");
    expect(tg.calls("answerCallbackQuery")).toEqual([]);
    expect(tg.sent()).toEqual([]);
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
    await l.tickerSettled();
    await l.cycle();
    await l.tickerSettled();
    const sent = tg.sent(PAIRED);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^Tidegap: the tick daemon is not running\.\nTasks may not run: the tick daemon last ran 11 minutes ago/);
  });

  describe("ticker alert decision (sleep vs. awake gap)", () => {
    const BOOT = 1_000;
    let home: string;
    beforeEach(() => {
      home = join(dir, "home");
      mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
      writeFileSync(join(home, "Library", "LaunchAgents", "com.tidegap.tick.plist"), "<plist/>");
    });
    const lastTick = (minAgo: number, sleptMs = 0, by: "unit" | "manual" = "unit") => {
      const at = Date.now() - minAgo * 60_000;
      store.setMeta(LAST_TICK_META_KEY, new Date(at).toISOString());
      store.setMeta("last_tick_sleep", JSON.stringify({ boot_at: BOOT, slept_ms: sleptMs, at }));
      store.setMeta(TICK_BY_META_KEY, by);
    };
    const launchctl: ProbeExec = () => ({ status: 0, stdout: "\tlast exit code = 1\n" });
    const make = (sleptNowMs: number) =>
      listener({ readiness: () => tickerReadiness(store, { platform: "darwin", home, exec: launchctl, sleepNow: () => ({ boot_at: BOOT, slept_ms: sleptNowMs }) }) });
    const check = async (l: ChannelListener) => {
      await l.cycle();
      await l.tickerSettled();
    };

    it("a 21-minute gap the Mac slept 19 minutes of sends nothing", async () => {
      lastTick(21);
      await check(make(19 * 60_000));
      expect(tg.sent(PAIRED)).toEqual([]);
      expect(store.getMeta("notified:not_ready")).toBeUndefined();
    });

    it("an awake gap alerts with the exit code and the tick --once advice; the next tick brings one 'running again'", async () => {
      lastTick(21);
      const l = make(0);
      await check(l);
      expect(tg.sent(PAIRED)).toEqual([
        "Tidegap: the tick daemon is not running.\nTasks may not run: the tick daemon last ran 21 minutes ago and exited with code 1. Run `tidegap tick --once` and check the error.",
      ]);
      lastTick(0);
      await check(l);
      await check(l);
      expect(tg.sent(PAIRED)).toHaveLength(2);
      expect(tg.sent(PAIRED)[1]).toBe("Tidegap: the tick daemon is running again.");
    });

    it("no 'running again' when the alert never went out", async () => {
      lastTick(21);
      let down = true;
      const sent: string[] = [];
      const l = new ChannelListener({
        store,
        client: new TelegramClient({ token: TOKEN, baseUrl: tg.baseUrl }),
        commands: commandContextFor(scheduler, store),
        readiness: () => tickerReadiness(store, { platform: "darwin", home, exec: launchctl, sleepNow: () => ({ boot_at: BOOT, slept_ms: 0 }) }),
        log: (line) => logs.push(line),
        send: async (_channel, message) => {
          if (down) throw new Error("down");
          sent.push(message.text);
        },
      });
      await l.checkTicker();
      expect(store.getMeta("notified:not_ready")).toBeUndefined();
      down = false;
      lastTick(0);
      // The guard itself, not the channel backoff the failed send started.
      expect(notReadyEvent(store, tickerReadiness(store, { platform: "darwin", home }), TICKER_CODES)).toBeNull();
      await l.checkTicker();
      expect(sent).toEqual([]);
    });

    it("a manual tick --once after an alert sends no 'running again' and no second alert; the next unit tick does", async () => {
      lastTick(21);
      const l = make(0);
      await check(l);
      expect(tg.sent(PAIRED)).toHaveLength(1);
      lastTick(0, 0, "manual");
      await check(l);
      expect(tg.sent(PAIRED)).toHaveLength(1);
      expect(store.getMeta("notified:not_ready")).toBe(JSON.stringify(["daemon_stale"]));
      // The unit is still down: stale again after the manual tick, but the alert was already sent.
      lastTick(21, 0, "manual");
      await check(l);
      expect(tg.sent(PAIRED)).toHaveLength(1);
      lastTick(0);
      await check(l);
      expect(tg.sent(PAIRED)).toEqual([expect.stringMatching(/not running/), "Tidegap: the tick daemon is running again."]);
    });
  });

  it("a hanging alert receiver does not hold the poll; one ticker check runs at a time", async () => {
    const home = join(dir, "home");
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(join(home, "Library", "LaunchAgents", "com.tidegap.tick.plist"), "<plist/>");
    store.setMeta(LAST_TICK_META_KEY, new Date(Date.now() - 11 * 60_000).toISOString());
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let alerts = 0;
    const l = new ChannelListener({
      store,
      client: new TelegramClient({ token: TOKEN, baseUrl: tg.baseUrl }),
      commands: commandContextFor(scheduler, store),
      readiness: () => tickerReadiness(store, { platform: "darwin", home }),
      log: (line) => logs.push(line),
      pollTimeoutS: 1,
      send: async () => {
        alerts++;
        await gate;
      },
    });
    tg.message(PAIRED, "/help");
    await l.cycle();
    expect(tg.sent(PAIRED)[0]).toMatch(/^Tidegap commands:/);
    await l.cycle();
    expect(alerts).toBe(1);
    release();
    await l.tickerSettled();
    expect(logs).toEqual([]);
  });

  it("a stale tick alerts a connected webhook subscribed to not_ready once; a quiet webhook gets it after 09:00, not at 23:10", async () => {
    const sink = await startFakeSink();
    try {
      const home = join(dir, "home");
      mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
      writeFileSync(join(home, "Library", "LaunchAgents", "com.tidegap.tick.plist"), "<plist/>");
      store.removeChannel("telegram-77");
      const row = (id: "webhook", quiet: "night" | "off") =>
        store.insertChannel({ id, kind: "webhook", enabled: true, events: ["not_ready"], config: { quiet }, createdAt: new Date().toISOString() });
      const secrets: Record<string, Record<string, string>> = { webhook: { url: `${sink.baseUrl}/alert` } };
      const make = () =>
        new ChannelListener({
          store,
          client: new TelegramClient({ token: TOKEN, baseUrl: tg.baseUrl }),
          commands: commandContextFor(scheduler, store),
          readiness: () => tickerReadiness(store, { platform: "darwin", home }),
          log: (l) => logs.push(l),
          send: channelSender({ secrets: (id) => secrets[id], driver: { http: { uiPorts: [47821] } } }),
        });

      row("webhook", "off");
      store.setMeta(LAST_TICK_META_KEY, new Date(Date.now() - 11 * 60_000).toISOString());
      await make().checkTicker();
      await make().checkTicker();
      expect(sink.requests("/alert")).toHaveLength(1);
      expect(JSON.parse(sink.requests("/alert")[0]!.body)).toMatchObject({ version: 1, event: "not_ready" });

      // A fresh problem at 23:10 for a quiet channel: no job.
      store.removeChannel("webhook");
      row("webhook", "night");
      store.deleteMeta("notified:not_ready");
      const d = new Date();
      vi.setSystemTime(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 10));
      store.setMeta(LAST_TICK_META_KEY, new Date(Date.now() - 11 * 60_000).toISOString());
      await make().checkTicker();
      expect(sink.requests("/alert")).toHaveLength(1);
      expect(logs).toEqual([]);

      // The held alert is not marked sent: at 09:30, with the tick still down, it arrives.
      vi.setSystemTime(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 9, 30));
      store.setMeta(LAST_TICK_META_KEY, new Date(Date.now() - 11 * 60_000).toISOString());
      await make().checkTicker();
      expect(sink.requests("/alert")).toHaveLength(2);

      // The tick runs again at 23:20: the quiet channel holds "running again" and its mark stays.
      vi.setSystemTime(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 23, 20));
      store.setMeta(LAST_TICK_META_KEY, new Date(Date.now() - 60_000).toISOString());
      await make().checkTicker();
      expect(sink.requests("/alert")).toHaveLength(2);
      expect(store.getMeta("notified:not_ready")).toBe(JSON.stringify(["daemon_stale"]));
      // After 09:00 it arrives once.
      vi.setSystemTime(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 2, 9, 10));
      store.setMeta(LAST_TICK_META_KEY, new Date(Date.now() - 60_000).toISOString());
      await make().checkTicker();
      await make().checkTicker();
      expect(sink.requests("/alert")).toHaveLength(3);
      expect(JSON.parse(sink.requests("/alert")[2]!.body)).toMatchObject({ event: "not_ready", level: "success", recovered: true });
    } finally {
      await sink.close();
    }
  });

  it("a failing alert channel backs off: the ticker check skips it until its wait ends, then sends once", async () => {
    const home = join(dir, "home");
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(join(home, "Library", "LaunchAgents", "com.tidegap.tick.plist"), "<plist/>");
    let calls = 0;
    let down = true;
    const l = new ChannelListener({
      store,
      client: new TelegramClient({ token: TOKEN, baseUrl: tg.baseUrl }),
      commands: commandContextFor(scheduler, store),
      readiness: () => tickerReadiness(store, { platform: "darwin", home }),
      log: (line) => logs.push(line),
      send: async () => {
        calls++;
        if (down) throw new Error("down");
      },
    });
    const check = async (afterMs: number) => {
      vi.setSystemTime(new Date(Date.now() + afterMs));
      store.setMeta(LAST_TICK_META_KEY, new Date(Date.now() - 11 * 60_000).toISOString());
      await l.checkTicker();
    };
    await check(0);
    expect(calls).toBe(1);
    await check(30_000);
    expect(calls).toBe(1);
    await check(31_000);
    expect(calls).toBe(2);
    await check(60_000);
    expect(calls).toBe(2);
    down = false;
    await check(61_000);
    expect(calls).toBe(3);
    await check(1_000);
    expect(calls).toBe(3);
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

  describe("heartbeat (KTD7)", () => {
    const setupStatus = async () => {
      const envFile = join(dir, "env");
      writeFileSync(envFile, `TIDEGAP_TELEGRAM_BOT_TOKEN=${TOKEN}\n`);
      const home = join(dir, "home");
      return (await new TelegramSetup({ store, envFile, apiBase: tg.baseUrl, platform: "darwin", home, installListener: () => {} }).status()).listener;
    };

    it("start-up writes ok before the first poll and stores the bot id; another bot's offset is cleared", async () => {
      store.setMeta(OFFSET_META_KEY, "9000000");
      store.setMeta(BOT_ID_META_KEY, "1");
      await listener().startup();
      expect(readHeartbeat(store)).toEqual({ at: new Date().toISOString(), state: "ok" });
      expect(store.getMeta(BOT_ID_META_KEY)).toBe("42");
      expect(store.getMeta(OFFSET_META_KEY)).toBeUndefined();
      expect(tg.calls("getUpdates")).toHaveLength(0);
    });

    it("the same bot keeps the offset", async () => {
      store.setMeta(OFFSET_META_KEY, "500");
      store.setMeta(BOT_ID_META_KEY, "42");
      await listener().startup();
      expect(store.getMeta(OFFSET_META_KEY)).toBe("500");
    });

    it("a 409 then a success keeps conflict_at; the status reports conflict", async () => {
      tg.fail("getUpdates", 409, 1);
      const l = listener();
      await l.run({ once: true });
      expect(readHeartbeat(store)?.state).toBe("conflict");
      await l.cycle().then(() => l.heartbeat("ok"));
      const hb = readHeartbeat(store)!;
      expect(hb.state).toBe("ok");
      expect(hb.conflict_at).toBe(new Date().toISOString());
      expect(await setupStatus()).toMatchObject({ state: "conflict" });
    });

    it("a failing poll writes network; the status says the listener cannot reach Telegram", async () => {
      tg.fail("getUpdates", 502, 1);
      await listener().run({ once: true });
      expect(readHeartbeat(store)?.state).toBe("network");
      expect(await setupStatus()).toEqual({ state: "not_running", message: "The listener cannot reach Telegram. Check the internet connection." });
    });

    it("a 401 writes unauthorized before the 10-minute sleep", async () => {
      const controller = new AbortController();
      const seen: Array<string | undefined> = [];
      await listener({
        token: "wrong",
        signal: controller.signal,
        sleep: async () => {
          seen.push(readHeartbeat(store)?.state);
          controller.abort();
        },
      }).run();
      expect(seen).toEqual(["unauthorized"]);
    });

    it("an unchanged state is written again only after a minute", async () => {
      const l = listener();
      const writes = () => vi.mocked(store.setMeta).mock.calls.filter(([k]) => k === LISTENER_META_KEY).length;
      vi.spyOn(store, "setMeta");
      l.heartbeat("ok");
      vi.setSystemTime(Date.now() + 20_000);
      l.heartbeat("ok");
      expect(writes()).toBe(1);
      vi.setSystemTime(Date.now() + 41_000);
      l.heartbeat("ok");
      expect(writes()).toBe(2);
    });

    it("a fresh heartbeat reads running; an old one not running", async () => {
      store.setMeta(LISTENER_META_KEY, JSON.stringify({ at: new Date().toISOString(), state: "ok" }));
      expect(await setupStatus()).toEqual({ state: "running" });
      store.setMeta(LISTENER_META_KEY, JSON.stringify({ at: new Date(Date.now() - 4 * 60_000).toISOString(), state: "ok" }));
      expect(await setupStatus()).toMatchObject({ state: "not_running" });
    });
  });
});
