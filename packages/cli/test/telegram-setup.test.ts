/** The Telegram setup module (integrations plan U2) against the fake Telegram server. */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskStore } from "@tidegap/core";

import { BOT_ID_META_KEY, LISTENER_META_KEY, OFFSET_META_KEY } from "../src/channels/serve.js";
import {
  createInstallListener,
  SETUP_TEXT,
  TelegramSetup,
  TelegramSetupError,
  TEST_MESSAGE,
  type TelegramSetupOptions,
} from "../src/channels/telegram-setup.js";
import { launchdPlist } from "../src/platform/macos.js";
import { systemdService } from "../src/platform/linux.js";
import type { ExecResult } from "../src/platform/index.js";
import { startFakeTelegram, type FakeTelegram } from "../../core-ts/test/fixtures/fake-telegram.js";

const TOKEN = "123456:AAbbCCddEEffGGhhIIjjKKllMMnnOOwXyZ";
const TOKEN_2 = "123456:ZZyyXXwwVVuuTTssRRqqPPooNNmmLLkK9w";
const OTHER_BOT = "777777:QQwwEEffRRttYYuuIIooPPaaSSddFFgg77";

describe("TelegramSetup", () => {
  let dir: string;
  let envFile: string;
  let store: TaskStore;
  let tg: FakeTelegram;
  let hook: string[];
  /** Every status and error text this test produced: none may hold a token. */
  let seen: string[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-setup-"));
    envFile = join(dir, "env");
    store = new TaskStore({ dbPath: join(dir, "q.db") });
    tg = await startFakeTelegram({ token: TOKEN, maxWaitMs: 50, botUsername: "tg_test_bot" });
    hook = [];
    seen = [];
  });
  afterEach(async () => {
    for (const text of seen) for (const t of [TOKEN, TOKEN_2, OTHER_BOT]) expect(text).not.toContain(t);
    await tg.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const setup = (over: Partial<TelegramSetupOptions> = {}) =>
    new TelegramSetup({
      store,
      envFile,
      apiBase: tg.baseUrl,
      installListener: (a) => void hook.push(a),
      platform: "linux",
      home: dir,
      pair: { code: "123456", pollTimeoutS: 1 },
      ...over,
    });

  const status = async (s: TelegramSetup) => {
    const st = await s.status();
    seen.push(JSON.stringify(st));
    return st;
  };

  const refusal = async (p: Promise<unknown>) => {
    const err = await p.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TelegramSetupError);
    seen.push((err as Error).message);
    return err as TelegramSetupError;
  };

  const paired = (chatId = 55) =>
    store.insertChannel({ id: `telegram-${chatId}`, kind: "telegram", enabled: true, events: ["task_done"], config: { chat_id: chatId, label: "@vit" }, createdAt: new Date().toISOString() });

  const saveToken = (token = TOKEN) => writeFileSync(envFile, `TIDEGAP_TELEGRAM_BOT_TOKEN=${token}\n`);

  it("not configured without a token; token saved shows the last 4 characters and the bot", async () => {
    const s = setup();
    expect(await status(s)).toEqual({ state: "not_configured" });
    await s.saveToken(TOKEN);
    expect(await status(s)).toEqual({ state: "token_saved", token_hint: "wXyZ", bot_username: "tg_test_bot" });
    expect(readFileSync(envFile, "utf8")).toBe(`TIDEGAP_TELEGRAM_BOT_TOKEN=${TOKEN}\n`);
  });

  it("the status calls getMe once per token in 10 minutes", async () => {
    saveToken();
    const s = setup();
    await status(s);
    await status(s);
    expect(tg.calls("getMe")).toHaveLength(1);
  });

  it("refuses a bad format, a token Telegram refuses and a bot with a webhook; the env file stays as it was", async () => {
    const s = setup();
    expect((await refusal(s.saveToken("123:short"))).code).toBe("format");
    expect((await refusal(s.saveToken(TOKEN_2))).message).toBe(SETUP_TEXT.refused);
    tg.setWebhook("https://elsewhere.example/hook");
    expect((await refusal(s.saveToken(TOKEN))).code).toBe("webhook");
    expect(() => readFileSync(envFile)).toThrow();
  });

  it("covers AE2: Connect shows a 6-digit code, the deep link and 10 minutes; /start <code> pairs", async () => {
    saveToken();
    const s = setup();
    const before = Date.now();
    expect(await s.startPairing()).toBe(true);
    const st = await status(s);
    expect(st.state).toBe("pairing");
    expect(st.pairing).toMatchObject({ code: "123456", bot_username: "tg_test_bot", link: "https://t.me/tg_test_bot?start=123456" });
    const left = Date.parse(st.pairing!.expires_at) - before;
    expect(left).toBeGreaterThan(9.9 * 60_000);
    expect(left).toBeLessThanOrEqual(10 * 60_000 + 1000);
    expect(await s.startPairing()).toBe(false);

    tg.message(77, "/start 123456", { username: "user" });
    await vi.waitFor(async () => expect((await status(s)).state).toBe("paired"), { timeout: 3000 });
    const done = await status(s);
    expect(done.chat).toEqual({ channel_id: "telegram-77", label: "@user" });
    expect(done.listener?.state).toBe("not_running");
    expect(hook).toEqual(["unload", "load"]);
  });

  it("a stored offset of another bot is cleared before the first getUpdates; the same bot keeps it", async () => {
    saveToken();
    store.setMeta(OFFSET_META_KEY, "9000000");
    store.setMeta(BOT_ID_META_KEY, "1");
    const s = setup();
    await s.startPairing();
    await vi.waitFor(() => expect(tg.calls("getUpdates").length).toBeGreaterThan(0));
    expect(tg.calls("getUpdates")[0]!.body.offset).toBeUndefined();
    expect(store.getMeta(BOT_ID_META_KEY)).toBe("42");
    await s.cancelPairing();

    store.setMeta(OFFSET_META_KEY, "500");
    tg.clearCalls();
    await s.startPairing();
    await vi.waitFor(() => expect(tg.calls("getUpdates").length).toBeGreaterThan(0));
    expect(tg.calls("getUpdates")[0]!.body.offset).toBe(500);
    await s.cancelPairing();
  });

  it("a token of a different bot while paired drops the chat, the offset, the heartbeat and the running pairing", async () => {
    saveToken();
    paired();
    store.setMeta(BOT_ID_META_KEY, "42");
    store.setMeta(OFFSET_META_KEY, "100");
    store.setMeta(LISTENER_META_KEY, JSON.stringify({ at: new Date().toISOString(), state: "unauthorized" }));
    const s = setup();
    await s.startPairing();
    tg.setToken(OTHER_BOT, { id: 77, username: "other_bot" });
    await s.saveToken(OTHER_BOT);
    expect(store.listChannels()).toEqual([]);
    expect(store.getMeta(OFFSET_META_KEY)).toBeUndefined();
    expect(store.getMeta(BOT_ID_META_KEY)).toBe("77");
    expect(store.getMeta(LISTENER_META_KEY)).toBeUndefined();
    expect(hook.at(-1)).toBe("unload");
    expect(await status(s)).toEqual({ state: "token_saved", token_hint: OTHER_BOT.slice(-4), bot_username: "other_bot" });
  });

  it("a new token of the same bot keeps the chat and the offset and restarts the listener", async () => {
    saveToken();
    paired();
    store.setMeta(BOT_ID_META_KEY, "42");
    store.setMeta(OFFSET_META_KEY, "100");
    tg.setToken(TOKEN_2);
    await setup().saveToken(TOKEN_2);
    expect(store.listChannels().map((c) => c.id)).toEqual(["telegram-55"]);
    expect(store.getMeta(OFFSET_META_KEY)).toBe("100");
    expect(hook).toEqual(["unload", "load"]);
    expect(readFileSync(envFile, "utf8")).toBe(`TIDEGAP_TELEGRAM_BOT_TOKEN=${TOKEN_2}\n`);
  });

  it("a chat paired before telegram_bot_id existed: the previous token's id prefix decides whether the bot changed", async () => {
    saveToken();
    paired();
    tg.setToken(OTHER_BOT, { id: 777777 });
    await setup().saveToken(OTHER_BOT);
    expect(store.listChannels()).toEqual([]);
    expect(hook.at(-1)).toBe("unload");
  });

  it("a chat paired before telegram_bot_id existed keeps its chat when the new token is for the same bot", async () => {
    saveToken();
    paired();
    tg.setToken(TOKEN_2, { id: 123456 });
    await setup().saveToken(TOKEN_2);
    expect(store.listChannels().map((c) => c.id)).toEqual(["telegram-55"]);
    expect(hook).toEqual(["unload", "load"]);
  });

  it("two Connects at once start one pairing; cancel leaves no poller behind", async () => {
    saveToken();
    const s = setup();
    expect(await Promise.all([s.startPairing(), s.startPairing()])).toEqual([true, false]);
    expect((await status(s)).state).toBe("pairing");
    await s.cancelPairing();
    tg.clearCalls();
    await new Promise((r) => setTimeout(r, 300));
    expect(tg.calls("getUpdates")).toEqual([]);
  });

  it("disconnect while Connect is still starting ends that pairing", async () => {
    saveToken();
    const s = setup();
    const starting = s.startPairing();
    await s.disconnect();
    await starting;
    expect((await status(s)).state).toBe("token_saved");
    tg.clearCalls();
    await new Promise((r) => setTimeout(r, 300));
    expect(tg.calls("getUpdates")).toEqual([]);
  });

  it("send test: a Telegram refusal is the fixed sentence", async () => {
    saveToken();
    paired();
    tg.fail("sendMessage", 400, 1, `Bad Request: chat not found for bot${TOKEN}`);
    const err = await refusal(setup().sendTest());
    expect([err.code, err.message]).toEqual(["telegram", SETUP_TEXT.telegram]);
  });

  it("the same token again changes nothing", async () => {
    saveToken();
    paired();
    await setup().saveToken(TOKEN);
    expect(hook).toEqual([]);
    expect(tg.calls()).toEqual([]);
  });

  it("cancel ends the session; the listener loads again only when an earlier chat stays paired", async () => {
    saveToken();
    const s = setup();
    await s.startPairing();
    await s.cancelPairing();
    expect((await status(s)).state).toBe("token_saved");
    expect(hook).toEqual(["unload"]);

    paired();
    hook = [];
    await s.startPairing();
    await s.cancelPairing();
    expect(hook).toEqual(["unload", "load"]);
    expect((await status(s)).state).toBe("paired");
  });

  it("a pairing that fails shows the error sentence until the next Connect", async () => {
    saveToken();
    tg.fail("getUpdates", 409, 1);
    const s = setup();
    await s.startPairing();
    await vi.waitFor(async () => expect((await status(s)).state).toBe("error"));
    expect((await status(s)).error).toBe(SETUP_TEXT.pair_conflict);
  });

  it("covers AE6: disconnect with forget removes the chat, unloads, and deletes both token keys only", async () => {
    writeFileSync(envFile, `A=1\nTIDEGAP_TELEGRAM_BOT_TOKEN=${TOKEN}\n# c\nTELEGRAM_BOT_TOKEN=${TOKEN}\nB=2\n`);
    paired();
    const s = setup();
    await s.disconnect({ forgetToken: true });
    expect(store.listChannels()).toEqual([]);
    expect(hook).toEqual(["unload"]);
    expect(readFileSync(envFile, "utf8")).toBe("A=1\n# c\nB=2\n");
    expect(await status(s)).toEqual({ state: "not_configured" });
  });

  it("send test: refused without a chat; one plain sendMessage to the chat with one", async () => {
    saveToken();
    const s = setup();
    expect((await refusal(s.sendTest())).code).toBe("not_paired");
    paired();
    await s.sendTest();
    const calls = tg.calls("sendMessage");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toMatchObject({ chat_id: 55, text: TEST_MESSAGE });
    expect(calls[0]!.body.parse_mode).toBeUndefined();
  });

  it("Windows: the listener is manual and Start listener is refused", async () => {
    saveToken();
    paired();
    const s = setup({ platform: "win32" });
    expect((await status(s)).listener).toEqual({ state: "manual", message: SETUP_TEXT.manual });
    expect((await refusal(s.startListener())).code).toBe("manual");
  });

  it("Start listener restarts a loaded, unchanged unit: bootout and bootstrap both run", async () => {
    saveToken();
    paired();
    const calls: string[] = [];
    const exec = (cmd: string, args: string[]): ExecResult => {
      calls.push([cmd, ...args].join(" "));
      return { status: 0, stdout: "", stderr: "" };
    };
    const real = createInstallListener({ platform: "darwin", home: dir, exec, uid: 501, launcher: ["/bin/tidegap"], dbPath: "/q.db", out: () => {} });
    await real("load");
    calls.length = 0;
    await setup({ platform: "darwin", installListener: real }).startListener();
    expect(calls.some((c) => c.startsWith("launchctl bootout gui/501/com.tidegap.channels"))).toBe(true);
    expect(calls.some((c) => c.startsWith("launchctl bootstrap gui/501"))).toBe(true);
  });
});

describe("the listener unit's launcher (KTD3)", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "tidegap-launcher-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const exec = (_cmd: string, args: string[]): ExecResult => ({ status: args[0] === "print" || args[1] === "is-active" ? 3 : 0, stdout: "", stderr: "" });

  it("macOS: comes from the installed tick unit, not this process's argv", async () => {
    const agents = join(home, "Library", "LaunchAgents");
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, "com.tidegap.tick.plist"), launchdPlist({ tickIntervalSec: 300, dbPath: "/q.db", launcher: ["/usr/local/bin/tidegap"] }));
    await createInstallListener({ platform: "darwin", home, exec, uid: 501, dbPath: "/q.db", out: () => {} })("load");
    const plist = readFileSync(join(agents, "com.tidegap.channels.plist"), "utf8");
    expect(plist).toMatch(/<array>\s*<string>\/usr\/local\/bin\/tidegap<\/string>\s*<string>channels<\/string>\s*<string>serve<\/string>/);
  });

  it("Linux: comes from the installed tick service", async () => {
    const units = join(home, ".config", "systemd", "user");
    mkdirSync(units, { recursive: true });
    writeFileSync(join(units, "tidegap-tick.service"), systemdService({ dbPath: "/q.db", launcher: ["/usr/bin/node", "/opt/t/index.js"] }));
    await createInstallListener({ platform: "linux", home, exec, dbPath: "/q.db", out: () => {} })("load");
    expect(readFileSync(join(units, "tidegap-channels.service"), "utf8")).toContain("ExecStart=/usr/bin/node /opt/t/index.js channels serve --db /q.db");
  });

  it("without a tick unit: the resolved launcher of this process", async () => {
    await createInstallListener({ platform: "linux", home, exec, dbPath: "/q.db", out: () => {} })("load");
    const unit = readFileSync(join(home, ".config", "systemd", "user", "tidegap-channels.service"), "utf8");
    expect(unit).toContain(`ExecStart=${process.execPath} `);
  });
});
