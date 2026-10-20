/** The daily summary (integrations plan U15): when the tick sends it, what it folds, and how a failed send is retried. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { assessReadiness, DIGEST_AT_META_KEY, DIGEST_LAST_META_KEY, TaskStore, type Channel, type ChannelEvent, type Readiness, type TaskRecord } from "@tidegap/core";

import { emitEvents, type ChannelSender } from "../src/channels/emit.js";
import { runTickOnce } from "../src/commands/tick.js";
import { startFakeTelegram, type FakeTelegram } from "../../core-ts/test/fixtures/fake-telegram.js";

const day = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m);

function noRunner(provider: string): Readiness {
  return assessReadiness({ daemon: "loaded", lastTickAt: new Date(), runners: { providers: [], unknown: [], source: "probe" }, pendingByProvider: { [provider]: 1 } });
}

describe("daily summary in emitEvents", () => {
  let dir: string;
  let store: TaskStore;
  let sent: Array<{ id: string; event: ChannelEvent; text: string }>;
  let failing: Set<string>;

  const send: ChannelSender = async (channel, message, event) => {
    if (failing.has(channel.id)) throw new Error("down");
    sent.push({ id: channel.id, event, text: message.text });
  };
  const row = (id: string, events: Channel["events"], quiet: "night" | "off" = "off") =>
    store.insertChannel({ id, kind: "webhook", enabled: true, events, config: { quiet }, createdAt: new Date().toISOString() });
  const finished = (taskId: string, status: "completed" | "failed", at: Date) =>
    store.upsert({ taskId, status, enqueuedAt: new Date(at.getTime() - 3_600_000).toISOString(), completedAt: at.toISOString(), region: "DE", title: `title ${taskId}` } as TaskRecord<unknown>);
  const emit = (now: Date, over: Partial<Parameters<typeof emitEvents>[0]> = {}) => emitEvents({ store, send, now, digest: { store }, ...over });
  const digests = () => sent.filter((s) => s.event.kind === "digest");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-digest-"));
    store = new TaskStore({ dbPath: join(dir, "q.db") });
    sent = [];
    failing = new Set();
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("08:59 → nothing; 09:01 → sent; a second tick at 09:30 → nothing", async () => {
    row("w", ["digest"]);
    store.setMeta(DIGEST_LAST_META_KEY, day(19, 9).toISOString());
    finished("a", "completed", day(19, 20));
    finished("b", "completed", day(19, 21));
    finished("c", "failed", day(19, 23, 10));
    await emit(day(20, 8, 59));
    expect(digests()).toHaveLength(0);
    await emit(day(20, 9, 1));
    expect(digests()).toHaveLength(1);
    const d = digests()[0]!;
    expect(d.text).toContain("Tidegap daily summary: 2 done, 1 failed");
    expect(d.text).toContain("- title a");
    expect(d.text).toContain("- title c");
    expect(store.getMeta(DIGEST_LAST_META_KEY)).toBe(day(20, 9, 1).toISOString());
    await emit(day(20, 9, 30));
    expect(digests()).toHaveLength(1);
  });

  it("lists only tasks finished since the previous summary, including rows the Python core wrote (no TS tick)", async () => {
    row("w", ["digest"]);
    store.setMeta(DIGEST_LAST_META_KEY, day(19, 9).toISOString());
    finished("old", "completed", day(19, 8));
    finished("py", "completed", day(19, 12));
    await emit(day(20, 9));
    expect(digests()[0]!.text).toContain("- title py");
    expect(digests()[0]!.text).not.toContain("title old");
  });

  it("no channel subscribed → nothing sent and no ledger write", async () => {
    row("w", ["task_done"]);
    finished("a", "completed", day(19, 20));
    await emit(day(20, 9, 1));
    expect(sent).toHaveLength(0);
    expect(store.getMeta(DIGEST_LAST_META_KEY)).toBeUndefined();
  });

  it("an empty day sends nothing and moves the mark, so the next window starts there", async () => {
    row("w", ["digest"]);
    store.setMeta(DIGEST_LAST_META_KEY, day(19, 9).toISOString());
    await emit(day(20, 9, 1));
    expect(sent).toHaveLength(0);
    expect(store.getMeta(DIGEST_LAST_META_KEY)).toBe(day(20, 9, 1).toISOString());
  });

  it("every send fails → the mark is restored and the next tick retries", async () => {
    row("w", ["digest"]);
    store.setMeta(DIGEST_LAST_META_KEY, day(19, 9).toISOString());
    finished("a", "completed", day(19, 20));
    failing.add("w");
    await emit(day(20, 9, 1));
    expect(store.getMeta(DIGEST_LAST_META_KEY)).toBe(day(19, 9).toISOString());
    failing.clear();
    await emit(day(20, 9, 6));
    expect(digests()).toHaveLength(1);
  });

  it("a failure at 23:10 with quiet on: no per-task message; the 09:00 summary includes it", async () => {
    row("w", ["task_failed", "digest"], "night");
    store.setMeta(DIGEST_LAST_META_KEY, day(19, 9).toISOString());
    finished("late", "failed", day(19, 23, 10));
    await emit(day(19, 23, 10), { results: [{ taskId: "late", status: "failed" }] as never });
    expect(sent).toHaveLength(0);
    await emit(day(20, 9));
    expect(sent.map((s) => s.event.kind)).toEqual(["digest"]);
    expect(sent[0]!.text).toContain("- title late");
  });

  it("a no_runner alert held at 23:00 folds into the 09:00 summary; a channel without the summary still gets it", async () => {
    row("both", ["not_ready", "digest"], "night");
    row("alerts", ["not_ready"], "night");
    store.setMeta(DIGEST_LAST_META_KEY, day(19, 9).toISOString());
    await emit(day(19, 23), { readiness: noRunner("openai") });
    expect(sent).toHaveLength(0);
    await emit(day(20, 9), { readiness: noRunner("openai") });
    expect(sent.map((s) => `${s.id}:${s.event.kind}`).sort()).toEqual(["alerts:not_ready", "both:digest"]);
    expect(sent.find((s) => s.id === "both")!.text).toContain("Cannot run yet:");
    await emit(day(20, 9, 5), { readiness: noRunner("openai") });
    expect(sent).toHaveLength(2);
  });

  it("a folded alert whose summary failed everywhere is sent again on the next tick", async () => {
    row("both", ["not_ready", "digest"]);
    store.setMeta(DIGEST_LAST_META_KEY, day(19, 9).toISOString());
    failing.add("both");
    await emit(day(20, 9), { readiness: noRunner("openai") });
    failing.clear();
    await emit(day(20, 9, 5), { readiness: noRunner("openai") });
    expect(sent.map((s) => s.event.kind)).toEqual(["digest"]);
    expect(sent[0]!.text).toContain("Cannot run yet:");
  });

  it("asleep until the next day 10:00: one summary, not two", async () => {
    row("w", ["digest"]);
    store.setMeta(DIGEST_LAST_META_KEY, day(18, 9).toISOString());
    finished("a", "completed", day(19, 20));
    await emit(day(21, 10));
    await emit(day(21, 10, 5));
    expect(digests()).toHaveLength(1);
  });
});

describe("tidegap tick sends the daily summary", () => {
  const TOKEN = "777:digest-token";
  const CHAT = 5151;
  const ENV_KEYS = ["OLLAMA_HOST", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "TIDEGAP_CLAUDE_CODE", "TIDEGAP_TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_TOKEN", "TIDEGAP_TELEGRAM_API_BASE", "TIDEGAP_NO_NOTIFY"];
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
    process.env.OLLAMA_HOST = "http://ollama.test";
    dir = mkdtempSync(join(tmpdir(), "tidegap-tick-digest-"));
    dbPath = join(dir, "queue.db");
    tg = await startFakeTelegram({ token: TOKEN });
    process.env.TIDEGAP_TELEGRAM_BOT_TOKEN = TOKEN;
    process.env.TIDEGAP_TELEGRAM_API_BASE = tg.baseUrl;
    const hermetic = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "http://ollama.test/api/chat") {
        return Response.json({ model: "llama3.2:1b", message: { role: "assistant", content: "ok" }, done: true, prompt_eval_count: 5, eval_count: 3 });
      }
      return hermetic(input, init);
    });
    const store = new TaskStore({ dbPath });
    store.insertChannel({ id: `telegram-${CHAT}`, kind: "telegram", enabled: true, events: ["task_done", "digest"], config: { chat_id: CHAT }, createdAt: new Date().toISOString() });
    store.setMeta(DIGEST_AT_META_KEY, "00:00");
    store.setMeta(DIGEST_LAST_META_KEY, new Date(Date.now() - 30 * 3_600_000).toISOString());
    store.upsert({
      taskId: "d-1",
      status: "scheduled",
      enqueuedAt: new Date(Date.now() - 60_000).toISOString(),
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
      region: "FR",
      title: "digest task",
      bodyJson: JSON.stringify({ type: "provider_call", provider: "ollama", model: "llama3.2:1b", prompt: "hi" }),
    } as TaskRecord<unknown>);
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

  const tick = () => runTickOnce({ db: dbPath, region: "FR", envFile: join(dir, "no-env"), budgetConfig: join(dir, "no-config"), platform: "linux", spawnNotify: () => {} });

  it("one summary that lists the task this tick finished, in place of its own message; the next tick sends nothing", async () => {
    await tick();
    const texts = tg.sent(CHAT);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("Tidegap daily summary: 1 done");
    expect(texts[0]).toContain("- digest task");
    await tick();
    expect(tg.sent(CHAT)).toHaveLength(1);
  });
});
