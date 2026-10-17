/**
 * Earliest start on enqueue and reschedule (KTD6) and provider deferral
 * (KTD7): a provider throws ProviderDeferError and the task goes back to
 * `scheduled` with `notBefore = retryAt` instead of failing.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  mockGridFeed,
  prepareTick,
  ProviderDeferError,
  Scheduler,
  TaskActionError,
  TaskStore,
} from "../src/index.js";
import type { ProviderAdapter } from "../src/index.js";

const H = 3_600_000;
const MIN = 60_000;
const SPEC = {
  type: "provider_call" as const,
  provider: "anthropic" as const,
  model: "claude-sonnet-4-6",
  prompt: "Summarise the report",
};

function stub(behaviour: (call: number) => unknown): ProviderAdapter & { calls: number } {
  const a = {
    provider: "anthropic" as const,
    ready: true,
    calls: 0,
    async dispatch(model: string) {
      a.calls += 1;
      const out = behaviour(a.calls);
      if (out instanceof Error || (out && typeof out === "object" && "name" in out)) throw out;
      return { text: "ok", model, provider: "anthropic" as const, raw: null };
    },
  };
  return a;
}

describe("earliest start and deferral", () => {
  let dir: string;
  let dbPath: string;
  const open: Scheduler[] = [];

  function sched(): Scheduler {
    const s = new Scheduler({ dbPath, feed: mockGridFeed(), signing: false, rng: () => 0 });
    open.push(s);
    return s;
  }
  function raw(): TaskStore {
    return new TaskStore({ dbPath });
  }
  async function due(s: Scheduler, extra: Record<string, unknown> = {}) {
    const rec = await s.enqueueProviderCall(SPEC, {
      deadline: new Date(Date.now() + 6 * H),
      region: "DE",
      ...extra,
    });
    s.runNow(rec.taskId);
    return rec;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-defer-"));
    dbPath = join(dir, "queue.db");
  });
  afterEach(() => {
    vi.useRealTimers();
    for (const s of open.splice(0)) s.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  describe("enqueue with notBefore", () => {
    it("stores notBefore and schedules at or after it", async () => {
      const nb = new Date(Date.now() + 3 * H);
      const rec = await sched().enqueueProviderCall(SPEC, {
        deadline: new Date(Date.now() + 24 * H),
        region: "DE",
        notBefore: nb,
      });
      const row = raw().get(rec.taskId)!;
      expect(row.status).toBe("scheduled");
      expect(row.notBefore).toBe(nb.toISOString());
      expect(Date.parse(row.scheduledFor!)).toBeGreaterThan(nb.getTime());
      expect(row.estimatedCarbonGCo2).toBeDefined();
    });

    it("raises a deadline before notBefore to notBefore + 2 h", async () => {
      const nb = new Date(Date.now() + 10 * H);
      const rec = await sched().enqueueProviderCall(SPEC, {
        deadline: new Date(Date.now() + 2 * H),
        region: "DE",
        notBefore: nb,
      });
      expect(raw().get(rec.taskId)!.deadline).toBe(new Date(nb.getTime() + 2 * H).toISOString());
    });

    it("beyond the forecast horizon: unplanned at notBefore + 1 min, planned later by replanSweep", async () => {
      const nb = new Date(Date.now() + 5 * 24 * H);
      const rec = await sched().enqueueProviderCall(SPEC, {
        deadline: new Date(nb.getTime() + 24 * H),
        region: "DE",
        notBefore: nb,
      });
      const row = raw().get(rec.taskId)!;
      expect(row.estimatedCarbonGCo2).toBeUndefined();
      expect(row.scheduledFor).toBe(new Date(nb.getTime() + MIN).toISOString());
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(Date.now() + 4 * 24 * H));
      await prepareTick(sched(), { quotaConfig: {} });
      const planned = raw().get(rec.taskId)!;
      expect(planned.estimatedCarbonGCo2).toBeDefined();
      expect(Date.parse(planned.scheduledFor!)).toBeGreaterThan(nb.getTime());
    });
  });

  describe("reschedule {notBefore}", () => {
    it("moves a queued/scheduled task to after the start", async () => {
      const s = sched();
      const rec = await s.enqueueProviderCall(SPEC, { deadline: new Date(Date.now() + 6 * H), region: "DE" });
      const nb = new Date(Date.now() + 8 * H);
      const out = await sched().rescheduleTask(rec.taskId, { notBefore: nb.toISOString() });
      expect(out.notBefore).toBe(nb.toISOString());
      expect(Date.parse(out.scheduledFor!)).toBeGreaterThan(nb.getTime());
      expect(out.deadline).toBe(new Date(nb.getTime() + 2 * H).toISOString());
      expect(out.scheduledFor).not.toBe(out.notBefore);
    });

    it("an hour-aligned start inside the picked hour gives notBefore + 1 min, not an exact pin", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-17T10:20:00.000Z"));
      const s = sched();
      const rec = await s.enqueueProviderCall(SPEC, { deadline: new Date(Date.now() + 6 * H), region: "DE" });
      // The mock forecast rises through the day, so the start's own hour is the cleanest.
      const nb = new Date("2026-10-17T13:00:00.000Z");
      const out = await sched().rescheduleTask(rec.taskId, {
        notBefore: nb.toISOString(),
        deadline: new Date(nb.getTime() + 3 * H).toISOString(),
      });
      expect(out.estimatedCarbonGCo2).toBeDefined();
      expect(out.scheduledFor).toBe(new Date(nb.getTime() + MIN).toISOString());
      expect(out.scheduledFor).not.toBe(out.notBefore);
    });

    it("refuses a running task", async () => {
      const s = sched();
      const rec = await s.enqueueProviderCall(SPEC, { deadline: new Date(Date.now() + 6 * H), region: "DE" });
      const store = raw();
      store.claimScheduled(rec.taskId);
      await expect(
        sched().rescheduleTask(rec.taskId, { notBefore: new Date(Date.now() + H).toISOString() }),
      ).rejects.toBeInstanceOf(TaskActionError);
      store.close();
    });
  });

  describe("ProviderDeferError in a tick", () => {
    it("puts the task back as scheduled with notBefore = retryAt", async () => {
      const s = sched();
      const rec = await due(s, { repeat: "daily" });
      const retryAt = new Date(Date.now() + 2 * H);
      const a = stub(() => new ProviderDeferError("claude-code: usage limit, resets 18:00", retryAt));
      const res = await sched().tick({ anthropic: a });
      expect(a.calls).toBe(1);
      expect(res.deferred).toBe(1);
      expect(res.failed).toBe(0);
      expect(res.results[0]).toMatchObject({ status: "deferred", retryAt: retryAt.toISOString() });
      const store = raw();
      const row = store.get(rec.taskId)!;
      expect(row.status).toBe("scheduled");
      expect(row.notBefore).toBe(retryAt.toISOString());
      expect(row.scheduledFor).toBe(new Date(retryAt.getTime() + MIN).toISOString());
      expect(row.error).toBeUndefined();
      expect(row.estimatedCarbonGCo2).toBeUndefined();
      // The series did not roll.
      expect(store.list({}).length).toBe(1);
      store.close();
    });

    it("accepts a plain object from another module copy", async () => {
      const s = sched();
      const rec = await due(s);
      const retryAt = new Date(Date.now() + 2 * H);
      const a = stub(() => Object.assign(new Error("limit"), { name: "ProviderDeferError", retryAt }));
      const res = await sched().tick({ anthropic: a });
      expect(res.deferred).toBe(1);
      expect(raw().get(rec.taskId)!.notBefore).toBe(retryAt.toISOString());
    });

    it("fails past the 8-day cap", async () => {
      const s = sched();
      const rec = await due(s);
      const a = stub(() => new ProviderDeferError("claude-code: usage limit", new Date(Date.now() + 8 * 24 * H)));
      const res = await sched().tick({ anthropic: a });
      expect(res.failed).toBe(1);
      const row = raw().get(rec.taskId)!;
      expect(row.status).toBe("failed");
      expect(row.error).toMatch(/8-day cap/);
    });

    it("a cancel during the run wins", async () => {
      const s = sched();
      const rec = await due(s);
      const a = stub(() => {
        sched().cancelTask(rec.taskId);
        return new ProviderDeferError("limit", new Date(Date.now() + 2 * H));
      });
      await sched().tick({ anthropic: a });
      expect(raw().get(rec.taskId)!.status).toBe("cancelled");
    });

    it("is not dispatched before notBefore, and is after it", async () => {
      const s = sched();
      const rec = await due(s);
      const retryAt = new Date(Date.now() + 2 * H);
      let defer = true;
      const a = stub(() => (defer ? new ProviderDeferError("limit", retryAt) : undefined));
      await sched().tick({ anthropic: a });
      defer = false;
      await sched().tick({ anthropic: a });
      expect(a.calls).toBe(1);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(retryAt.getTime() + 2 * MIN));
      const res = await sched().tick({ anthropic: a });
      expect(a.calls).toBe(2);
      expect(res.dispatched).toBe(1);
      expect(raw().get(rec.taskId)!.status).toBe("completed");
    });

    it("replanSweep moves a deferred row to a planned hour at or after retryAt + 1 min", async () => {
      const s = sched();
      const rec = await due(s);
      const retryAt = new Date(Date.now() + 2 * H);
      await sched().tick({ anthropic: stub(() => new ProviderDeferError("limit", retryAt)) });
      await prepareTick(sched(), { quotaConfig: {} });
      const row = raw().get(rec.taskId)!;
      expect(row.estimatedCarbonGCo2).toBeDefined();
      expect(Date.parse(row.scheduledFor!)).toBeGreaterThanOrEqual(retryAt.getTime() + MIN);
    });

    it("after the first defer, other due tasks on the provider defer without a dispatch", async () => {
      const s = sched();
      const ids = [(await due(s)).taskId, (await due(s)).taskId, (await due(s)).taskId];
      const retryAt = new Date(Date.now() + 2 * H);
      const a = stub(() => new ProviderDeferError("limit", retryAt));
      const res = await sched().tick({ anthropic: a });
      expect(a.calls).toBe(1);
      expect(res.deferred).toBe(3);
      const store = raw();
      for (const id of ids) expect(store.get(id)!.notBefore).toBe(retryAt.toISOString());
      store.close();
    });

    it("a defer on one model does not hold back a due task on another model", async () => {
      const s = sched();
      const deferred = (await due(s)).taskId;
      const other = await s.enqueueProviderCall(
        { ...SPEC, model: "claude-opus-4-1" },
        { deadline: new Date(Date.now() + 6 * H), region: "DE" },
      );
      s.runNow(other.taskId);
      const retryAt = new Date(Date.now() + 2 * 24 * H);
      const models: string[] = [];
      const a: ProviderAdapter = {
        provider: "anthropic",
        ready: true,
        async dispatch(model: string) {
          models.push(model);
          if (model === SPEC.model) throw new ProviderDeferError("weekly model limit", retryAt);
          return { text: "ok", model, provider: "anthropic" as const, raw: null };
        },
      };
      const res = await sched().tick({ anthropic: a });
      expect(models.sort()).toEqual(["claude-opus-4-1", SPEC.model].sort());
      expect(res.deferred).toBe(1);
      const store = raw();
      expect(store.get(deferred)!.status).toBe("scheduled");
      expect(store.get(other.taskId)!.status).toBe("completed");
      store.close();
    });
  });
});
