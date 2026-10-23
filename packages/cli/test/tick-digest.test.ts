/** The daily summary (integrations plan U15): when the tick sends it, what it folds, and how a failed send is retried. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  assessReadiness,
  DEFAULT_JOB_CAPS,
  DIGEST_AT_META_KEY,
  DIGEST_LAST_META_KEY,
  DIGEST_SENT_META_KEY,
  osChannel,
  TaskStore,
  type Channel,
  type ChannelEvent,
  type JobRecord,
  type Readiness,
  type TaskRecord,
} from "@tidegap/core";

import { CHANNEL_LAST_META_PREFIX, emitEvents, NOT_READY_META_KEY, type ChannelSender } from "../src/channels/emit.js";
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
    if (failing.has(channel.id) || failing.has(`${channel.id}:${event.kind}`)) throw new Error("down");
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
    expect(store.getMeta(DIGEST_SENT_META_KEY)).toBe(day(20, 9, 1).toISOString());
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
    expect(store.getMeta(DIGEST_SENT_META_KEY)).toBeUndefined();
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

  it("a failing channel backs off 1, 2, 4 … min (cap 1 h): no summary is built while it waits; a success resets it", async () => {
    row("w", ["not_ready", "digest"]);
    store.setMeta(DIGEST_LAST_META_KEY, day(19, 9).toISOString());
    finished("a", "completed", day(19, 20));
    failing.add("w");
    const nextWindow = vi.fn(async () => null);
    const last = () => JSON.parse(store.getMeta(`${CHANNEL_LAST_META_PREFIX}w`)!) as { ok: boolean; fails?: number; retry_at?: string };
    const t0 = day(20, 9, 1);
    const at = (min: number) => new Date(t0.getTime() + min * 60_000);
    const tick = (min: number) => emit(at(min), { readiness: noRunner("openai"), digest: { store, nextWindow } });
    expect(await tick(0)).toEqual({ sent: 0, failed: 1 });
    expect(last()).toMatchObject({ ok: false, fails: 1, retry_at: at(1).toISOString() });
    // Waiting: nothing is sent, the summary is not built, its mark and the alert's stay unsent.
    store.upsert({ taskId: "q", status: "queued", enqueuedAt: at(0).toISOString(), region: "DE", title: "q" } as TaskRecord<unknown>);
    expect(await tick(0.5)).toEqual({ sent: 0, failed: 0 });
    expect(nextWindow).not.toHaveBeenCalled();
    expect(store.getMeta(DIGEST_LAST_META_KEY)).toBe(day(19, 9).toISOString());
    // Each failed run doubles the wait: 2, 4, 8, 16, 32, then 60 min.
    let t = 1;
    for (const wait of [2, 4, 8, 16, 32, 60, 60]) {
      await tick(t);
      expect(Date.parse(last().retry_at!) - at(t).getTime()).toBe(wait * 60_000);
      t += wait;
    }
    expect(last().fails).toBe(8);
    failing.clear();
    expect(await tick(t - 1)).toEqual({ sent: 0, failed: 0 });
    await tick(t);
    expect(sent.map((s) => s.event.kind)).toEqual(["digest"]);
    expect(last()).toEqual({ at: at(t).toISOString(), ok: true });
    // Reset: the next failure waits 1 min again.
    failing.add("w");
    await emit(at(t + 5), { readiness: noRunner("gemini") });
    expect(sent).toHaveLength(1);
    expect(last()).toMatchObject({ fails: 1, retry_at: at(t + 6).toISOString() });
  });

  it("two failed jobs in one run count as one failure; another channel still gets the summary", async () => {
    row("a", ["not_ready", "digest"]);
    row("b", ["digest"]);
    store.setMeta(DIGEST_LAST_META_KEY, day(19, 9).toISOString());
    finished("x", "completed", day(19, 20));
    failing.add("a");
    await emit(day(20, 9, 1), { readiness: noRunner("openai") });
    expect(JSON.parse(store.getMeta(`${CHANNEL_LAST_META_PREFIX}a`)!)).toMatchObject({ ok: false, fails: 1 });
    expect(sent.map((s) => `${s.id}:${s.event.kind}`)).toEqual(["b:digest"]);
  });

  it("a waiting channel keeps the alert its summary would have carried: it arrives after the wait", async () => {
    row("a", ["digest"]);
    row("b", ["not_ready", "digest"]);
    store.setMeta(DIGEST_LAST_META_KEY, day(19, 9).toISOString());
    finished("x", "completed", day(19, 20));
    const retryAt = day(20, 9, 6);
    store.setMeta(`${CHANNEL_LAST_META_PREFIX}b`, JSON.stringify({ at: day(20, 9).toISOString(), ok: false, code: "network", fails: 3, retry_at: retryAt.toISOString() }));
    await emit(day(20, 9, 1), { readiness: noRunner("openai") });
    expect(sent.map((s) => `${s.id}:${s.event.kind}`)).toEqual(["a:digest"]);
    expect(store.getMeta(NOT_READY_META_KEY)).toBeUndefined();
    await emit(retryAt, { readiness: noRunner("openai") });
    expect(sent.map((s) => `${s.id}:${s.event.kind}`)).toEqual(["a:digest", "b:not_ready"]);
  });

  it("a waiting channel does not make a ready channel get an alert twice: its summary carried it", async () => {
    row("a", ["not_ready", "digest"]);
    row("b", ["not_ready", "digest"]);
    store.setMeta(DIGEST_LAST_META_KEY, day(19, 9).toISOString());
    finished("x", "completed", day(19, 20));
    const retryAt = day(20, 9, 6);
    store.setMeta(`${CHANNEL_LAST_META_PREFIX}b`, JSON.stringify({ at: day(20, 9).toISOString(), ok: false, code: "network", fails: 3, retry_at: retryAt.toISOString() }));
    await emit(day(20, 9, 1), { readiness: noRunner("openai") });
    expect(sent.map((s) => `${s.id}:${s.event.kind}`)).toEqual(["a:digest"]);
    expect(store.getMeta(NOT_READY_META_KEY)).toBeDefined();
    await emit(retryAt, { readiness: noRunner("openai") });
    expect(sent.map((s) => `${s.id}:${s.event.kind}`)).toEqual(["a:digest"]);
  });

  it("the summary fails on one of two channels: that channel gets the folded alerts in the same run, and the next tick sends nothing", async () => {
    row("a", ["not_ready", "task_failed", "digest"]);
    row("b", ["not_ready", "task_failed", "digest"]);
    store.setMeta(DIGEST_LAST_META_KEY, day(19, 9).toISOString());
    finished("x", "failed", day(20, 9));
    failing.add("a:digest");
    await emit(day(20, 9), { readiness: noRunner("openai"), results: [{ taskId: "x", status: "failed" }] as never });
    expect(sent.map((s) => `${s.id}:${s.event.kind}`).sort()).toEqual(["a:not_ready", "a:task_failed", "b:digest"]);
    failing.clear();
    await emit(day(20, 9, 5), { readiness: noRunner("openai") });
    expect(sent).toHaveLength(3);
  });

  it("a summary at 07:00, inside quiet hours: the held no_runner alert it lists does not arrive again after 09:00", async () => {
    row("n", ["not_ready", "digest"], "night");
    store.setMeta(DIGEST_AT_META_KEY, "07:00");
    store.setMeta(DIGEST_LAST_META_KEY, day(19, 7).toISOString());
    await emit(day(19, 23), { readiness: noRunner("openai") });
    expect(sent).toHaveLength(0);
    await emit(day(20, 7), { readiness: noRunner("openai") });
    expect(sent.map((s) => s.event.kind)).toEqual(["digest"]);
    expect(sent[0]!.text).toContain("Cannot run yet:");
    await emit(day(20, 9), { readiness: noRunner("openai") });
    await emit(day(20, 9, 5), { readiness: noRunner("openai") });
    expect(sent).toHaveLength(1);
  });

  it("lists each task postponed in the window once, counts queued and scheduled tasks, and names the next clean window", async () => {
    row("w", ["digest"]);
    store.setMeta(DIGEST_LAST_META_KEY, day(19, 9).toISOString());
    const waiting = (taskId: string, status: "queued" | "scheduled") =>
      store.upsert({ taskId, status, enqueuedAt: day(19, 8).toISOString(), region: "DE", title: `title ${taskId}` } as TaskRecord<unknown>);
    waiting("p", "scheduled");
    waiting("old", "scheduled");
    waiting("q", "queued");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(day(19, 8));
      store.recordEvent("old", { kind: "postponed" });
      vi.setSystemTime(day(19, 22));
      store.recordEvent("p", { kind: "postponed" });
      vi.setSystemTime(day(20, 1));
      store.recordEvent("p", { kind: "postponed" });
    } finally {
      vi.useRealTimers();
    }
    const window = { start: day(21, 1).toISOString(), end: day(21, 4).toISOString() };
    await emit(day(20, 9), { digest: { store, nextWindow: async () => window } });
    const text = digests()[0]!.text;
    expect(text).toContain("Postponed (1):\n- title p");
    expect(text).not.toContain("title old");
    expect(text).toMatch(/Planned: 3 queued tasks\. Next clean window: .+ to .+\./);
  });

  it("a failed clean-window lookup leaves the window out of the Planned line", async () => {
    row("w", ["digest"]);
    store.setMeta(DIGEST_LAST_META_KEY, day(19, 9).toISOString());
    finished("a", "completed", day(19, 20));
    store.upsert({ taskId: "q", status: "queued", enqueuedAt: day(19, 8).toISOString(), region: "DE", title: "title q" } as TaskRecord<unknown>);
    await emit(day(20, 9), { digest: { store, nextWindow: () => Promise.reject(new Error("offline")) } });
    const text = digests()[0]!.text;
    expect(text).toContain("Planned: 1 queued task.");
    expect(text).not.toContain("Next clean window");
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

describe("jobs in channel events and the daily summary (jobs U8, KTD10, KTD11)", () => {
  let dir: string;
  let store: TaskStore;
  let sent: Array<{ id: string; event: ChannelEvent; text: string }>;
  let failing: Set<string>;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const send: ChannelSender = async (channel, message, event) => {
    if (failing.has(channel.id) || failing.has(`${channel.id}:${event.kind}`)) throw new Error("down");
    if (event.kind === "task_failed" && event.jobPaused && failing.has(`${channel.id}:${event.jobPaused.jobId}`)) throw new Error("down");
    sent.push({ id: channel.id, event, text: message.text });
  };
  const row = (id: string, events: Channel["events"], quiet: "night" | "off" = "off") =>
    store.insertChannel({ id, kind: "webhook", enabled: true, events, config: { quiet }, createdAt: new Date().toISOString() });
  const job = (jobId: string, over: Partial<JobRecord> = {}): JobRecord => {
    const record: JobRecord = {
      jobId,
      title: "Mail triage",
      status: "active",
      cadence: { kind: "daily" },
      timeZone: zone,
      template: { runner: "prompt", prompt: "check mail", provider: "claude-code", tools: "none" },
      caps: { ...DEFAULT_JOB_CAPS },
      notify: "every_run",
      createdAt: day(18, 9).toISOString(),
      updatedAt: day(18, 9).toISOString(),
      revision: 1,
      nextSeq: 2,
      consecutiveFailures: 0,
      retryUsed: false,
      ...over,
    };
    store.insertJob(record);
    return record;
  };
  /** A finished occurrence `<job>~<n>` with a result or an error. */
  const run = (jobId: string, n: number, status: "completed" | "failed", at: Date, over: Partial<TaskRecord<unknown>> = {}) =>
    store.upsert({
      taskId: `${jobId}~${n}`,
      status,
      enqueuedAt: new Date(at.getTime() - 3_600_000).toISOString(),
      completedAt: at.toISOString(),
      deadline: new Date(at.getTime() + 3_600_000).toISOString(),
      region: "DE",
      title: "old title",
      jobId,
      ...(status === "completed" ? { result: { text: "3 messages need a reply" } } : { error: "ssh: connect timed out" }),
      ...over,
    } as TaskRecord<unknown>);
  const emit = (now: Date, over: Partial<Parameters<typeof emitEvents>[0]> = {}) => emitEvents({ store, send, now, digest: { store }, ...over });
  const kinds = () => sent.map((s) => `${s.id}:${s.event.kind}`);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-digest-jobs-"));
    store = new TaskStore({ dbPath: join(dir, "q.db") });
    sent = [];
    failing = new Set();
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("a job's result message leads with the job's current title: 'Mail triage: <result>'", async () => {
    row("w", ["task_done"]);
    job("job-00000001");
    run("job-00000001", 1, "completed", day(20, 14));
    await emit(day(20, 14), { results: [{ taskId: "job-00000001~1", status: "completed" }] as never });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text.split("\n")[0]).toBe("Mail triage: 3 messages need a reply");
    expect(sent[0]!.text).not.toContain("old title");
  });

  it("notify failures: no task_done, the task_failed is sent", async () => {
    row("w", ["task_done", "task_failed"]);
    job("job-00000001", { notify: "failures" });
    run("job-00000001", 1, "completed", day(20, 14));
    run("job-00000001", 2, "failed", day(20, 15));
    await emit(day(20, 15), { results: [{ taskId: "job-00000001~1", status: "completed" }, { taskId: "job-00000001~2", status: "failed" }] as never });
    expect(kinds()).toEqual(["w:task_failed"]);
    expect(sent[0]!.text).toContain("Mail triage: failed");
    expect(sent[0]!.text).toContain("ssh: connect timed out");
  });

  it("notify summary: neither alert; the daily summary lists the job under its title", async () => {
    row("w", ["task_done", "task_failed", "digest"]);
    store.setMeta(DIGEST_LAST_META_KEY, day(19, 9).toISOString());
    job("job-00000001", { notify: "summary" });
    run("job-00000001", 1, "completed", day(19, 14));
    run("job-00000001", 2, "failed", day(19, 15));
    await emit(day(19, 15), { results: [{ taskId: "job-00000001~1", status: "completed" }, { taskId: "job-00000001~2", status: "failed" }] as never });
    expect(sent).toHaveLength(0);
    await emit(day(20, 9));
    expect(kinds()).toEqual(["w:digest"]);
    expect(sent[0]!.text).toContain("Tidegap daily summary: 1 done, 1 failed");
    expect(sent[0]!.text).toContain("Jobs (1):");
    expect(sent[0]!.text).toContain("- Mail triage: 2 runs, 1 failed; last failed Mon 15:00");
  });

  it("covers AE8: an auto-paused job sends one notice whatever its level; a second emit sends nothing", async () => {
    row("w", ["task_failed"]);
    run("job-00000002", 3, "failed", day(20, 2));
    job("job-00000002", {
      title: "deploy logs",
      notify: "summary",
      status: "paused",
      pauseReason: "auto: ssh: connect timed out",
      pausedAt: day(20, 2).toISOString(),
      consecutiveFailures: 3,
      lastTaskId: "job-00000002~3",
      lastOutcome: "failed",
    });
    await emit(day(20, 10), { results: [{ taskId: "job-00000002~3", status: "failed" }] as never });
    expect(kinds()).toEqual(["w:task_failed"]);
    expect(sent[0]!.text.split("\n")[0]).toBe("job 'deploy logs' paused after 3 failures: ssh: connect timed out");
    expect(sent[0]!.text).toContain("tidegap jobs resume job-00000002");
    expect(store.getJob("job-00000002")!.pauseNotifiedAt).toBe(day(20, 10).toISOString());
    await emit(day(20, 10, 5));
    expect(sent).toHaveLength(1);
  });

  it("an auto-pause notice that reached no channel is sent again on the next run", async () => {
    row("w", ["task_failed"]);
    run("job-00000002", 3, "failed", day(20, 2));
    job("job-00000002", { title: "deploy logs", status: "paused", pauseReason: "auto: boom", lastTaskId: "job-00000002~3", consecutiveFailures: 3 });
    failing.add("w");
    await emit(day(20, 10));
    expect(store.getJob("job-00000002")!.pauseNotifiedAt).toBeUndefined();
    failing.clear();
    await emit(day(20, 10, 5));
    expect(kinds()).toEqual(["w:task_failed"]);
    expect(store.getJob("job-00000002")!.pauseNotifiedAt).toBeDefined();
  });

  it("a pause notice is not claimed while quiet hours hold it; it arrives after 09:00; no channel subscribed marks it with no message", async () => {
    row("q", ["task_failed"], "night");
    run("job-00000002", 3, "failed", day(20, 2));
    job("job-00000002", { title: "deploy logs", status: "paused", pauseReason: "auto: boom", lastTaskId: "job-00000002~3", consecutiveFailures: 3 });
    await emit(day(20, 2));
    await emit(day(20, 3));
    expect(sent).toHaveLength(0);
    expect(store.getJob("job-00000002")!).toMatchObject({ pauseNotifiedAt: undefined, revision: 1 });
    await emit(day(20, 9));
    expect(kinds()).toEqual(["q:task_failed"]);
  });

  const pausedJob = (jobId: string, title: string) => {
    run(jobId, 3, "failed", day(20, 2));
    job(jobId, { title, status: "paused", pauseReason: "auto: boom", lastTaskId: `${jobId}~3`, consecutiveFailures: 3 });
  };

  it("with the OS toast (every real tick): quiet hours still hold the notice, and the toast waits with it", async () => {
    row("q", ["task_failed"], "night");
    pausedJob("job-00000002", "deploy logs");
    await emit(day(20, 2), { extraChannels: [osChannel(true)] });
    expect(sent).toHaveLength(0);
    expect(store.getJob("job-00000002")!.pauseNotifiedAt).toBeUndefined();
    await emit(day(20, 9), { extraChannels: [osChannel(true)] });
    expect(kinds().sort()).toEqual(["os:task_failed", "q:task_failed"]);
    expect(store.getJob("job-00000002")!.pauseNotifiedAt).toBeDefined();
  });

  it("with the OS toast: a notice that failed on the only other channel is sent again on the next run", async () => {
    row("w", ["task_failed"]);
    pausedJob("job-00000002", "deploy logs");
    failing.add("w");
    await emit(day(20, 10), { extraChannels: [osChannel(true)] });
    expect(kinds()).toEqual(["os:task_failed"]);
    expect(store.getJob("job-00000002")!.pauseNotifiedAt).toBeUndefined();
    failing.clear();
    await emit(day(20, 10, 5), { extraChannels: [osChannel(true)] });
    expect(kinds()).toContain("w:task_failed");
    expect(store.getJob("job-00000002")!.pauseNotifiedAt).toBeDefined();
  });

  it("only the OS toast subscribes: it carries the notice and the job is marked", async () => {
    pausedJob("job-00000002", "deploy logs");
    await emit(day(20, 10), { extraChannels: [osChannel(true)] });
    expect(kinds()).toEqual(["os:task_failed"]);
    expect(store.getJob("job-00000002")!.pauseNotifiedAt).toBeDefined();
  });

  it("a notice that failed is sent again although another task_failed in the same run got through (per notice, not per kind)", async () => {
    row("w", ["task_failed"]);
    pausedJob("job-00000002", "deploy logs");
    pausedJob("job-00000004", "backups");
    run("job-00000005", 1, "failed", day(20, 9));
    job("job-00000005", { title: "plain" });
    failing.add("w:job-00000004");
    await emit(day(20, 10), { results: [{ taskId: "job-00000005~1", status: "failed" }] as never });
    expect(sent.map((x) => (x.event.kind === "task_failed" && x.event.jobPaused?.jobId) || x.event.kind)).toEqual(["task_failed", "job-00000002"]);
    expect(store.getJob("job-00000002")!.pauseNotifiedAt).toBeDefined();
    expect(store.getJob("job-00000004")!.pauseNotifiedAt).toBeUndefined();
    failing.clear();
    sent = [];
    await emit(day(20, 10, 5));
    expect(sent.map((x) => (x.event.kind === "task_failed" && x.event.jobPaused?.jobId) || x.event.kind)).toEqual(["job-00000004"]);
    expect(store.getJob("job-00000004")!.pauseNotifiedAt).toBeDefined();
  });

  it("no channel subscribed to task_failed: the notice is marked sent with no message", async () => {
    row("w", ["task_done"]);
    run("job-00000003", 3, "failed", day(20, 2));
    job("job-00000003", { title: "other", status: "paused", pauseReason: "auto: boom", lastTaskId: "job-00000003~3", consecutiveFailures: 3 });
    await emit(day(20, 10));
    expect(sent).toHaveLength(0);
    expect(store.getJob("job-00000003")!.pauseNotifiedAt).toBe(day(20, 10).toISOString());
  });

  it("covers AE15: an every-run job finishing at 03:00 in quiet hours arrives once, inside the 09:00 summary, under its title", async () => {
    row("w", ["task_done", "digest"], "night");
    store.setMeta(DIGEST_LAST_META_KEY, day(19, 9).toISOString());
    job("job-00000001");
    run("job-00000001", 1, "completed", day(20, 3));
    await emit(day(20, 3), { results: [{ taskId: "job-00000001~1", status: "completed" }] as never });
    expect(sent).toHaveLength(0);
    await emit(day(20, 9));
    expect(kinds()).toEqual(["w:digest"]);
    expect(sent[0]!.text).toContain('- Mail triage: ok 03:00, "3 messages need a reply"');
    expect(sent[0]!.text).not.toContain("Done (");
    await emit(day(20, 9, 5));
    expect(sent).toHaveLength(1);
  });

  it("a run that finished after its deadline reads 'ran late at'", async () => {
    row("w", ["digest"]);
    store.setMeta(DIGEST_LAST_META_KEY, day(19, 9).toISOString());
    job("job-00000001");
    run("job-00000001", 1, "completed", day(20, 8, 3), { deadline: day(20, 8).toISOString() });
    await emit(day(20, 9));
    expect(sent[0]!.text).toContain("- Mail triage: ran late at 08:03");
  });

  it("11 jobs: 10 printed lines and 'and 1 more'; the 11th job's run keeps its own alert", async () => {
    row("w", ["task_done", "digest"]);
    store.setMeta(DIGEST_LAST_META_KEY, day(19, 9).toISOString());
    const results = [];
    for (let i = 1; i <= 11; i++) {
      const id = `job-000000${String(i).padStart(2, "0")}`;
      job(id, { title: `job ${i}` });
      run(id, 1, "completed", day(20, 8, i));
      results.push({ taskId: `${id}~1`, status: "completed" });
    }
    finished("plain", day(20, 8, 30));
    await emit(day(20, 9), { results: results as never });
    const digest = sent.find((s) => s.event.kind === "digest")!;
    expect(digest.text.split("\n").filter((l) => /^- job \d+:/.test(l))).toHaveLength(10);
    expect(digest.text).toContain("- and 1 more");
    expect(digest.text).toContain("Done (1):");
    expect(sent.filter((s) => s.event.kind === "task_done").map((s) => s.text.split("\n")[0])).toEqual(["job 11: 3 messages need a reply"]);
  });

  it("the summary fails on channel A and reaches B: A gets the job alerts on their own", async () => {
    row("a", ["task_done", "digest"]);
    row("b", ["task_done", "digest"]);
    store.setMeta(DIGEST_LAST_META_KEY, day(19, 9).toISOString());
    job("job-00000001");
    run("job-00000001", 1, "completed", day(20, 9));
    failing.add("a:digest");
    await emit(day(20, 9), { results: [{ taskId: "job-00000001~1", status: "completed" }] as never });
    expect(kinds().sort()).toEqual(["a:task_done", "b:digest"]);
  });

  it("series occurrences stay in the flat Done section", async () => {
    row("w", ["digest"]);
    store.setMeta(DIGEST_LAST_META_KEY, day(19, 9).toISOString());
    store.upsert({ taskId: "s-1~2", status: "completed", enqueuedAt: day(19, 10).toISOString(), completedAt: day(19, 11).toISOString(), region: "DE", title: "weekly report", seriesId: "s-1", repeat: "daily" } as TaskRecord<unknown>);
    await emit(day(20, 9));
    expect(sent[0]!.text).toContain("Done (1):\n- weekly report");
    expect(sent[0]!.text).not.toContain("Jobs (");
  });

  /** A finished plain task. */
  function finished(taskId: string, at: Date) {
    store.upsert({ taskId, status: "completed", enqueuedAt: new Date(at.getTime() - 3_600_000).toISOString(), completedAt: at.toISOString(), region: "DE", title: `title ${taskId}` } as TaskRecord<unknown>);
  }
});
