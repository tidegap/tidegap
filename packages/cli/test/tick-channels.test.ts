/** `tidegap tick` sends channel events (coherence U15): Telegram plus the implicit os channel. */

import type { SpawnOptions } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskStore, type Channel, type ChannelEvent } from "@tidegap/core";

import { CHANNEL_LAST_META_PREFIX } from "../src/channels/emit.js";
import { writeSecrets } from "../src/channels/secrets.js";
import { runTickOnce } from "../src/commands/tick.js";
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
        loginShell: () => undefined,
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
