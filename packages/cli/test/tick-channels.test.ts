/** `tidegap tick` sends channel events (coherence U15): Telegram plus the implicit os channel. */

import type { SpawnOptions } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LAST_TICK_META_KEY, readTickSleep, TaskStore, TICK_BY_META_KEY, TICK_SLEEP_META_KEY, type Channel, type ChannelEvent } from "@tidegap/core";

import { CHANNEL_LAST_META_PREFIX } from "../src/channels/emit.js";
import { writeSecrets } from "../src/channels/secrets.js";
import { runTickOnce, TICK_BUSY_MESSAGE, TICK_LOCK_STALE_MS, tickStartedBy } from "../src/commands/tick.js";
import { startFakeSink, type FakeSink } from "./fixtures/fake-sink.js";
import { startFakeTelegram, type FakeTelegram } from "../../core-ts/test/fixtures/fake-telegram.js";

const TOKEN = "999:tick-token";
const PAIRED = 4242;
const ENV_KEYS = ["OLLAMA_HOST", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "TIDEGAP_CLAUDE_CODE", "TIDEGAP_TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_TOKEN", "TIDEGAP_TELEGRAM_API_BASE", "TIDEGAP_NO_NOTIFY", "TIDEGAP_ENV_FILE_KEYS", "TIDEGAP_TEST_OTHER_KEY", "FAKE_CLAUDE_LOG", "TIDEGAP_CLAUDE_BIN"];

describe("tidegap tick channel events", () => {
  let dir: string;
  let dbPath: string;
  let tg: FakeTelegram;
  const saved = new Map<string, string | undefined>();

  beforeEach(async () => {
    for (const k of ENV_KEYS) {
      saved.set(k, process.env[k]);
      delete process.env[k];
    }
    process.env.TIDEGAP_CLAUDE_CODE = "0";
    dir = mkdtempSync(join(tmpdir(), "tidegap-tick-channels-"));
    dbPath = join(dir, "queue.db");
    tg = await startFakeTelegram({ token: TOKEN });
    process.env.TIDEGAP_TELEGRAM_BOT_TOKEN = TOKEN;
    process.env.TIDEGAP_TELEGRAM_API_BASE = tg.baseUrl;
    const hermetic = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "http://ollama.test/api/chat") {
        return Response.json({ model: "llama3.2:1b", message: { role: "assistant", content: "the answer is 42" }, done: true, prompt_eval_count: 5, eval_count: 3 });
      }
      return hermetic(input, init);
    });
    const store = new TaskStore({ dbPath });
    store.insertChannel({
      id: `telegram-${PAIRED}`,
      kind: "telegram",
      enabled: true,
      events: ["task_done", "task_failed", "clean_window", "not_ready"],
      config: { chat_id: PAIRED },
      createdAt: new Date().toISOString(),
    });
    store.close();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await tg.close();
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  function due(taskId: string, provider: string): void {
    const store = new TaskStore({ dbPath });
    store.upsert({
      taskId,
      status: "scheduled",
      enqueuedAt: new Date(Date.now() - 60_000).toISOString(),
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
      region: "FR",
      title: `title ${taskId}`,
      bodyJson: JSON.stringify({ type: "provider_call", provider, model: "llama3.2:1b", prompt: "hi" }),
    });
    store.close();
  }

  function run(extra: Partial<Parameters<typeof runTickOnce>[0]> = {}) {
    const toasts: Array<{ cmd: string; args: string[]; opts: SpawnOptions }> = [];
    const result = runTickOnce({
      db: dbPath,
      region: "FR",
      envFile: join(dir, "no-env"),
      budgetConfig: join(dir, "no-config"),
      platform: "linux",
      spawnNotify: (cmd, args, opts) => {
        toasts.push({ cmd, args, opts });
      },
      ...extra,
    });
    return { result, toasts };
  }

  it("a finished task sends one Telegram message with the preview and a Result button, and the OS toast as before", async () => {
    process.env.OLLAMA_HOST = "http://ollama.test";
    due("ok-1", "ollama");
    const { result, toasts } = run();
    const r = await result;
    expect(r.message.split("\n")[0]).toBe("tick: 1 inspected, 1 dispatched, 0 failed");
    const sends = tg.calls("sendMessage");
    expect(sends).toHaveLength(1);
    expect(sends[0]!.body.chat_id).toBe(PAIRED);
    expect(String(sends[0]!.body.text)).toContain("the answer is 42");
    expect(JSON.stringify(sends[0]!.body.reply_markup)).toContain("Result");
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.args[1]).toBe("Tidegap: done: title ok-1");
  });

  describe("clean-window forecast fetch", () => {
    /** Stub fetch so every request that is not to this machine (the GB feed needs no key) is counted and refused; the tick then sees no live forecast. */
    function countGridFetches(): string[] {
      const hosts: string[] = [];
      const hermetic = globalThis.fetch;
      vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return hermetic(input, init);
        hosts.push(url.hostname);
        return new Response("down", { status: 503 });
      });
      return hosts;
    }
    const setLast = (retryAt: Date | undefined) => {
      const store = new TaskStore({ dbPath });
      store.setMeta(
        `${CHANNEL_LAST_META_PREFIX}telegram-${PAIRED}`,
        JSON.stringify({ at: new Date().toISOString(), ok: false, code: "network", fails: 1, ...(retryAt ? { retry_at: retryAt.toISOString() } : {}) }),
      );
      store.close();
    };

    it("a ready channel that subscribes to clean_window makes the tick fetch the forecast (control)", async () => {
      const hosts = countGridFetches();
      await run({ region: "GB" }).result;
      expect(hosts.length).toBeGreaterThan(0);
    });

    it("the only clean_window channel is in backoff: the tick does not fetch the forecast", async () => {
      const hosts = countGridFetches();
      setLast(new Date(Date.now() + 10 * 60_000));
      await run({ region: "GB" }).result;
      expect(hosts).toEqual([]);
    });

    it("a failed channel whose wait has run out is ready again: the tick fetches", async () => {
      const hosts = countGridFetches();
      setLast(new Date(Date.now() - 1_000));
      await run({ region: "GB" }).result;
      expect(hosts.length).toBeGreaterThan(0);
    });
  });

  it("with no adapters, a pending task sends one no_runner message (the early-return path)", async () => {
    due("oa-1", "openai");
    const r = await (run().result);
    expect(r.message).toMatch(/no adapters configured/);
    expect(tg.sent(PAIRED)).toHaveLength(1);
    expect(tg.sent(PAIRED)[0]).toContain("1 openai task has no runner");
    // The same problem on the next tick is not sent again.
    await run().result;
    expect(tg.sent(PAIRED)).toHaveLength(1);
  });

  it("a tick held up by a slow send touches its lock: a second tick past the stale age is still skipped", async () => {
    due("oa-1", "openai");
    const lock = `${dbPath}.tick.lock`;
    let sends = 0;
    let finish!: () => void;
    let sending!: () => void;
    const started = new Promise<void>((resolve) => (sending = resolve));
    const channelSend = () => {
      if (++sends > 1) return Promise.resolve();
      sending();
      return new Promise<void>((resolve) => (finish = resolve));
    };
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    try {
      const first = run({ notify: false, channelSend }).result;
      await started;
      const before = statSync(lock).mtimeMs;
      vi.advanceTimersByTime(TICK_LOCK_STALE_MS + 10_000);
      expect(statSync(lock).mtimeMs).toBeGreaterThan(before);
      expect(await run({ notify: false, channelSend }).result).toEqual({ exitCode: 0, message: TICK_BUSY_MESSAGE });
      finish();
      expect((await first).message).toMatch(/no adapters configured/);
      expect(sends).toBe(1);
      expect(existsSync(lock)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a unit tick after a sent daemon alert sends one 'running again'; without a sent alert it sends nothing", async () => {
    const store = new TaskStore({ dbPath });
    store.setMeta("notified:not_ready", JSON.stringify(["daemon_stale"]));
    store.close();
    await run({ startedBy: "unit" }).result;
    expect(tg.sent(PAIRED)).toEqual(["Tidegap: the tick daemon is running again."]);
    await run({ startedBy: "unit" }).result;
    expect(tg.sent(PAIRED)).toHaveLength(1);
  });

  it("a manual tick --once after a sent daemon alert sends nothing and keeps the alert's mark", async () => {
    const store = new TaskStore({ dbPath });
    store.setMeta("notified:not_ready", JSON.stringify(["daemon_stale"]));
    store.close();
    await run({ startedBy: "manual" }).result;
    expect(tg.sent(PAIRED)).toEqual([]);
    const after = new TaskStore({ dbPath });
    expect(after.getMeta("notified:not_ready")).toBe(JSON.stringify(["daemon_stale"]));
    expect(after.getMeta(TICK_BY_META_KEY)).toBe("manual");
    after.close();
  });

  it("each tick stores its sleep reading with the tick time, and removes it when none can be read", async () => {
    await run({ sleepNow: { boot_at: 1_000, slept_ms: 5_000, woke_at: 9 } }).result;
    let store = new TaskStore({ dbPath });
    const reading = readTickSleep(store)!;
    expect(reading).toMatchObject({ boot_at: 1_000, slept_ms: 5_000 });
    expect(Math.abs(reading.at! - Date.parse(store.getMeta(LAST_TICK_META_KEY)!))).toBeLessThan(60_000);
    store.close();
    await run({ sleepNow: null }).result;
    store = new TaskStore({ dbPath });
    expect(store.getMeta(TICK_SLEEP_META_KEY)).toBeUndefined();
    store.close();
  });

  it("tickStartedBy: launchd label, systemd invocation or a --daemon loop is the unit; a shell is manual", () => {
    expect(tickStartedBy({ XPC_SERVICE_NAME: "com.tidegap.tick" })).toBe("unit");
    expect(tickStartedBy({ INVOCATION_ID: "abc" })).toBe("unit");
    expect(tickStartedBy({ XPC_SERVICE_NAME: "0" }, true)).toBe("unit");
    expect(tickStartedBy({ XPC_SERVICE_NAME: "0" })).toBe("manual");
    expect(tickStartedBy({ XPC_SERVICE_NAME: "application.com.apple.Terminal.123" })).toBe("manual");
  });

  it("--no-notify posts no toast; Telegram still sends", async () => {
    process.env.OLLAMA_HOST = "http://ollama.test";
    due("ok-1", "ollama");
    const { result, toasts } = run({ notify: false });
    await result;
    expect(toasts).toHaveLength(0);
    expect(tg.sent(PAIRED)).toHaveLength(1);
  });

  it("a Telegram failure leaves the tick result alone and adds one warning line", async () => {
    process.env.OLLAMA_HOST = "http://ollama.test";
    due("ok-1", "ollama");
    tg.fail("sendMessage", 500, 5);
    const r = await (run().result);
    expect(r.exitCode).toBe(0);
    expect(r.message.split("\n")[0]).toBe("tick: 1 inspected, 1 dispatched, 0 failed");
    const warnings = r.message.split("\n").filter((l) => l.includes(`telegram-${PAIRED}`));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("task_done not sent");
    expect(r.message).not.toContain(TOKEN);
  });

  it("an injected sender gets the os and telegram jobs, and no toast is spawned", async () => {
    process.env.OLLAMA_HOST = "http://ollama.test";
    due("ok-1", "ollama");
    const jobs: Array<[string, ChannelEvent["kind"]]> = [];
    const { result, toasts } = run({
      channelSend: async (channel: Channel, _message, event) => {
        jobs.push([channel.id, event.kind]);
      },
    });
    await result;
    expect(jobs.sort()).toEqual([["os", "task_done"], [`telegram-${PAIRED}`, "task_done"]]);
    expect(toasts).toHaveLength(0);
    expect(tg.calls("sendMessage")).toHaveLength(0);
  });

  it("reads the token from the env file on every tick: a token saved after the first tick is used by the second", async () => {
    process.env.OLLAMA_HOST = "http://ollama.test";
    delete process.env.TIDEGAP_TELEGRAM_BOT_TOKEN;
    const envFile = join(dir, "env");
    writeFileSync(envFile, `TIDEGAP_TELEGRAM_BOT_TOKEN=${TOKEN}\n`);
    due("ok-1", "ollama");
    await run({ envFile }).result;
    expect(tg.sent(PAIRED)).toHaveLength(1);

    const next = "1000:tick-token-new";
    tg.setToken(next);
    writeFileSync(envFile, `TIDEGAP_TELEGRAM_BOT_TOKEN=${next}\n`);
    due("ok-2", "ollama");
    const r = await run({ envFile }).result;
    expect(r.message).not.toContain("not sent");
    expect(tg.sent(PAIRED)).toHaveLength(2);
  });

  it("a token removed from the env file is gone on the next tick (K3)", async () => {
    process.env.OLLAMA_HOST = "http://ollama.test";
    delete process.env.TIDEGAP_TELEGRAM_BOT_TOKEN;
    const envFile = join(dir, "env");
    writeFileSync(envFile, `TIDEGAP_TELEGRAM_BOT_TOKEN=${TOKEN}\n`);
    due("ok-1", "ollama");
    await run({ envFile }).result;
    expect(tg.sent(PAIRED)).toHaveLength(1);

    writeFileSync(envFile, "# token removed\n");
    due("ok-2", "ollama");
    const r = await run({ envFile }).result;
    expect(process.env.TIDEGAP_TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(tg.sent(PAIRED)).toHaveLength(1);
    expect(r.message).not.toContain(TOKEN);
  });

  it("a changed token in the env file replaces the old one in the process on the next tick (K3)", async () => {
    process.env.OLLAMA_HOST = "http://ollama.test";
    delete process.env.TIDEGAP_TELEGRAM_BOT_TOKEN;
    const envFile = join(dir, "env");
    writeFileSync(envFile, `TIDEGAP_TELEGRAM_BOT_TOKEN=${TOKEN}\n`);
    due("ok-1", "ollama");
    await run({ envFile }).result;

    const next = "1000:tick-token-new";
    tg.setToken(next);
    writeFileSync(envFile, `TIDEGAP_TELEGRAM_BOT_TOKEN=${next}\n`);
    due("ok-2", "ollama");
    const r = await run({ envFile }).result;
    expect(process.env.TIDEGAP_TELEGRAM_BOT_TOKEN).toBe(next);
    expect(tg.sent(PAIRED)).toHaveLength(2);
    expect(r.message).not.toContain(next);
  });

  it("a token from the real environment survives an env file without one (K3)", async () => {
    process.env.OLLAMA_HOST = "http://ollama.test";
    const envFile = join(dir, "env");
    writeFileSync(envFile, "TIDEGAP_TEST_OTHER_KEY=x\n");
    due("ok-1", "ollama");
    await run({ envFile }).result;
    due("ok-2", "ollama");
    await run({ envFile }).result;
    expect(process.env.TIDEGAP_TELEGRAM_BOT_TOKEN).toBe(TOKEN);
    expect(tg.sent(PAIRED)).toHaveLength(2);
  });
});

describe("tidegap tick and a registry channel (integrations plan U2)", () => {
  const FAKE_CLAUDE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-claude");
  /** The webhook URL's secret path: no log, env or child may see it. */
  const SECRET_PATH = "/hook/ae6-sEcReT-path-0451";
  let dir: string;
  let dbPath: string;
  let secretsFile: string;
  let sink: FakeSink;
  const saved = new Map<string, string | undefined>();

  beforeEach(async () => {
    for (const k of ENV_KEYS) {
      saved.set(k, process.env[k]);
      delete process.env[k];
    }
    dir = realpathSync(mkdtempSync(join(tmpdir(), "tidegap-tick-reg-")));
    dbPath = join(dir, "queue.db");
    secretsFile = join(dir, "config", "channel-secrets.json");
    sink = await startFakeSink();
    writeSecrets("webhook", { url: `${sink.baseUrl}${SECRET_PATH}` }, secretsFile);
    const store = new TaskStore({ dbPath });
    store.insertChannel({ id: "webhook", kind: "webhook", enabled: true, events: ["task_done", "task_failed"], config: {}, createdAt: new Date().toISOString() });
    store.close();
  });

  afterEach(async () => {
    await sink.close();
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("covers AE6: a claude-code task's child env and process.env hold nothing from the secrets file; the webhook gets the done event", async () => {
    cpSync(FAKE_CLAUDE, join(dir, "bin"), { recursive: true });
    const log = join(dir, "claude-log");
    process.env.FAKE_CLAUDE_LOG = log;
    const store = new TaskStore({ dbPath });
    store.upsert({
      taskId: "cc-1",
      status: "scheduled",
      enqueuedAt: new Date(Date.now() - 60_000).toISOString(),
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
      region: "US-CAL-CISO",
      bodyJson: JSON.stringify({ type: "provider_call", provider: "claude-code", model: "default", prompt: "Reply OK" }),
    });
    store.close();
    const r = await runTickOnce({
      db: dbPath,
      envFile: join(dir, "no-env"),
      secretsFile,
      notify: false,
      claudeLookup: {
        path: join(dir, "bin"),
        home: join(dir, "home"),
        platform: "linux",
        isExecutable: (p) => p.startsWith(dir) && existsSync(p),
        loginShell: async () => undefined,
      },
    });
    expect(r.message.split("\n")[0]).toBe("tick: 1 inspected, 1 dispatched, 0 failed");
    const childEnv = readFileSync(join(log, "env"), "utf8");
    expect(childEnv).toContain(`FAKE_CLAUDE_LOG=${log}`);
    expect(childEnv).not.toContain(SECRET_PATH);
    for (const [k, v] of Object.entries(process.env)) {
      expect(k).not.toMatch(/^TIDEGAP_.*(WEBHOOK|SECRET)/);
      expect(v ?? "").not.toContain(SECRET_PATH);
    }
    expect(r.message).not.toContain(SECRET_PATH);
    const reqs = sink.requests(SECRET_PATH);
    expect(reqs).toHaveLength(1);
    expect(JSON.parse(reqs[0]!.body)).toMatchObject({ version: 1, event: "task_done", task: { id: "cc-1", status: "completed" } });
    const check = new TaskStore({ dbPath });
    expect(JSON.parse(check.getMeta(`${CHANNEL_LAST_META_PREFIX}webhook`)!)).toMatchObject({ ok: true });
    check.close();
  });

  it("a webhook URL on the tidegap ui port is refused at send time with one warning line and no URL", async () => {
    writeSecrets("webhook", { url: `http://127.0.0.1:47821${SECRET_PATH}` }, secretsFile);
    process.env.OLLAMA_HOST = "http://ollama.test";
    const hermetic = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "http://ollama.test/api/chat") return Response.json({ model: "m", message: { role: "assistant", content: "ok" }, done: true, prompt_eval_count: 1, eval_count: 1 });
      return hermetic(input, init);
    });
    try {
      const store = new TaskStore({ dbPath });
      store.upsert({
        taskId: "ol-1",
        status: "scheduled",
        enqueuedAt: new Date(Date.now() - 60_000).toISOString(),
        scheduledFor: new Date(Date.now() - 1_000).toISOString(),
        region: "FR",
        bodyJson: JSON.stringify({ type: "provider_call", provider: "ollama", model: "llama3.2:1b", prompt: "hi" }),
      });
      store.close();
      const r = await runTickOnce({ db: dbPath, region: "FR", envFile: join(dir, "no-env"), secretsFile, notify: false, budgetConfig: join(dir, "no-config") });
      const warnings = r.message.split("\n").filter((l) => l.startsWith("tidegap: webhook"));
      expect(warnings).toEqual(["tidegap: webhook: task_done not sent: delivery failed: ui_port"]);
      expect(r.message).not.toContain(SECRET_PATH);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
