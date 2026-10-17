/**
 * `GET /api/summary` and the next clean window (native clients U3, KTD5).
 * Time is injected (`ctx.now`); nothing reads the wall clock.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assessReadiness, TaskStore, type GridFeed, type GridForecastEntry, type TaskRecord } from "@tidegap/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FORECAST_CACHE_MS, handleApi, type ApiContext } from "../src/ui/api.js";
import { nextCleanWindow, type ForecastPoint } from "../src/ui/summary.js";

const H = 3_600_000;
const DAY = "2026-10-17T";
const at = (hh: number, mm = 0) => new Date(`${DAY}${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00.000Z`);

/** 24 hourly points from 00:00Z; `clean` hours get band clean, the rest average. */
function points(clean: number[], veryClean: number[] = []): ForecastPoint[] {
  return Array.from({ length: 24 }, (_, h) => ({
    t: at(h).toISOString(),
    g: veryClean.includes(h) ? 40 : clean.includes(h) ? 90 + h : 300 - h,
    band: veryClean.includes(h) ? "very_clean" : clean.includes(h) ? "clean" : "average",
  }));
}

describe("nextCleanWindow", () => {
  const forecast = points([14, 15, 16]);

  it("clean hours 14-16 at 10:00: window 14:00-17:00, not now", () => {
    expect(nextCleanWindow(forecast, at(10))).toEqual({
      start: at(14).toISOString(),
      end: at(17).toISOString(),
      band: "clean",
      g: 104,
      now: false,
      fallback: false,
    });
  });

  it("15:30 inside the run: the same window, now", () => {
    expect(nextCleanWindow(forecast, at(15, 30))).toMatchObject({ start: at(14).toISOString(), end: at(17).toISOString(), now: true });
  });

  it("a run ending exactly at now is skipped for the next run", () => {
    const two = points([2, 3, 14, 15]);
    expect(nextCleanWindow(two, at(4))).toMatchObject({ start: at(14).toISOString(), end: at(16).toISOString() });
    expect(nextCleanWindow(points([2, 3]), at(4))).toMatchObject({ fallback: true });
  });

  it("very_clean only when every hour is very clean", () => {
    expect(nextCleanWindow(points([], [5, 6]), at(0))).toMatchObject({ band: "very_clean", g: 40 });
    expect(nextCleanWindow(points([6], [5]), at(0))).toMatchObject({ band: "clean", end: at(7).toISOString() });
  });

  it("no clean hour: the cleanest hour after now, flagged fallback", () => {
    expect(nextCleanWindow(points([]), at(10))).toEqual({
      start: at(23).toISOString(),
      end: new Date(at(23).getTime() + H).toISOString(),
      band: "average",
      g: 277,
      now: false,
      fallback: true,
    });
  });

  it("a gap in the hours ends the run", () => {
    const gappy = points([14, 15, 16]).filter((p) => p.t !== at(15).toISOString());
    expect(nextCleanWindow(gappy, at(10))).toMatchObject({ start: at(14).toISOString(), end: at(15).toISOString() });
  });

  it("sweeping now over 24 hours: each answer contains now or starts after it, and never ends before it", () => {
    const fixed = points([3, 4, 14, 15, 16, 21]);
    for (let h = 0; h < 24; h++) {
      const now = at(h, 20);
      const w = nextCleanWindow(fixed, now);
      if (!w) continue;
      const [start, end] = [Date.parse(w.start), Date.parse(w.end)];
      expect([h, end > now.getTime()]).toEqual([h, true]);
      expect([h, w.now ? start <= now.getTime() : start > now.getTime() && start >= at(h).getTime()]).toEqual([h, true]);
    }
    expect(nextCleanWindow(fixed, at(23, 30))).toMatchObject({ fallback: true, now: true });
  });

  it("no hour after now: null", () => {
    expect(nextCleanWindow(points([1]), new Date(at(23).getTime() + H))).toBeNull();
  });
});

describe("GET /api/summary", () => {
  let dir: string;
  let store: TaskStore;
  let now: Date;
  let feedCalls: number;
  let failFeed: boolean;
  let ctx: ApiContext;

  const feed: GridFeed = {
    source: "mock",
    fetchForecast: async (region: string) => {
      feedCalls++;
      if (failFeed) throw new Error("https://api.example/?key=secret failed");
      const entries: GridForecastEntry[] = points([14, 15, 16]).map((p) => ({
        datetime: p.t,
        carbonIntensityGCo2PerKwh: p.g,
        band: p.band as GridForecastEntry["band"],
      }));
      return { region, source: "mock", generatedAt: at(0).toISOString(), entries } as never;
    },
  };

  const row = (id: string, extra: Partial<TaskRecord<unknown>>): TaskRecord<unknown> => ({
    taskId: id,
    status: "scheduled",
    enqueuedAt: at(0).toISOString(),
    region: "FR",
    title: `title ${id}`,
    bodyJson: JSON.stringify({ type: "provider_call", provider: "anthropic", model: "m", prompt: `p ${id}` }),
    ...extra,
  });

  const get = async (query = "") => {
    const res = await handleApi(ctx, "GET", "/api/summary", new URLSearchParams(query));
    return res as { status: number; body: Record<string, unknown> };
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-summary-"));
    store = new TaskStore({ dbPath: join(dir, "queue.db") });
    now = at(10);
    feedCalls = 0;
    failFeed = false;
    ctx = {
      store,
      dbPath: "x",
      feed,
      defaultRegion: "FR",
      quota: () => ({}),
      daemonStatus: () => "unknown",
      now: () => now,
    };
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("counts a seeded ledger: active 5, unread 1, and the next run", async () => {
    store.upsert(row("q1", { status: "queued" }));
    store.upsert(row("q2", { status: "queued" }));
    store.upsert(row("s1", { status: "scheduled", scheduledFor: at(13).toISOString() }));
    store.upsert(row("r1", { status: "running" }));
    store.upsert(row("u1", { status: "submitted" }));
    store.upsert(row("c1", { status: "completed", completedAt: at(9).toISOString() }));
    store.upsert(row("c2", { status: "completed", completedAt: at(8).toISOString() }));
    store.markRead("c2", at(9));
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.counts).toEqual({ queued: 2, scheduled: 1, running: 1, submitted: 1 });
    expect(body.active).toBe(5);
    expect(body.unread).toBe(1);
    expect(body.next_run).toEqual({ task_id: "s1", title: "title s1", scheduled_for: at(13).toISOString() });
    expect(body.clean_window).toMatchObject({ start: at(14).toISOString(), end: at(17).toISOString(), now: false });
    expect(body.forecast_ok).toBe(true);
    expect(body.region).toBe("FR");
  });

  it("a feed failure gives clean_window null and forecast_ok false, status 200, no error text", async () => {
    failFeed = true;
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.clean_window).toBeNull();
    expect(body.forecast_ok).toBe(false);
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  it("AE3: no since lists nothing; since=<cursor> lists a later finish once, then nothing", async () => {
    store.upsert(row("old", { status: "completed", completedAt: at(9).toISOString() }));
    const first = (await get()).body;
    expect(first).not.toHaveProperty("finished");
    expect(first.cursor).toBe(first.generated_at);
    now = at(10, 5);
    store.upsert(row("new", { status: "failed", completedAt: at(10, 2).toISOString() }));
    const second = (await get(`since=${first.cursor as string}`)).body;
    expect(second.finished).toEqual([{ task_id: "new", title: "title new", status: "failed", completed_at: at(10, 2).toISOString() }]);
    expect(second.cursor).toBe(at(10, 2).toISOString());
    const third = (await get(`since=${second.cursor as string}`)).body;
    expect(third.finished).toEqual([]);
    expect(third.cursor).toBe(second.cursor);
  });

  it("carries readiness from the context; the cursor rules do not change", async () => {
    expect((await get()).body).not.toHaveProperty("readiness");
    const readiness = assessReadiness({
      daemon: "loaded",
      lastTickAt: at(9, 58).toISOString(),
      runners: { providers: ["anthropic"], unknown: [], source: "snapshot" },
      pendingByProvider: { anthropic: 1 },
      now,
    });
    ctx.readiness = () => readiness;
    store.upsert(row("done", { status: "completed", completedAt: at(9, 59).toISOString() }));
    const first = (await get()).body;
    expect(first.readiness).toEqual(readiness);
    expect(first.readiness).toMatchObject({ ready: true, line: null, problems: [] });
    expect(first.cursor).toBe(first.generated_at);
    const since = (await get(`since=${at(9).toISOString()}`)).body;
    expect(since.readiness).toEqual(readiness);
    expect(since.cursor).toBe(at(9, 59).toISOString());
  });

  it("more than 20 finished since the cursor: the 20 oldest newest first, then the rest; none is skipped", async () => {
    const stamp = (i: number) => new Date(at(9).getTime() + i * 60_000).toISOString();
    for (let i = 0; i < 25; i++) store.upsert(row(`t${i}`, { status: "completed", completedAt: stamp(i) }));
    const ids = (b: Record<string, unknown>) => (b.finished as Array<{ task_id: string }>).map((t) => t.task_id);
    const first = (await get(`since=${at(8).toISOString()}`)).body;
    expect(ids(first)).toEqual(Array.from({ length: 20 }, (_, i) => `t${19 - i}`));
    expect(first.cursor).toBe(stamp(19));
    const second = (await get(`since=${first.cursor as string}`)).body;
    expect(ids(second)).toEqual(["t24", "t23", "t22", "t21", "t20"]);
    expect(second.cursor).toBe(stamp(24));
    const third = (await get(`since=${second.cursor as string}`)).body;
    expect(ids(third)).toEqual([]);
    expect(third.cursor).toBe(stamp(24));
  });

  it("over the cap, tasks that share the boundary completed_at are not split across polls", async () => {
    const stamp = (i: number) => new Date(at(9).getTime() + i * 60_000).toISOString();
    // t0..t18 distinct, then t19..t21 share one instant, then t22.
    for (let i = 0; i < 19; i++) store.upsert(row(`t${i}`, { status: "completed", completedAt: stamp(i) }));
    for (const id of ["t19", "t20", "t21"]) store.upsert(row(id, { status: "completed", completedAt: stamp(19) }));
    store.upsert(row("t22", { status: "completed", completedAt: stamp(22) }));
    const ids = (b: Record<string, unknown>) => (b.finished as Array<{ task_id: string }>).map((t) => t.task_id).sort();
    const first = (await get(`since=${at(8).toISOString()}`)).body;
    expect((first.finished as unknown[]).length).toBe(19);
    expect(first.cursor).toBe(stamp(18));
    const second = (await get(`since=${first.cursor as string}`)).body;
    expect(ids(second)).toEqual(["t19", "t20", "t21", "t22"]);
    expect(second.cursor).toBe(stamp(22));
  });

  it("more than the cap sharing the first instant are listed together", async () => {
    const t = at(9).toISOString();
    for (let i = 0; i < 22; i++) store.upsert(row(`s${i}`, { status: "completed", completedAt: t }));
    const first = (await get(`since=${at(8).toISOString()}`)).body;
    expect((first.finished as unknown[]).length).toBe(22);
    expect(first.cursor).toBe(t);
  });

  it("since=yesterday is 400", async () => {
    expect((await get("since=yesterday")).status).toBe(400);
  });

  it("two calls within FORECAST_CACHE_MS call the feed once, and share the forecast route's cache", async () => {
    await get();
    await get();
    await handleApi(ctx, "GET", "/api/forecast", new URLSearchParams("hours=24"));
    expect(feedCalls).toBe(1);
    now = new Date(now.getTime() + FORECAST_CACHE_MS);
    await get();
    expect(feedCalls).toBe(2);
  });

  it("POST is 405", async () => {
    expect((await handleApi(ctx, "POST", "/api/summary", new URLSearchParams())).status).toBe(405);
  });
});
