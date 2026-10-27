/**
 * Series rollover (ui v2, U4): a repeating occurrence that finishes
 * (completed, failed, or cancelled as a skip) inserts exactly one successor
 * `<series_id>~<n+1>`, scheduled and unplanned, before its own terminal
 * write. A stopped series inserts nothing.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mockGridFeed, prepareTick, Scheduler, TaskStore } from "../src/index.js";
import type { GridFeed, ProviderAdapter, QuotaResetConfig } from "../src/index.js";

const H = 3_600_000;
const DAY = 24 * H;
const KEYISH = "sk-ant-abcdefghijklmnopqrstuvwxyz0123";
const SPEC = {
  type: "provider_call" as const,
  provider: "anthropic" as const,
  model: "claude-sonnet-4-6",
  prompt: `weekly limit report with ${KEYISH}`,
};

function adapter(opts: { fail?: boolean; batch?: boolean; gate?: Promise<void> } = {}): ProviderAdapter {
  const a: ProviderAdapter = {
    provider: "anthropic",
    ready: true,
    async dispatch(model) {
      if (opts.gate) await opts.gate;
      if (opts.fail) throw Object.assign(new Error("bad request"), { status: 400 });
      return { text: "done", model, provider: "anthropic", raw: null };
    },
  };
  if (opts.batch) {
    a.dispatchBatch = async (_m, prompts) => ({ batchId: "b", provider: "anthropic", size: prompts.length });
  }
  return a;
}

describe("series rollover", () => {
  let dir: string;
  let dbPath: string;
  const open: Scheduler[] = [];

  function sched(extra: { feed?: GridFeed; quotaConfig?: () => QuotaResetConfig } = {}): Scheduler {
    const s = new Scheduler({
      dbPath,
      feed: extra.feed ?? mockGridFeed(),
      signing: false,
      rng: () => 0,
      quotaConfig: extra.quotaConfig,
    });
    open.push(s);
    return s;
  }
  function store(): TaskStore {
    return new TaskStore({ dbPath });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-series-"));
    dbPath = join(dir, "queue.db");
  });
  afterEach(() => {
    vi.useRealTimers();
    for (const s of open.splice(0)) s.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  async function occurrence(
    s: Scheduler,
    repeat: "daily" | "weekly" | "quota_reset",
    deadlineH = 6,
    extra: Record<string, unknown> = {},
  ) {
    return s.enqueueProviderCall(SPEC, {
      deadline: new Date(Date.now() + deadlineH * H),
      region: "DE",
      repeat,
      ...extra,
    });
  }

  it("a completed weekly occurrence inserts one successor +7 d with the unredacted prompt", async () => {
    const s = sched();
    const occ = await occurrence(s, "weekly");
    s.runNow(occ.taskId);
    await s.tick({ anthropic: adapter() });
    const db = store();
    const done = db.get(occ.taskId)!;
    expect(done.status).toBe("completed");
    expect(done.bodyJson).not.toContain(KEYISH);
    const next = db.get(`${occ.taskId}~2`)!;
    expect(next.status).toBe("scheduled");
    expect(next.seriesId).toBe(occ.taskId);
    expect(next.repeat).toBe("weekly");
    expect(Date.parse(next.deadline!)).toBe(Date.parse(occ.deadline!) + 7 * DAY);
    expect(JSON.parse(next.bodyJson!).prompt).toBe(SPEC.prompt);
    expect(next.parentTaskId).toBeUndefined();
    expect(db.list({ seriesId: occ.taskId })).toHaveLength(2);
    db.close();
  });

  it("successor: notBefore is the previous deadline, unplanned, not batch-submitted", async () => {
    const s = sched();
    const occ = await occurrence(s, "weekly");
    s.runNow(occ.taskId);
    await s.tick({ anthropic: adapter() });
    const db = store();
    const next = db.get(`${occ.taskId}~2`)!;
    expect(next.notBefore).toBe(occ.deadline);
    expect(Date.parse(next.scheduledFor!)).toBeGreaterThanOrEqual(Date.parse(occ.deadline!));
    expect(next.estimatedCarbonGCo2).toBeUndefined();
    const res = await sched().tick({ anthropic: adapter({ batch: true }) });
    expect(res.batchSubmitted).toBe(0);
    db.close();
  });

  it("a daily occurrence whose next deadline is past rolls forward to the future", async () => {
    const s = sched();
    const occ = await occurrence(s, "daily");
    const db = store();
    // The occurrence was due three days ago.
    const old = new Date(Date.now() - 3 * DAY).toISOString();
    db.upsert({ ...db.get(occ.taskId)!, deadline: old, scheduledFor: old });
    await s.tick({ anthropic: adapter() });
    const next = db.get(`${occ.taskId}~2`)!;
    const dl = Date.parse(next.deadline!);
    expect(dl).toBeGreaterThan(Date.now() + H - 5_000);
    expect(dl).toBeLessThanOrEqual(Date.now() + DAY + H);
    expect((dl - Date.parse(old)) % DAY).toBe(0);
    db.close();
  });

  it("a failed occurrence rolls; a cancelled skip rolls; stop series does not", async () => {
    const s = sched();
    const failed = await occurrence(s, "daily");
    s.runNow(failed.taskId);
    await s.tick({ anthropic: adapter({ fail: true }) });
    const skipped = await occurrence(s, "daily");
    sched().cancelTask(skipped.taskId);
    const stopped = await occurrence(s, "daily");
    sched().cancelTask(stopped.taskId, { series: true });
    const db = store();
    expect(db.get(failed.taskId)?.status).toBe("failed");
    expect(db.get(`${failed.taskId}~2`)?.status).toBe("scheduled");
    expect(db.get(`${skipped.taskId}~2`)?.status).toBe("scheduled");
    expect(db.get(`${stopped.taskId}~2`)).toBeUndefined();
    db.close();
  });

  it("two schedulers finishing the same occurrence produce one successor", async () => {
    const s = sched();
    const occ = await occurrence(s, "weekly");
    const a = sched();
    const b = sched();
    // Double terminal: one process cancels (skip) while another, holding a
    // claimed running row, completes it.
    const db = store();
    s.runNow(occ.taskId);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const tick = a.tick({ anthropic: adapter({ gate }) });
    await vi.waitFor(() => expect(db.get(occ.taskId)?.status).toBe("running"));
    b.cancelTask(occ.taskId);
    release();
    await tick;
    expect(db.list({ seriesId: occ.taskId }).map((r) => r.taskId)).toEqual([
      occ.taskId,
      `${occ.taskId}~2`,
    ]);
    db.close();
  });

  it("a successor's id counts up: ~2 finishes into ~3", async () => {
    const s = sched();
    const occ = await occurrence(s, "daily");
    s.cancelTask(occ.taskId);
    s.cancelTask(`${occ.taskId}~2`);
    const db = store();
    expect(db.get(`${occ.taskId}~3`)?.status).toBe("scheduled");
    db.close();
  });

  it("stop series while the occurrence runs: no successor when the call completes or fails", async () => {
    for (const fail of [false, true]) {
      const s = sched();
      const occ = await occurrence(s, "daily");
      s.runNow(occ.taskId);
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const db = store();
      const tick = s.tick({ anthropic: adapter({ gate, fail }) });
      await vi.waitFor(() => expect(db.get(occ.taskId)?.status).toBe("running"));
      sched().cancelTask(occ.taskId, { series: true });
      release();
      await tick;
      expect(db.get(`${occ.taskId}~2`)).toBeUndefined();
      expect(db.get(occ.taskId)?.status).toBe("cancelled");
      db.close();
    }
  });

  it("stop series on one pending occurrence also cancels a pending successor", async () => {
    const s = sched();
    const occ = await occurrence(s, "daily");
    s.cancelTask(occ.taskId);
    const db = store();
    const succ = `${occ.taskId}~2`;
    expect(db.get(succ)?.status).toBe("scheduled");
    // OpenClaw's restoreToScheduled can leave an occurrence pending beside
    // its successor; stopping the series from it must end both.
    db.upsert({ ...db.get(occ.taskId)!, status: "scheduled", completedAt: undefined });
    sched().cancelTask(occ.taskId, { series: true });
    expect(db.get(succ)?.status).toBe("cancelled");
    expect(db.get(succ)?.repeat).toBe("none");
    expect(db.get(`${occ.taskId}~3`)).toBeUndefined();
    db.close();
  });

  it("stop series from a finished occurrence ends its live successor", async () => {
    const quota: QuotaResetConfig = {
      claude: { label: "claude", weekday: 4, hour: 9, minute: 0, timeZone: "UTC", marginH: 2 },
    };
    const s = sched({ quotaConfig: () => quota });
    const occ = await occurrence(s, "quota_reset", 6, { deadlineKind: "quota_reset", quotaProvider: "claude" });
    s.runNow(occ.taskId);
    await s.tick({ anthropic: adapter() });
    const succ = `${occ.taskId}~2`;
    const db = store();
    expect(db.get(succ)?.status).toBe("scheduled");
    const out = sched().cancelTask(occ.taskId, { series: true });
    expect(out.status).toBe("completed");
    expect(db.get(succ)).toMatchObject({ status: "cancelled", repeat: "none" });
    expect(db.get(`${occ.taskId}~3`)).toBeUndefined();
    db.close();
  });

  it("a no-adapter failure does not roll the series", async () => {
    const s = sched();
    const occ = await occurrence(s, "daily");
    s.runNow(occ.taskId);
    const res = await sched().tick({});
    expect(res.results.find((r) => r.taskId === occ.taskId)?.status).toBe("failed");
    const db = store();
    expect(db.get(`${occ.taskId}~2`)).toBeUndefined();
    db.close();
  });

  it("budget failure of a successor at re-plan time fails it and rolls no further", async () => {
    const s = sched();
    const occ = await occurrence(s, "daily", 6, { carbonBudgetG: 1e9 });
    s.cancelTask(occ.taskId);
    const db = store();
    const succ = `${occ.taskId}~2`;
    // Tighten the budget so no window fits once the successor is planned.
    db.upsert({ ...db.get(succ)!, carbonBudgetG: 0 });
    await prepareTick(sched(), { quotaConfig: {} });
    expect(db.get(succ)?.status).toBe("failed");
    expect(db.get(`${occ.taskId}~3`)).toBeUndefined();
    db.close();
  });

  it("replanSweep gives a successor a window inside its period once in range", async () => {
    const s = sched();
    const occ = await occurrence(s, "weekly");
    s.cancelTask(occ.taskId);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 6 * DAY));
    await prepareTick(sched(), { quotaConfig: {} });
    const db = store();
    const next = db.get(`${occ.taskId}~2`)!;
    expect(next.estimatedCarbonGCo2).toBeDefined();
    const t = Date.parse(next.scheduledFor!);
    expect(t).toBeGreaterThanOrEqual(Date.parse(occ.deadline!));
    expect(t).toBeLessThanOrEqual(Date.parse(next.deadline!));
    db.close();
  });

  it("quota_reset series: successor keeps the series kind and label after one occurrence moved", async () => {
    const quota: QuotaResetConfig = {
      claude: { label: "claude", weekday: 4, hour: 9, minute: 0, timeZone: "UTC", marginH: 2 },
    };
    const s = sched({ quotaConfig: () => quota });
    const occ = await occurrence(s, "quota_reset", 6, {
      deadlineKind: "quota_reset",
      quotaProvider: "claude",
    });
    // Moving the occurrence makes that row absolute.
    await s.rescheduleTask(occ.taskId, { deadline: new Date(Date.now() + 8 * H).toISOString() });
    s.runNow(occ.taskId);
    await s.tick({ anthropic: adapter() });
    const db = store();
    expect(db.get(occ.taskId)?.deadlineKind).toBe("absolute");
    const next = db.get(`${occ.taskId}~2`)!;
    expect(next.deadlineKind).toBe("quota_reset");
    expect(next.quotaProvider).toBe("claude");
    const dl = new Date(next.deadline!);
    expect(dl.getUTCDay()).toBe(4);
    expect(dl.getUTCHours()).toBe(7);
    expect(dl.getTime()).toBeGreaterThan(Date.now());
    db.close();
  });

  it("quota_reset series without a quota config falls back to +7 d", async () => {
    const s = sched();
    const occ = await occurrence(s, "quota_reset", 6, {
      deadlineKind: "quota_reset",
      quotaProvider: "claude",
    });
    s.cancelTask(occ.taskId);
    const db = store();
    const next = db.get(`${occ.taskId}~2`)!;
    expect(Date.parse(next.deadline!)).toBe(Date.parse(occ.deadline!) + 7 * DAY);
    expect(next.deadlineKind).toBe("quota_reset");
    db.close();
  });

  it("a reply child never rolls", async () => {
    const s = sched();
    const occ = await occurrence(s, "weekly");
    s.runNow(occ.taskId);
    await s.tick({ anthropic: adapter() });
    const child = await s.replyToTask(occ.taskId, "more");
    expect(child.repeat ?? "none").toBe("none");
    s.runNow(child.taskId);
    await s.tick({ anthropic: adapter() });
    const db = store();
    expect(db.get(`${child.taskId}~2`)).toBeUndefined();
    db.close();
  });
});

describe("quota_reset series and the quota sweep", () => {
  it("the sweep re-resolves a successor once its reset passed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tidegap-series-sweep-"));
    const dbPath = join(dir, "queue.db");
    const quota: QuotaResetConfig = {
      claude: { label: "claude", weekday: 4, hour: 9, minute: 0, timeZone: "UTC", marginH: 2 },
    };
    try {
      const s = new Scheduler({ dbPath, feed: mockGridFeed(), signing: false, quotaConfig: () => quota });
      const occ = await s.enqueueProviderCall(SPEC, {
        deadline: new Date(Date.now() + 6 * H),
        region: "DE",
        repeat: "quota_reset",
        deadlineKind: "quota_reset",
        quotaProvider: "claude",
      });
      s.cancelTask(occ.taskId);
      const db = new TaskStore({ dbPath });
      const first = Date.parse(db.get(`${occ.taskId}~2`)!.deadline!);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(first + 3 * H)); // the reset (deadline + margin) passed
      await prepareTick(s, { quotaConfig: quota });
      const moved = Date.parse(db.get(`${occ.taskId}~2`)!.deadline!);
      expect(moved).toBe(first + 7 * DAY);
      db.close();
      s.shutdown();
    } finally {
      vi.useRealTimers();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
