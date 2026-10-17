/**
 * "Later" (coherence U1, KTD4 to KTD6): `Scheduler.postponeTask` presets,
 * the never-earlier rule, the limit-reset precedence and `postponeOptions`.
 * Runs under fake `Date` in Europe/Kyiv, which ends DST on 2026-10-25.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LIMIT_RESET_HINT_META_KEY,
  mockGridFeed,
  postponeOptions,
  Scheduler,
  TaskActionError,
  TaskStore,
} from "../src/index.js";
import type { GridForecast, LimitResetSource, TaskRecord } from "../src/index.js";

const H = 3_600_000;
const SPEC = {
  type: "provider_call" as const,
  provider: "anthropic" as const,
  model: "claude-sonnet-4-6",
  prompt: "Summarize the changelog",
};

/** A local wall-clock instant in the test zone (Europe/Kyiv). */
function local(y: number, mo: number, d: number, h: number, mi = 0): Date {
  return new Date(y, mo - 1, d, h, mi, 0, 0);
}

function hhmm(iso: string | undefined): string {
  const d = new Date(iso!);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

describe("postponeTask (Later)", () => {
  let prevTz: string | undefined;
  let dir: string;
  let dbPath: string;
  const open: Scheduler[] = [];

  beforeAll(() => {
    prevTz = process.env.TZ;
    process.env.TZ = "Europe/Kyiv";
  });
  afterAll(() => {
    if (prevTz === undefined) delete process.env.TZ;
    else process.env.TZ = prevTz;
  });

  function sched(opts: { limitReset?: LimitResetSource; feed?: ReturnType<typeof mockGridFeed> } = {}): Scheduler {
    const s = new Scheduler({
      dbPath,
      feed: opts.feed ?? mockGridFeed(),
      signing: false,
      rng: () => 0,
      ...(opts.limitReset ? { limitReset: opts.limitReset } : {}),
    });
    open.push(s);
    return s;
  }

  function raw(): TaskStore {
    return new TaskStore({ dbPath });
  }

  /** A task pinned at `at` with a deadline `deadline`. */
  async function pinned(s: Scheduler, at: Date, deadline: Date, extra: Record<string, unknown> = {}) {
    const rec = await s.enqueueProviderCall(SPEC, { deadline, region: "DE", ...extra });
    await s.rescheduleTask(rec.taskId, { at });
    return rec.taskId;
  }

  function now(at: Date): void {
    vi.useFakeTimers({ now: at, toFake: ["Date"] });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-postpone-"));
    dbPath = join(dir, "queue.db");
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const s of open.splice(0)) s.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  it("+1h keeps a later Friday deadline; tonight lowers it to 06:00", async () => {
    now(local(2026, 10, 20, 12));
    const s = sched();
    const friday = local(2026, 10, 23, 12);
    const a = await pinned(s, local(2026, 10, 20, 15), friday);
    const b = await pinned(s, local(2026, 10, 20, 15), friday);

    await s.postponeTask(a, { preset: "1h" });
    const rowA = raw().get(a)!;
    expect(rowA.notBefore).toBe(local(2026, 10, 20, 16).toISOString());
    expect(rowA.deadline).toBe(friday.toISOString());
    expect(rowA.status).toBe("scheduled");

    await s.postponeTask(b, { preset: "tonight" });
    const rowB = raw().get(b)!;
    expect(rowB.notBefore).toBe(local(2026, 10, 20, 22).toISOString());
    expect(rowB.deadline).toBe(local(2026, 10, 21, 6).toISOString());
  });

  it("1h counts from the planned start: 23:00 at 21:00 moves to 00:00", async () => {
    now(local(2026, 10, 20, 21));
    const s = sched();
    const id = await pinned(s, local(2026, 10, 20, 23), local(2026, 10, 21, 0));
    await s.postponeTask(id, { preset: "1h" });
    const row = raw().get(id)!;
    expect(row.notBefore).toBe(local(2026, 10, 21, 0).toISOString());
    expect(Date.parse(row.deadline!)).toBeGreaterThanOrEqual(local(2026, 10, 21, 1).getTime());
    expect(Date.parse(row.scheduledFor!)).toBeGreaterThan(local(2026, 10, 21, 0).getTime());
  });

  it("a delay counts from the planned start too", async () => {
    now(local(2026, 10, 20, 10));
    const s = sched();
    const id = await pinned(s, local(2026, 10, 20, 12), local(2026, 10, 20, 18));
    await s.postponeTask(id, { delayMs: 2 * H });
    expect(raw().get(id)!.notBefore).toBe(local(2026, 10, 20, 14).toISOString());
  });

  it("tonight at 21:30 on a task at 21:45: not before 22:00, deadline 06:00", async () => {
    now(local(2026, 10, 20, 21, 30));
    const s = sched();
    const id = await pinned(s, local(2026, 10, 20, 21, 45), local(2026, 10, 20, 23));
    await s.postponeTask(id, { preset: "tonight" });
    const row = raw().get(id)!;
    expect(row.notBefore).toBe(local(2026, 10, 20, 22).toISOString());
    expect(row.deadline).toBe(local(2026, 10, 21, 6).toISOString());
    expect(Date.parse(row.scheduledFor!)).toBeGreaterThanOrEqual(local(2026, 10, 20, 22).getTime());
  });

  it("refuses tonight for a task already planned at 23:00 and names the time", async () => {
    now(local(2026, 10, 20, 12));
    const s = sched();
    const id = await pinned(s, local(2026, 10, 20, 23), local(2026, 10, 21, 3));
    const before = raw().get(id)!;
    await expect(s.postponeTask(id, { preset: "tonight" })).rejects.toThrow(/already planned for 23:00/);
    await expect(s.postponeTask(id, { until: local(2026, 10, 20, 22) })).rejects.toBeInstanceOf(TaskActionError);
    const after = raw().get(id)!;
    expect(after.scheduledFor).toBe(before.scheduledFor);
    expect(after.deadline).toBe(before.deadline);
  });

  it("tonight is unavailable at 05:30 (less than one hour left)", async () => {
    now(local(2026, 10, 21, 5, 30));
    const s = sched();
    const rec = await s.enqueueProviderCall(SPEC, { deadline: local(2026, 10, 21, 20), region: "DE" });
    const opts = postponeOptions(raw().get(rec.taskId)!, new Date(), null);
    const tonight = opts.find((o) => o.preset === "tonight")!;
    expect(tonight.available).toBe(false);
    expect(tonight.reason).toMatch(/less than one hour/);
    await expect(s.postponeTask(rec.taskId, { preset: "tonight" })).rejects.toThrow(/less than one hour/);
  });

  it("tonight after midnight runs until 06:00 the same morning", async () => {
    now(local(2026, 10, 21, 1));
    const s = sched();
    const rec = await s.enqueueProviderCall(SPEC, { deadline: local(2026, 10, 21, 1, 30), region: "DE" });
    await s.postponeTask(rec.taskId, { preset: "tonight" });
    expect(raw().get(rec.taskId)!.deadline).toBe(local(2026, 10, 21, 6).toISOString());
  });

  it("tomorrow morning is 09:00 local on both sides of the DST change", async () => {
    for (const day of [24, 25]) {
      now(local(2026, 10, day, 12));
      const s = sched();
      const rec = await s.enqueueProviderCall(SPEC, { deadline: local(2026, 10, day, 18), region: "DE" });
      await s.postponeTask(rec.taskId, { preset: "tomorrow_morning" });
      const row = raw().get(rec.taskId)!;
      expect(hhmm(row.notBefore)).toBe("09:00");
      expect(row.notBefore).toBe(local(2026, 10, day + 1, 9).toISOString());
      expect(hhmm(row.deadline)).toBe("12:00");
      vi.useRealTimers();
    }
    // Kyiv leaves UTC+3 at 04:00 on 2026-10-25: noon the day before is
    // 09:00Z, and the next morning's 09:00 is 07:00Z, not 06:00Z.
    expect(local(2026, 10, 24, 12).toISOString()).toBe("2026-10-24T09:00:00.000Z");
    expect(local(2026, 10, 25, 9).toISOString()).toBe("2026-10-25T07:00:00.000Z");
  });

  describe("after limit reset", () => {
    it("refuses without a source, a reset_at or a hint", async () => {
      now(local(2026, 10, 20, 12));
      const s = sched();
      const rec = await s.enqueueProviderCall(SPEC, { deadline: local(2026, 10, 20, 18), region: "DE" });
      await expect(s.postponeTask(rec.taskId, { preset: "after_limit_reset" })).rejects.toThrow(
        /needs the reset time/,
      );
    });

    it("reset_at 14:05 → not before 14:10, stored as the hint a second task uses", async () => {
      now(local(2026, 10, 20, 12));
      const s = sched();
      const a = await s.enqueueProviderCall(SPEC, { deadline: local(2026, 10, 20, 13), region: "DE" });
      const b = await s.enqueueProviderCall(SPEC, { deadline: local(2026, 10, 20, 13), region: "DE" });
      await s.postponeTask(a.taskId, { preset: "after_limit_reset", resetAt: local(2026, 10, 20, 14, 5) });
      const rowA = raw().get(a.taskId)!;
      expect(rowA.notBefore).toBe(local(2026, 10, 20, 14, 10).toISOString());
      expect(Date.parse(rowA.deadline!)).toBeGreaterThanOrEqual(local(2026, 10, 20, 15, 10).getTime());
      const hint = JSON.parse(raw().getMeta(LIMIT_RESET_HINT_META_KEY)!);
      expect(hint).toEqual({ at: local(2026, 10, 20, 14, 5).toISOString(), provider: "anthropic" });

      await sched().postponeTask(b.taskId, { preset: "after_limit_reset" });
      expect(raw().get(b.taskId)!.notBefore).toBe(local(2026, 10, 20, 14, 10).toISOString());
    });

    it("ignores a hint in the past", async () => {
      now(local(2026, 10, 20, 12));
      const s = sched();
      const rec = await s.enqueueProviderCall(SPEC, { deadline: local(2026, 10, 20, 18), region: "DE" });
      raw().setMeta(
        LIMIT_RESET_HINT_META_KEY,
        JSON.stringify({ at: local(2026, 10, 20, 11).toISOString(), provider: "anthropic" }),
      );
      await expect(s.postponeTask(rec.taskId, { preset: "after_limit_reset" })).rejects.toThrow(
        /needs the reset time/,
      );
    });

    it("a plugged-in source wins over the stored hint", async () => {
      now(local(2026, 10, 20, 12));
      raw().setMeta(
        LIMIT_RESET_HINT_META_KEY,
        JSON.stringify({ at: local(2026, 10, 20, 14, 5).toISOString(), provider: "anthropic" }),
      );
      const seen: string[] = [];
      const source: LimitResetSource = async (task: TaskRecord<unknown>) => {
        seen.push(task.taskId);
        return { at: local(2026, 10, 20, 13), source: "usage:five_hour" };
      };
      const s = sched({ limitReset: source });
      const rec = await s.enqueueProviderCall(SPEC, { deadline: local(2026, 10, 20, 12, 30), region: "DE" });
      await s.postponeTask(rec.taskId, { preset: "after_limit_reset" });
      expect(raw().get(rec.taskId)!.notBefore).toBe(local(2026, 10, 20, 13, 5).toISOString());
      expect(seen).toEqual([rec.taskId]);
    });

    it("a caller reset_at wins over the plugged-in source", async () => {
      now(local(2026, 10, 20, 12));
      const s = sched({ limitReset: () => ({ at: local(2026, 10, 20, 13), source: "usage:five_hour" }) });
      const rec = await s.enqueueProviderCall(SPEC, { deadline: local(2026, 10, 20, 12, 30), region: "DE" });
      await s.postponeTask(rec.taskId, { preset: "after_limit_reset", resetAt: local(2026, 10, 20, 15) });
      expect(raw().get(rec.taskId)!.notBefore).toBe(local(2026, 10, 20, 15, 5).toISOString());
    });

    it("refuses a reset_at in the past", async () => {
      now(local(2026, 10, 20, 12));
      const s = sched();
      const rec = await s.enqueueProviderCall(SPEC, { deadline: local(2026, 10, 20, 18), region: "DE" });
      await expect(
        s.postponeTask(rec.taskId, { preset: "after_limit_reset", resetAt: local(2026, 10, 20, 11) }),
      ).rejects.toThrow(/in the past/);
    });
  });

  it("until on a quota_reset task pins the exact time and makes it absolute", async () => {
    now(local(2026, 10, 20, 12));
    const s = sched();
    const rec = await s.enqueueProviderCall(SPEC, {
      deadline: local(2026, 10, 20, 18),
      region: "DE",
      deadlineKind: "quota_reset",
      quotaProvider: "claude",
    });
    const at = local(2026, 10, 21, 9, 30);
    await s.postponeTask(rec.taskId, { until: at });
    const row = raw().get(rec.taskId)!;
    expect(row.deadlineKind).toBe("absolute");
    expect(row.scheduledFor).toBe(at.toISOString());
    expect(row.notBefore).toBe(at.toISOString());
  });

  it("refuses a running task", async () => {
    now(local(2026, 10, 20, 12));
    const s = sched();
    const rec = await s.enqueueProviderCall(SPEC, { deadline: local(2026, 10, 20, 18), region: "DE" });
    expect(raw().claimScheduled(rec.taskId)).toBe(true);
    await expect(sched().postponeTask(rec.taskId, { preset: "1h" })).rejects.toBeInstanceOf(TaskActionError);
    expect(raw().get(rec.taskId)!.status).toBe("running");
  });

  it("a status change during planning (CAS miss) refuses and leaves the row as the other process wrote it", async () => {
    now(local(2026, 10, 20, 12));
    const s = sched();
    const rec = await s.enqueueProviderCall(SPEC, { deadline: local(2026, 10, 20, 18), region: "DE" });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inner = mockGridFeed();
    const gated = {
      ...inner,
      fetchForecast: async (region: string, hours: number): Promise<GridForecast> => {
        await gate;
        return inner.fetchForecast(region, hours);
      },
    } as ReturnType<typeof mockGridFeed>;
    const pending = sched({ feed: gated }).postponeTask(rec.taskId, { preset: "1h" });
    sched().cancelTask(rec.taskId);
    release();
    await expect(pending).rejects.toBeInstanceOf(TaskActionError);
    const row = raw().get(rec.taskId)!;
    expect(row.status).toBe("cancelled");
  });

  it("moves only the selected series occurrence", async () => {
    now(local(2026, 10, 20, 12));
    const s = sched();
    const rec = await s.enqueueProviderCall(SPEC, { deadline: local(2026, 10, 20, 18), region: "DE", repeat: "daily" });
    s.cancelTask(rec.taskId); // a skip: rolls the series to occurrence 2
    const successor = raw()
      .list()
      .find((r) => r.seriesId === rec.seriesId && r.taskId !== rec.taskId)!;
    const before = raw().get(successor.taskId)!;
    const third = await s.enqueueProviderCall(SPEC, { deadline: local(2026, 10, 20, 18), region: "DE", repeat: "daily" });
    await s.postponeTask(third.taskId, { preset: "1h" });
    const after = raw().get(successor.taskId)!;
    expect(after.scheduledFor).toBe(before.scheduledFor);
    expect(after.notBefore).toBe(before.notBefore);
    expect(after.deadline).toBe(before.deadline);
    // The moved occurrence's own successor does not exist yet.
    expect(raw().list().filter((r) => r.seriesId === third.seriesId)).toHaveLength(1);
  });

  describe("postponeOptions", () => {
    it("lists every preset with its resolved local time", async () => {
      now(local(2026, 10, 20, 12));
      const s = sched();
      const id = await pinned(s, local(2026, 10, 20, 15), local(2026, 10, 20, 18));
      const opts = postponeOptions(raw().get(id)!, new Date(), {
        at: local(2026, 10, 20, 16),
        source: "usage:five_hour",
      });
      expect(opts.map((o) => [o.preset, o.label, o.available, hhmm(o.not_before ?? undefined)])).toEqual([
        ["1h", "One hour later", true, "16:00"],
        ["tonight", "Tonight", true, "22:00"],
        ["tomorrow_morning", "Tomorrow morning", true, "09:00"],
        ["after_limit_reset", "After limit reset", true, "16:05"],
      ]);
    });

    it("marks after_limit_reset unavailable with a reason when no reset is known", async () => {
      now(local(2026, 10, 20, 12));
      const s = sched();
      const rec = await s.enqueueProviderCall(SPEC, { deadline: local(2026, 10, 20, 18), region: "DE" });
      const reset = postponeOptions(raw().get(rec.taskId)!, new Date(), null).find(
        (o) => o.preset === "after_limit_reset",
      )!;
      expect(reset).toMatchObject({ available: false, not_before: null, reason: "needs the reset time" });
      const viaScheduler = await s.postponeOptionsFor(rec.taskId);
      expect(viaScheduler.find((o) => o.preset === "after_limit_reset")!.available).toBe(false);
    });

    it("marks presets that would run earlier unavailable, and everything for a running task", async () => {
      now(local(2026, 10, 20, 12));
      const s = sched();
      const id = await pinned(s, local(2026, 10, 20, 23), local(2026, 10, 21, 3));
      const tonight = postponeOptions(raw().get(id)!, new Date(), null).find((o) => o.preset === "tonight")!;
      expect(tonight).toMatchObject({ available: false, reason: "already planned for 23:00" });
      const running = { ...raw().get(id)!, status: "running" as const };
      expect(postponeOptions(running, new Date(), null).every((o) => !o.available)).toBe(true);
    });
  });
});
