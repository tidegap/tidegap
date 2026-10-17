/**
 * Core task actions (ui v2, U2): cancel with compare-and-set, stop series,
 * run now, reschedule (deadline / exact time / day), reply, and the
 * allowed-actions table. Every action is driven through a store-backed
 * Scheduler; several tests use two Scheduler instances on one ledger to
 * model the UI server and a ticker as separate processes.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  displayTitle,
  mockGridFeed,
  prepareTick,
  Scheduler,
  TaskActionError,
  taskActions,
  TaskStore,
} from "../src/index.js";
import type { ProviderAdapter, TaskRecord, TaskStatus } from "../src/index.js";

const H = 3_600_000;
const SPEC = {
  type: "provider_call" as const,
  provider: "anthropic" as const,
  model: "claude-sonnet-4-6",
  prompt: "Translate the README\nsecond line",
};

interface RecordingAdapter extends ProviderAdapter {
  calls: Array<{ model: string; prompt: string }>;
  batchCalls: number;
}

function adapter(opts: { batch?: boolean; gate?: Promise<void> } = {}): RecordingAdapter {
  const a: RecordingAdapter = {
    provider: "anthropic",
    ready: true,
    calls: [],
    batchCalls: 0,
    async dispatch(model, prompt) {
      a.calls.push({ model, prompt });
      if (opts.gate) await opts.gate;
      return { text: `reply to ${prompt}`, model, provider: "anthropic", raw: null };
    },
  };
  if (opts.batch) {
    a.dispatchBatch = async (_m, prompts) => {
      a.batchCalls += 1;
      return { batchId: "b-1", provider: "anthropic", size: prompts.length };
    };
    a.retrieveBatch = async () => ({ status: "in_progress" });
  }
  return a;
}

describe("task actions (ui v2)", () => {
  let dir: string;
  let dbPath: string;
  const open: Scheduler[] = [];

  function sched(): Scheduler {
    const s = new Scheduler({ dbPath, feed: mockGridFeed(), signing: false, rng: () => 0 });
    open.push(s);
    return s;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-actions-"));
    dbPath = join(dir, "queue.db");
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const s of open.splice(0)) s.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  async function enqueue(s: Scheduler, deadlineH = 6, extra: Record<string, unknown> = {}) {
    return s.enqueueProviderCall(SPEC, {
      deadline: new Date(Date.now() + deadlineH * H),
      region: "DE",
      ...extra,
    });
  }

  function raw(): TaskStore {
    return new TaskStore({ dbPath });
  }

  describe("cancel", () => {
    it("a second process cancels a row the first process holds cached as scheduled", async () => {
      const a = sched();
      const rec = await enqueue(a);
      expect(a.getTask(rec.taskId)?.status).toBe("scheduled");
      const b = sched();
      expect(b.cancelTask(rec.taskId).status).toBe("cancelled");
      // The first process still holds its cached copy; its cancel sees the
      // stored terminal row and returns it unchanged.
      expect(a.cancelTask(rec.taskId).status).toBe("cancelled");
      const store = raw();
      expect(store.get(rec.taskId)?.status).toBe("cancelled");
      store.close();
    });

    it("a ticker that claimed first wins; cancel marks the running row and the late result is dropped", async () => {
      const ticker = sched();
      const rec = await enqueue(ticker);
      const store = raw();
      const row = store.get(rec.taskId)!;
      store.upsert({ ...row, scheduledFor: new Date(Date.now() - 60_000).toISOString() });
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const a = adapter({ gate });
      const tick = ticker.tick({ anthropic: a });
      await vi.waitFor(() => expect(a.calls).toHaveLength(1));
      const ui = sched();
      const cancelled = ui.cancelTask(rec.taskId);
      expect(cancelled.status).toBe("cancelled");
      release();
      await tick;
      expect(store.get(rec.taskId)?.status).toBe("cancelled");
      expect(store.get(rec.taskId)?.result).toBeUndefined();
      store.close();
    });

    it("cancel on a completed row returns it unchanged", async () => {
      const s = sched();
      const rec = await enqueue(s);
      s.runNow(rec.taskId);
      await s.tick({ anthropic: adapter() });
      const before = raw().get(rec.taskId)!;
      expect(before.status).toBe("completed");
      const after = sched().cancelTask(rec.taskId);
      expect(after.status).toBe("completed");
      expect(after.completedAt).toBe(before.completedAt);
    });

    it("cancel with series: true ends the series (repeat none)", async () => {
      const s = sched();
      const rec = await enqueue(s, 6, { repeat: "weekly" });
      const out = sched().cancelTask(rec.taskId, { series: true });
      expect(out.status).toBe("cancelled");
      expect(raw().get(rec.taskId)?.repeat).toBe("none");
    });
  });

  describe("run now", () => {
    it("marks the row due and expedited; the next tick runs it sync even with a 3-day deadline", async () => {
      const s = sched();
      const rec = await enqueue(s, 72);
      const out = sched().runNow(rec.taskId);
      expect(Date.parse(out.scheduledFor!)).toBeLessThanOrEqual(Date.now());
      expect(out.intensitySource).toBe("expedited");
      const a = adapter({ batch: true });
      const res = await sched().tick({ anthropic: a });
      expect(res.batchSubmitted).toBe(0);
      expect(a.batchCalls).toBe(0);
      expect(a.calls).toHaveLength(1);
      const row = raw().get(rec.taskId)!;
      expect(row.status).toBe("completed");
      expect(row.intensitySource).toBe("expedited");
    });

    it("a long-lived ticker with a stale cache dispatches a run-now row sync (no batch submit)", async () => {
      const ticker = sched();
      const rec = await enqueue(ticker, 72);
      const a = adapter({ batch: true });
      // Make the row non-batch on the first tick (deadline < 24 h) so the
      // ticker caches it as scheduled, then restore the 3-day deadline. The
      // mock curve can pick the current hour (04:xx UTC), so pin the row an
      // hour out or the first tick would already run it.
      const store = raw();
      const row = store.get(rec.taskId)!;
      store.upsert({
        ...row,
        scheduledFor: new Date(Date.now() + H).toISOString(),
        deadline: new Date(Date.now() + 12 * H).toISOString(),
      });
      await ticker.tick({ anthropic: a });
      store.upsert({ ...store.get(rec.taskId)!, deadline: new Date(Date.now() + 72 * H).toISOString() });
      expect(ticker.getTask(rec.taskId)?.status).toBe("scheduled");
      sched().runNow(rec.taskId);
      await ticker.tick({ anthropic: a });
      expect(a.batchCalls).toBe(0);
      expect(a.calls).toHaveLength(1);
      expect(store.get(rec.taskId)?.status).toBe("completed");
      store.close();
    });

    it("refuses running, terminal and closure tasks", async () => {
      const s = sched();
      const running = await enqueue(s);
      const store = raw();
      store.claimScheduled(running.taskId);
      expect(() => sched().runNow(running.taskId)).toThrow(/runNow: task .* is running/);
      const done = await enqueue(s);
      sched().cancelTask(done.taskId);
      expect(() => sched().runNow(done.taskId)).toThrow(/is cancelled/);
      const closure = s.enqueue(async () => 1, { deadline: new Date(Date.now() + 6 * H) });
      expect(() => s.runNow(closure.taskId)).toThrow(/provider-call/);
      store.close();
    });
  });

  describe("reschedule", () => {
    it("{deadline} re-runs the window picker inside the new deadline and clears any pin", async () => {
      const s = sched();
      const rec = await enqueue(s, 6);
      const deadline = new Date(Date.now() + 30 * H);
      const out = await sched().rescheduleTask(rec.taskId, { deadline: deadline.toISOString() });
      expect(out.status).toBe("scheduled");
      expect(out.deadline).toBe(deadline.toISOString());
      expect(out.notBefore).toBeUndefined();
      expect(Date.parse(out.scheduledFor!)).toBeLessThanOrEqual(deadline.getTime());
      expect(out.estimatedCarbonGCo2).toBeDefined();
    });

    it("{at} pins the time exactly and raises the deadline", async () => {
      const s = sched();
      const rec = await enqueue(s, 6);
      const at = new Date(Date.now() + 20 * H);
      const out = await sched().rescheduleTask(rec.taskId, { at: at.toISOString() });
      expect(out.scheduledFor).toBe(at.toISOString());
      expect(out.notBefore).toBe(at.toISOString());
      expect(out.deadline).toBe(at.toISOString());
      const row = raw().get(rec.taskId)!;
      expect(row.scheduledFor).toBe(at.toISOString());
    });

    it("{dayStart, dayEnd} with a covering forecast picks an hour inside the day", async () => {
      const s = sched();
      const rec = await enqueue(s, 6);
      const dayStart = new Date(Date.now() + 30 * H);
      const dayEnd = new Date(dayStart.getTime() + 24 * H);
      const out = await sched().rescheduleTask(rec.taskId, {
        dayStart: dayStart.toISOString(),
        dayEnd: dayEnd.toISOString(),
      });
      const t = Date.parse(out.scheduledFor!);
      expect(t).toBeGreaterThanOrEqual(dayStart.getTime());
      expect(t).toBeLessThanOrEqual(dayEnd.getTime());
      expect(out.estimatedCarbonGCo2).toBeDefined();
      expect(out.deadline).toBe(dayEnd.toISOString());
    });

    it("a day beyond the forecast keeps the hour of day, unplanned", async () => {
      const s = sched();
      const rec = await enqueue(s, 6);
      const oldAt = Date.parse(raw().get(rec.taskId)!.scheduledFor!);
      const dayStart = new Date(Date.now() + 4 * 24 * H);
      dayStart.setUTCHours(0, 0, 0, 0);
      const dayEnd = new Date(dayStart.getTime() + 24 * H);
      const out = await sched().rescheduleTask(rec.taskId, {
        dayStart: dayStart.toISOString(),
        dayEnd: dayEnd.toISOString(),
      });
      const offset = (((oldAt - dayStart.getTime()) % (24 * H)) + 24 * H) % (24 * H);
      // The day's first instant moves one minute in (it would read as an exact pin).
      expect(out.scheduledFor).toBe(new Date(dayStart.getTime() + Math.max(offset, 60_000)).toISOString());
      expect(out.notBefore).toBe(dayStart.toISOString());
      expect(out.estimatedCarbonGCo2).toBeUndefined();
      expect(out.status).toBe("scheduled");
    });

    it("a quota_reset row becomes absolute", async () => {
      const s = sched();
      const rec = await enqueue(s, 6, { deadlineKind: "quota_reset", quotaProvider: "claude" });
      await sched().rescheduleTask(rec.taskId, {
        deadline: new Date(Date.now() + 10 * H).toISOString(),
      });
      const row = raw().get(rec.taskId)!;
      expect(row.deadlineKind).toBe("absolute");
      expect(row.quotaProvider).toBeUndefined();
    });

    it("pinned rows far ahead are not batch-submitted; replanSweep plans them once in range", async () => {
      const s = sched();
      const day = await enqueue(s, 6);
      const at = await enqueue(s, 6);
      const dayStart = new Date(Date.now() + 4 * 24 * H);
      dayStart.setUTCHours(0, 0, 0, 0);
      const dayEnd = new Date(dayStart.getTime() + 24 * H);
      const ui = sched();
      await ui.rescheduleTask(day.taskId, {
        dayStart: dayStart.toISOString(),
        dayEnd: dayEnd.toISOString(),
      });
      await ui.rescheduleTask(at.taskId, { at: new Date(Date.now() + 3 * 24 * H).toISOString() });
      const a = adapter({ batch: true });
      const ticker = sched();
      await prepareTick(ticker, { quotaConfig: {} });
      const res = await ticker.tick({ anthropic: a });
      expect(res.batchSubmitted).toBe(0);
      expect(a.batchCalls).toBe(0);
      expect(raw().get(day.taskId)?.estimatedCarbonGCo2).toBeUndefined();

      // Two days later the day is inside the 72 h forecast horizon.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(Date.now() + 2 * 24 * H));
      const later = sched();
      await prepareTick(later, { quotaConfig: {} });
      const row = raw().get(day.taskId)!;
      expect(row.estimatedCarbonGCo2).toBeDefined();
      const t = Date.parse(row.scheduledFor!);
      expect(t).toBeGreaterThanOrEqual(dayStart.getTime());
      expect(t).toBeLessThanOrEqual(dayEnd.getTime());
      // The exact-time pin is never re-planned.
      expect(raw().get(at.taskId)?.estimatedCarbonGCo2).toBeUndefined();
    });

    it("a day pin whose fallback lands on the day's first instant is still planned (not read as an exact pin)", async () => {
      // CI failed at 19:xx UTC: the 6 h window picked 00:00 UTC, the day
      // fallback kept that time of day, scheduledFor === notBefore, and
      // replanSweep skipped the row as an exact-time pin.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-16T19:30:00.000Z"));
      const rec = await enqueue(sched(), 6);
      const store = raw();
      store.upsert({ ...store.get(rec.taskId)!, scheduledFor: "2026-10-17T00:00:00.000Z" });
      const dayStart = new Date("2026-10-20T00:00:00.000Z");
      const dayEnd = new Date("2026-10-21T00:00:00.000Z");
      const out = await sched().rescheduleTask(rec.taskId, {
        dayStart: dayStart.toISOString(),
        dayEnd: dayEnd.toISOString(),
      });
      expect(out.estimatedCarbonGCo2).toBeUndefined();
      expect(out.notBefore).toBe(dayStart.toISOString());
      expect(out.scheduledFor).not.toBe(out.notBefore);
      vi.setSystemTime(new Date("2026-10-18T19:30:00.000Z"));
      await prepareTick(sched(), { quotaConfig: {} });
      const row = store.get(rec.taskId)!;
      expect(row.estimatedCarbonGCo2).toBeDefined();
      const t = Date.parse(row.scheduledFor!);
      expect(t).toBeGreaterThanOrEqual(dayStart.getTime());
      expect(t).toBeLessThanOrEqual(dayEnd.getTime());
      store.close();
    });

    it("refuses running, submitted and terminal rows", async () => {
      const s = sched();
      const store = raw();
      const target = { deadline: new Date(Date.now() + 10 * H).toISOString() };
      const running = await enqueue(s);
      store.claimScheduled(running.taskId);
      await expect(sched().rescheduleTask(running.taskId, target)).rejects.toThrow(
        /reschedule: task .* is running/,
      );
      const submitted = await enqueue(s);
      store.upsert({ ...store.get(submitted.taskId)!, status: "submitted", batchId: "b" });
      await expect(sched().rescheduleTask(submitted.taskId, target)).rejects.toThrow(/submitted/);
      const done = await enqueue(s);
      sched().cancelTask(done.taskId);
      await expect(sched().rescheduleTask(done.taskId, target)).rejects.toThrow(/cancelled/);
      store.close();
    });
  });

  describe("review fixes", () => {
    it("a day whose first hours just entered the forecast stays unplanned until its first 24 h are covered", async () => {
      const s = sched();
      const rec = await enqueue(s, 6);
      const dayStart = new Date(Date.now() + 60 * H);
      const dayEnd = new Date(dayStart.getTime() + 24 * H);
      const out = await sched().rescheduleTask(rec.taskId, {
        dayStart: dayStart.toISOString(),
        dayEnd: dayEnd.toISOString(),
      });
      expect(out.estimatedCarbonGCo2).toBeUndefined();
      await prepareTick(sched(), { quotaConfig: {} });
      expect(raw().get(rec.taskId)?.estimatedCarbonGCo2).toBeUndefined();
      // 13 h later the whole day is inside the 72 h horizon.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(Date.now() + 13 * H));
      await prepareTick(sched(), { quotaConfig: {} });
      const row = raw().get(rec.taskId)!;
      expect(row.estimatedCarbonGCo2).toBeDefined();
      expect(Date.parse(row.scheduledFor!)).toBeGreaterThanOrEqual(dayStart.getTime());
    });

    it("a sweep that awaited the forecast does not overwrite a run-now written meanwhile", async () => {
      const rec = await enqueue(sched(), 6);
      const inner = mockGridFeed();
      let hook: (() => void) | undefined;
      const sweeper = new Scheduler({
        dbPath,
        signing: false,
        rng: () => 0,
        feed: {
          source: "mock",
          fetchForecast: async (r, h) => {
            const f = await inner.fetchForecast(r, h);
            const run = hook;
            hook = undefined;
            run?.();
            return f;
          },
        },
      });
      open.push(sweeper);
      hook = () => sched().runNow(rec.taskId);
      expect(await sweeper.rescheduleIfPending(rec.taskId, new Date(Date.now() + 10 * H))).toBe(false);
      const row = raw().get(rec.taskId)!;
      expect(row.intensitySource).toBe("expedited");
      expect(row.deadline).toBe(rec.deadline);
    });

    it("a reschedule that fails the task on its carbon budget is refused, not reported as moved", async () => {
      const rec = await enqueue(sched(), 6, { carbonBudgetG: 1e9 });
      const store = raw();
      store.upsert({ ...store.get(rec.taskId)!, carbonBudgetG: 0 });
      store.close();
      await expect(
        sched().rescheduleTask(rec.taskId, { deadline: new Date(Date.now() + 10 * H).toISOString() }),
      ).rejects.toThrow(TaskActionError);
      expect(raw().get(rec.taskId)?.status).toBe("failed");
    });
  });

  describe("reply", () => {
    it("creates a child with the parent's history, provider, model and region", async () => {
      const s = sched();
      const parent = await enqueue(s, 6, { originSessionId: "sess-12345678" });
      s.runNow(parent.taskId);
      await s.tick({ anthropic: adapter() });
      const before = Date.now();
      const child = await sched().replyToTask(parent.taskId, "and the CHANGELOG?");
      expect(child.parentTaskId).toBe(parent.taskId);
      expect(child.region).toBe("DE");
      expect(child.repeat ?? "none").toBe("none");
      expect(child.originSessionId).toBe("sess-12345678");
      expect(child.title).toBe("Re: Translate the README");
      const dl = Date.parse(child.deadline!);
      expect(dl).toBeGreaterThanOrEqual(before + H - 5_000);
      expect(dl).toBeLessThanOrEqual(Date.now() + H + 5_000);
      const spec = JSON.parse(child.bodyJson!);
      expect(spec.provider).toBe("anthropic");
      expect(spec.model).toBe("claude-sonnet-4-6");
      expect(spec.prompt).toBe("and the CHANGELOG?");
      expect(spec.messages).toEqual([
        { role: "user", content: SPEC.prompt },
        { role: "assistant", content: `reply to ${SPEC.prompt}` },
      ]);
    });

    it("a reply child keeps the parent's tools", async () => {
      const s = sched();
      const parent = await s.enqueueProviderCall(
        { ...SPEC, tools: ["WebFetch"] },
        { deadline: new Date(Date.now() + 6 * H), region: "DE" },
      );
      s.runNow(parent.taskId);
      await s.tick({ anthropic: adapter() });
      const child = await sched().replyToTask(parent.taskId, "more");
      expect(JSON.parse(child.bodyJson!).tools).toEqual(["WebFetch"]);
    });

    it("a reply child dispatches the full conversation through tick (AE3)", async () => {
      const s = sched();
      const parent = await enqueue(s);
      s.runNow(parent.taskId);
      await s.tick({ anthropic: adapter() });
      const child = await sched().replyToTask(parent.taskId, "and the CHANGELOG?");
      const ui = sched();
      ui.runNow(child.taskId);
      const seen: unknown[] = [];
      const rec: ProviderAdapter = {
        provider: "anthropic",
        ready: true,
        async dispatch(model, prompt, o) {
          seen.push([...(o?.messages ?? []), { role: "user", content: prompt }]);
          return { text: "ok", model, provider: "anthropic", raw: null };
        },
      };
      await sched().tick({ anthropic: rec });
      expect(seen).toEqual([
        [
          { role: "user", content: SPEC.prompt },
          { role: "assistant", content: `reply to ${SPEC.prompt}` },
          { role: "user", content: "and the CHANGELOG?" },
        ],
      ]);
    });

    it("the batch path sends the history too", async () => {
      const s = sched();
      const history = [
        { role: "user" as const, content: "q" },
        { role: "assistant" as const, content: "a" },
      ];
      await s.enqueueProviderCall(
        { ...SPEC, messages: history },
        { deadline: new Date(Date.now() + 72 * H), region: "DE" },
      );
      let sent: unknown;
      const rec: ProviderAdapter = {
        provider: "anthropic",
        ready: true,
        async dispatch() {
          throw new Error("sync path not expected");
        },
        async dispatchBatch(_m, prompts, o) {
          sent = o?.messages;
          return { batchId: "b", provider: "anthropic", size: prompts.length };
        },
      };
      const res = await sched().tick({ anthropic: rec });
      expect(res.batchSubmitted).toBe(1);
      expect(sent).toEqual(history);
    });

    it("refuses failed and cancelled parents (AE4)", async () => {
      const s = sched();
      const cancelled = await enqueue(s);
      s.cancelTask(cancelled.taskId);
      await expect(sched().replyToTask(cancelled.taskId, "hi")).rejects.toThrow(
        /reply: task .* is cancelled/,
      );
      const failed = await enqueue(s);
      s.runNow(failed.taskId);
      await s.tick({}); // no adapter -> failed
      expect(raw().get(failed.taskId)?.status).toBe("failed");
      await expect(sched().replyToTask(failed.taskId, "hi")).rejects.toThrow(/is failed/);
    });
  });
});

describe("taskActions", () => {
  const body = JSON.stringify(SPEC);
  const base = (status: TaskStatus, extra: Partial<TaskRecord> = {}): TaskRecord => ({
    taskId: "t",
    status,
    enqueuedAt: "2026-10-10T00:00:00.000Z",
    region: "DE",
    bodyJson: body,
    ...extra,
  });

  it.each([
    ["queued", { cancel: true, stopSeries: false, reschedule: true, runNow: true, reply: false, markRead: false }],
    ["scheduled", { cancel: true, stopSeries: false, reschedule: true, runNow: true, reply: false, markRead: false }],
    ["submitted", { cancel: true, stopSeries: false, reschedule: false, runNow: false, reply: false, markRead: false }],
    ["running", { cancel: true, stopSeries: false, reschedule: false, runNow: false, reply: false, markRead: false }],
    ["completed", { cancel: false, stopSeries: false, reschedule: false, runNow: false, reply: true, markRead: true }],
    ["failed", { cancel: false, stopSeries: false, reschedule: false, runNow: false, reply: false, markRead: true }],
    ["cancelled", { cancel: false, stopSeries: false, reschedule: false, runNow: false, reply: false, markRead: false }],
  ] as const)("provider-call %s", (status, expected) => {
    expect(taskActions(base(status))).toEqual(expected);
  });

  it("series occurrences can stop the series while pending", () => {
    expect(taskActions(base("scheduled", { repeat: "weekly", seriesId: "t" })).stopSeries).toBe(true);
    expect(taskActions(base("running", { repeat: "daily", seriesId: "t" })).stopSeries).toBe(true);
    expect(taskActions(base("completed", { repeat: "weekly", seriesId: "t" })).stopSeries).toBe(false);
    expect(taskActions(base("scheduled", { repeat: "none", seriesId: "t" })).stopSeries).toBe(false);
  });

  it("closure tasks can only be cancelled", () => {
    expect(taskActions(base("scheduled", { bodyJson: undefined }))).toEqual({
      cancel: true,
      stopSeries: false,
      reschedule: false,
      runNow: false,
      reply: false,
      markRead: false,
    });
    expect(taskActions(base("completed", { bodyJson: undefined })).reply).toBe(false);
  });
});

describe("displayTitle", () => {
  it("prefers the stored title", () => {
    expect(
      displayTitle({ taskId: "t", status: "queued", enqueuedAt: "x", region: "DE", title: "Stored" }),
    ).toBe("Stored");
  });

  it("derives the redacted first prompt line when no title is stored", () => {
    const rec: TaskRecord = {
      taskId: "t",
      status: "completed",
      enqueuedAt: "x",
      region: "DE",
      bodyJson: JSON.stringify({ ...SPEC, prompt: "\nuse sk-ant-abcdefghijklmnopqrstuvwxyz0123 now\nmore" }),
    };
    const title = displayTitle(rec)!;
    expect(title).not.toContain("sk-ant-abcdefghijklmnopqrstuvwxyz0123");
    expect(title.startsWith("use ")).toBe(true);
  });
});
