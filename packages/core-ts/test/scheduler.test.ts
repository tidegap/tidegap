import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CarbonBudgetExceededError,
  InvalidDeadlineError,
  JOB_INTERRUPTED_ERROR,
  mockGridFeed,
  pickBestWindow,
  Scheduler,
  TaskActionError,
  TaskStore,
  type ProviderAdapter,
  type TaskRecord,
} from "../src/index.js";
import { BATCH_SUBMIT_INTERRUPTED_ERROR } from "../src/jobs.js";

describe("mockGridFeed", () => {
  it("returns the requested number of hours", async () => {
    const feed = mockGridFeed();
    const forecast = await feed.fetchForecast("US-CAL-CISO", 12);
    expect(forecast.entries).toHaveLength(12);
    expect(forecast.source).toBe("mock");
  });

  it("produces an intraday low (overnight) and high (late afternoon)", async () => {
    const feed = mockGridFeed();
    const forecast = await feed.fetchForecast("US-CAL-CISO", 48);
    const values = forecast.entries.map((e) => e.carbonIntensityGCo2PerKwh);
    const min = Math.min(...values);
    const max = Math.max(...values);
    expect(max - min).toBeGreaterThan(50);
  });

  it("classifies carbon bands monotonically", async () => {
    const feed = mockGridFeed();
    const forecast = await feed.fetchForecast("FR", 6);
    for (const e of forecast.entries) {
      if (e.carbonIntensityGCo2PerKwh < 100) expect(e.band).toBe("very_clean");
      if (e.carbonIntensityGCo2PerKwh >= 700) expect(e.band).toBe("very_dirty");
    }
  });

  it("supports 72-hour horizon", async () => {
    const feed = mockGridFeed();
    const forecast = await feed.fetchForecast("US-MIDA-PJM", 72);
    expect(forecast.entries).toHaveLength(72);
  });
});

describe("pickBestWindow", () => {
  it("returns undefined when no entry falls within the deadline", () => {
    // 2h in the past: fully elapsed, not even the hour covering "now".
    const past = [
      {
        datetime: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        carbonIntensityGCo2PerKwh: 100,
        band: "clean" as const,
      },
    ];
    const result = pickBestWindow(past, new Date(Date.now() + 60 * 60 * 1000));
    expect(result).toBeUndefined();
  });

  it("accepts the entry covering the current hour (start up to 1h in the past)", () => {
    const entries = [
      {
        // Started 30 minutes ago — this is the hour containing "now".
        datetime: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
        carbonIntensityGCo2PerKwh: 50,
        band: "very_clean" as const,
      },
      {
        datetime: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        carbonIntensityGCo2PerKwh: 400,
        band: "average" as const,
      },
    ];
    const result = pickBestWindow(entries, new Date(Date.now() + 2 * 60 * 60 * 1000));
    expect(result?.carbonIntensityGCo2PerKwh).toBe(50);
  });

  it("picks the lowest-intensity entry inside the window", () => {
    const inOneHour = new Date(Date.now() + 60 * 60 * 1000);
    const inTwoHours = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const inThreeHours = new Date(Date.now() + 3 * 60 * 60 * 1000);
    const entries = [
      { datetime: inOneHour.toISOString(), carbonIntensityGCo2PerKwh: 400, band: "average" as const },
      { datetime: inTwoHours.toISOString(), carbonIntensityGCo2PerKwh: 120, band: "clean" as const },
      { datetime: inThreeHours.toISOString(), carbonIntensityGCo2PerKwh: 220, band: "clean" as const },
    ];
    const deadline = new Date(Date.now() + 4 * 60 * 60 * 1000);
    const result = pickBestWindow(entries, deadline);
    expect(result?.carbonIntensityGCo2PerKwh).toBe(120);
  });
});

describe("Scheduler.enqueue (synchronous accounting)", () => {
  it("creates a TaskRecord with status 'queued'", () => {
    const s = new Scheduler({ feed: mockGridFeed() });
    const record = s.enqueue(async () => "ok", {
      deadline: new Date(Date.now() + 60 * 60 * 1000),
      region: "US-CAL-CISO",
    });
    expect(record.status).toBe("queued");
    expect(record.region).toBe("US-CAL-CISO");
    expect(s.listTasks()).toHaveLength(1);
    s.shutdown();
  });

  it("uses the default region when none supplied", () => {
    const s = new Scheduler({ feed: mockGridFeed() });
    const record = s.enqueue(async () => "ok");
    expect(record.region).toBe("US-CAL-CISO");
    s.shutdown();
  });

  it("calls a defaultRegion getter on every enqueue", () => {
    let region = "GB";
    const s = new Scheduler({ feed: mockGridFeed(), defaultRegion: () => region });
    expect(s.enqueue(async () => "a").region).toBe("GB");
    region = "FR";
    expect(s.enqueue(async () => "b").region).toBe("FR");
    s.shutdown();
  });

  it("calls a defaultRegion getter on every provider-call enqueue and preview", async () => {
    let region = "GB";
    const s = new Scheduler({ feed: mockGridFeed(), defaultRegion: () => region });
    const spec = { type: "provider_call" as const, provider: "anthropic", model: "m", prompt: "hi" };
    const deadline = new Date(Date.now() + 24 * 60 * 60 * 1000);
    expect((await s.previewProviderCall(spec, { deadline })).region).toBe("GB");
    expect((await s.enqueueProviderCall(spec, { deadline })).region).toBe("GB");
    region = "FR";
    expect((await s.previewProviderCall(spec, { deadline })).region).toBe("FR");
    expect((await s.enqueueProviderCall(spec, { deadline })).region).toBe("FR");
    s.shutdown();
  });

  it("assigns a UUID-shaped id when no taskId supplied", () => {
    const s = new Scheduler({ feed: mockGridFeed() });
    const r1 = s.enqueue(async () => "a");
    const r2 = s.enqueue(async () => "b");
    expect(r1.taskId).not.toBe(r2.taskId);
    expect(r1.taskId).toMatch(/^t-[0-9a-f-]{36}$/);
    s.shutdown();
  });

  it("rejects empty caller-supplied taskId", () => {
    const s = new Scheduler({ feed: mockGridFeed() });
    expect(() => s.enqueue(async () => "x", { taskId: "" })).toThrow();
    s.shutdown();
  });

  it("rejects duplicate caller-supplied taskId", () => {
    const s = new Scheduler({ feed: mockGridFeed() });
    s.enqueue(async () => "a", { taskId: "user:foo" });
    expect(() => s.enqueue(async () => "b", { taskId: "user:foo" })).toThrow();
    s.shutdown();
  });
});

describe("Deadline validation", () => {
  it("rejects an unparseable deadline string", () => {
    const s = new Scheduler({ feed: mockGridFeed() });
    expect(() => s.enqueue(async () => "ok", { deadline: "not-a-date" })).toThrow(
      InvalidDeadlineError,
    );
    s.shutdown();
  });

  it("rejects a deadline already in the past", () => {
    const s = new Scheduler({ feed: mockGridFeed() });
    expect(() => s.enqueue(async () => "ok", { deadline: "2020-01-01T00:00:00Z" })).toThrow(
      InvalidDeadlineError,
    );
    s.shutdown();
  });
});

describe("Carbon budget enforcement", () => {
  it("rejects a task when no window meets the budget", async () => {
    const s = new Scheduler({ feed: mockGridFeed() });
    // Mock floor for US-MIDW-MISO is 460 → grams ~= 0.0015 * 460 = 0.69g
    // Set an impossibly tight budget of 0.1g.
    await expect(
      s.defer(async () => "should never run", {
        deadline: new Date(Date.now() + 200),
        region: "US-MIDW-MISO",
        carbonBudgetG: 0.1,
      }),
    ).rejects.toThrow(CarbonBudgetExceededError);
    s.shutdown();
  });
});

describe("Scheduler.defer (end-to-end with immediate deadline)", () => {
  it("dispatches and returns the task's result", async () => {
    const s = new Scheduler({ feed: mockGridFeed() });
    const result = await s.defer(async () => 42, {
      deadline: new Date(Date.now() + 200),
    });
    expect(result).toBe(42);
    const tasks = s.listTasks();
    expect(tasks[0]?.status).toBe("completed");
    expect(tasks[0]?.receipt?.estimatedCarbonGCo2).toBeGreaterThan(0);
    s.shutdown();
  });

  it("propagates errors from the task body", async () => {
    const s = new Scheduler({ feed: mockGridFeed() });
    await expect(
      s.defer(
        async () => {
          throw new Error("boom");
        },
        { deadline: new Date(Date.now() + 200) },
      ),
    ).rejects.toThrow("boom");
    s.shutdown();
  });
});

describe("Scheduler repeat and session fields (ui v2)", () => {
  const spec = {
    type: "provider_call" as const,
    provider: "anthropic" as const,
    model: "claude-sonnet-4-6",
    prompt: "check my weekly limits",
  };
  const deadline = () => new Date(Date.now() + 6 * 3_600_000);

  it("a quota_reset task does not repeat by default", async () => {
    const s = new Scheduler({ feed: mockGridFeed(), signing: false });
    const rec = await s.enqueueProviderCall(spec, {
      deadline: deadline(),
      deadlineKind: "quota_reset",
      quotaProvider: "claude",
    });
    expect(rec.repeat ?? "none").toBe("none");
    expect(rec.seriesId).toBeUndefined();
    s.shutdown();
  });

  it("repeat weekly is opt-in and the series id defaults to the task id", async () => {
    const s = new Scheduler({ feed: mockGridFeed(), signing: false });
    const rec = await s.enqueueProviderCall(spec, {
      deadline: deadline(),
      deadlineKind: "quota_reset",
      quotaProvider: "claude",
      repeat: "weekly",
      originSessionId: "3f2a0c1e-session",
    });
    expect(rec.repeat).toBe("weekly");
    expect(rec.seriesId).toBe(rec.taskId);
    expect(rec.originSessionId).toBe("3f2a0c1e-session");
    s.shutdown();
  });

  it("repeat none stores no series", async () => {
    const s = new Scheduler({ feed: mockGridFeed(), signing: false });
    const rec = await s.enqueueProviderCall(spec, { deadline: deadline(), repeat: "none" });
    expect(rec.repeat ?? "none").toBe("none");
    expect(rec.seriesId).toBeUndefined();
    s.shutdown();
  });

  it("repeat on a closure task throws", () => {
    const s = new Scheduler({ feed: mockGridFeed(), signing: false, eager: false });
    expect(() => s.enqueue(async () => 1, { deadline: deadline(), repeat: "daily" })).toThrow(
      /repeat/,
    );
    s.shutdown();
  });

  it("repeat quota_reset needs a quota_reset deadline", async () => {
    const s = new Scheduler({ feed: mockGridFeed(), signing: false });
    await expect(
      s.enqueueProviderCall(spec, { deadline: deadline(), repeat: "quota_reset" }),
    ).rejects.toThrow(/quota_reset/);
    s.shutdown();
  });

  it("an unknown repeat value throws", async () => {
    const s = new Scheduler({ feed: mockGridFeed(), signing: false });
    await expect(
      s.enqueueProviderCall(spec, {
        deadline: deadline(),
        repeat: "hourly" as unknown as "daily",
      }),
    ).rejects.toThrow(/repeat/);
    s.shutdown();
  });
});

describe("Scheduler.failHeldRuns: a forced tick stop (KTD12)", () => {
  let dir: string;
  let dbPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-held-"));
    dbPath = join(dir, "queue.sqlite");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** An adapter that answers at once, except for the prompt "slow": that call waits until `release()`. */
  function stallingAdapter() {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inFlight = new Promise<void>((r) => (started = r));
    const adapter: ProviderAdapter = {
      provider: "anthropic",
      ready: true,
      async dispatch(model, prompt) {
        if (prompt === "slow") {
          started();
          await gate;
        }
        return { text: "ok", model, provider: "anthropic", raw: null };
      },
    };
    return { adapter, release, inFlight };
  }

  async function due(s: Scheduler, prompt: string): Promise<string> {
    const rec = await s.enqueueProviderCall(
      { type: "provider_call", provider: "anthropic", model: "m", prompt },
      { deadline: new Date(Date.now() + 60 * 60_000), region: "US-CAL-CISO" },
    );
    s.runNow(rec.taskId);
    return rec.taskId;
  }

  it("fails the row whose call is in flight as interrupted; a settled row and a row not reached keep their status; a second call does nothing", async () => {
    const s = new Scheduler({ dbPath, feed: mockGridFeed(), signing: false });
    const store = new TaskStore({ dbPath });
    try {
      const fast = await due(s, "fast");
      const slow = await due(s, "slow");
      const later = await due(s, "later");
      const { adapter, release, inFlight } = stallingAdapter();
      const tick = s.tick({ anthropic: adapter });
      await inFlight;
      expect(s.failHeldRuns()).toEqual([slow]);
      expect(store.get(slow)).toMatchObject({ status: "failed", error: JOB_INTERRUPTED_ERROR });
      expect(store.listTaskEvents(slow).find((e) => e.kind === "failed")?.details).toMatchObject({ reason: "interrupted" });
      expect(store.get(fast)!.status).toBe("completed");
      expect(store.get(later)!.status).toBe("scheduled");
      const events = store.listTaskEvents(slow).length;
      expect(s.failHeldRuns()).toEqual([]);
      expect(store.listTaskEvents(slow)).toHaveLength(events);
      // The late answer does not overwrite the failed row.
      release();
      await tick;
      expect(store.get(slow)).toMatchObject({ status: "failed", error: JOB_INTERRUPTED_ERROR });
    } finally {
      store.close();
      s.shutdown();
    }
  });

  it("leaves a row another writer moved out of running first", async () => {
    const s = new Scheduler({ dbPath, feed: mockGridFeed(), signing: false });
    const store = new TaskStore({ dbPath });
    try {
      const slow = await due(s, "slow");
      const { adapter, release, inFlight } = stallingAdapter();
      const tick = s.tick({ anthropic: adapter });
      await inFlight;
      expect(store.transitionIf({ ...store.get(slow)!, status: "cancelled", completedAt: new Date().toISOString() }, ["running"])).toBe(true);
      expect(s.failHeldRuns()).toEqual([]);
      expect(store.get(slow)!.status).toBe("cancelled");
      release();
      await tick;
    } finally {
      store.close();
      s.shutdown();
    }
  });

  /**
   * A Batch-capable adapter for `provider`. The step named by `stall` waits
   * until `release()`: "submit" (dispatchBatch), "poll" (retrieveBatch) or
   * "call" (the sync dispatch). With `failSubmit`, dispatchBatch throws.
   */
  function stallingBatchAdapter(stall: "submit" | "poll" | "call", opts: { provider?: string; failSubmit?: boolean } = {}) {
    const provider = opts.provider ?? "anthropic";
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inFlight = new Promise<void>((r) => (started = r));
    const calls = { dispatch: 0, dispatchBatch: 0, retrieveBatch: 0 };
    const wait = async (step: string): Promise<void> => {
      if (step !== stall) return;
      started();
      await gate;
    };
    const adapter: ProviderAdapter = {
      provider,
      ready: true,
      async dispatch(model) {
        calls.dispatch++;
        await wait("call");
        return { text: "sync", model, provider, raw: null };
      },
      async dispatchBatch(_model, prompts) {
        calls.dispatchBatch++;
        if (opts.failSubmit) throw new Error("submit refused");
        await wait("submit");
        return { batchId: "batch-1", provider, size: prompts.length };
      },
      async retrieveBatch() {
        calls.retrieveBatch++;
        await wait("poll");
        return {
          status: "completed",
          results: [{ text: "batch-result", model: "m", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }],
        };
      },
    };
    return { adapter, release, inFlight, calls };
  }

  /** A row the Batch API takes: its deadline is over 24 h ahead. */
  async function batchRow(s: Scheduler): Promise<string> {
    const rec = await s.enqueueProviderCall(
      { type: "provider_call", provider: "anthropic", model: "m", prompt: "batch" },
      { deadline: new Date(Date.now() + 48 * 60 * 60_000), region: "US-CAL-CISO" },
    );
    return rec.taskId;
  }

  it("a Batch poll in flight goes back to submitted with its batch id; the next tick polls it once", async () => {
    const s = new Scheduler({ dbPath, feed: mockGridFeed(), signing: false });
    const store = new TaskStore({ dbPath });
    try {
      const id = await batchRow(s);
      const { adapter, release, inFlight, calls } = stallingBatchAdapter("poll");
      await s.tick({ anthropic: adapter });
      expect(store.get(id)).toMatchObject({ status: "submitted", batchId: "batch-1" });
      const tick = s.tick({ anthropic: adapter });
      await inFlight;
      expect(s.failHeldRuns()).toEqual([]);
      const row = store.get(id)!;
      expect(row).toMatchObject({ status: "submitted", batchId: "batch-1" });
      expect(row.completedAt).toBeUndefined();
      expect(row.error).toBeUndefined();
      expect(store.listTaskEvents(id).map((e) => e.kind)).not.toContain("failed");
      // The process exits here; the late answer of the stopped tick is dropped.
      release();
      await tick;
      expect(store.get(id)!.status).toBe("submitted");
      const polls = calls.retrieveBatch;
      await s.tick({ anthropic: adapter });
      expect(calls.retrieveBatch).toBe(polls + 1);
      expect(store.get(id)).toMatchObject({ status: "completed", batchId: "batch-1" });
      expect(calls.dispatch).toBe(0);
    } finally {
      store.close();
      s.shutdown();
    }
  });

  it("a repeating Batch row stopped during its poll gets one successor, when the next tick completes it", async () => {
    const s = new Scheduler({ dbPath, feed: mockGridFeed(), signing: false });
    const store = new TaskStore({ dbPath });
    try {
      const rec = await s.enqueueProviderCall(
        { type: "provider_call", provider: "anthropic", model: "m", prompt: "batch" },
        { deadline: new Date(Date.now() + 48 * 60 * 60_000), region: "US-CAL-CISO", repeat: "daily" },
      );
      const id = rec.taskId;
      const { adapter, release, inFlight } = stallingBatchAdapter("poll");
      await s.tick({ anthropic: adapter });
      const tick = s.tick({ anthropic: adapter });
      await inFlight;
      s.failHeldRuns();
      // The row is not finished, so the stop rolls no successor.
      expect(store.get(id)!.status).toBe("submitted");
      expect(store.get(`${id}~2`)).toBeUndefined();
      release();
      await tick;
      await s.tick({ anthropic: adapter });
      expect(store.get(id)!.status).toBe("completed");
      expect(store.get(`${id}~2`)!.status).toBe("scheduled");
      expect(store.get(`${id}~3`)).toBeUndefined();
    } finally {
      store.close();
      s.shutdown();
    }
  });

  it("a poll whose row another writer completed first keeps completed", async () => {
    const s = new Scheduler({ dbPath, feed: mockGridFeed(), signing: false });
    const store = new TaskStore({ dbPath });
    try {
      const id = await batchRow(s);
      const { adapter, release, inFlight } = stallingBatchAdapter("poll");
      await s.tick({ anthropic: adapter });
      const tick = s.tick({ anthropic: adapter });
      await inFlight;
      expect(store.transitionIf({ ...store.get(id)!, status: "completed", completedAt: new Date().toISOString() }, ["running"])).toBe(true);
      expect(s.failHeldRuns()).toEqual([]);
      expect(store.get(id)!.status).toBe("completed");
      release();
      await tick;
    } finally {
      store.close();
      s.shutdown();
    }
  });

  it("a Batch submit in flight fails with the Batch-submit error", async () => {
    const s = new Scheduler({ dbPath, feed: mockGridFeed(), signing: false });
    const store = new TaskStore({ dbPath });
    try {
      const id = await batchRow(s);
      const { adapter, release, inFlight } = stallingBatchAdapter("submit");
      const tick = s.tick({ anthropic: adapter });
      await inFlight;
      expect(s.failHeldRuns()).toEqual([id]);
      expect(store.get(id)).toMatchObject({ status: "failed", error: BATCH_SUBMIT_INTERRUPTED_ERROR });
      expect(store.get(id)!.batchId).toBeUndefined();
      expect(store.listTaskEvents(id).find((e) => e.kind === "failed")?.details).toMatchObject({ reason: "interrupted", phase: "batch_submit" });
      release();
      await tick;
      expect(store.get(id)).toMatchObject({ status: "failed", error: BATCH_SUBMIT_INTERRUPTED_ERROR });
    } finally {
      store.close();
      s.shutdown();
    }
  });

  it("a routed submit that fell back to a provider call fails as interrupted", async () => {
    const s = new Scheduler({ dbPath, feed: mockGridFeed(), signing: false });
    const store = new TaskStore({ dbPath });
    try {
      // cost=1 and a deadline over 24 h: the cheaper Batch candidate wins.
      const rec = await s.enqueueProviderCall(
        {
          type: "provider_call",
          provider: "openai",
          model: "gpt-4o",
          prompt: "batch-me",
          candidates: ["anthropic:claude-sonnet-4", "openai:gpt-4o"],
          routeWeights: { carbon: 0, cost: 1, latency: 0 },
        },
        { deadline: new Date(Date.now() + 60 * 60 * 60_000), region: "US-CAL-CISO" },
      );
      expect(rec.routingDecision?.chosen).toBe("openai:gpt-4o");
      const { adapter, release, inFlight, calls } = stallingBatchAdapter("call", { provider: "openai", failSubmit: true });
      const tick = s.tick({ openai: adapter });
      await inFlight;
      expect(calls.dispatchBatch).toBe(1);
      expect(s.failHeldRuns()).toEqual([rec.taskId]);
      expect(store.get(rec.taskId)).toMatchObject({ status: "failed", error: JOB_INTERRUPTED_ERROR });
      expect(store.listTaskEvents(rec.taskId).find((e) => e.kind === "failed")?.details).not.toHaveProperty("phase");
      release();
      await tick;
    } finally {
      store.close();
      s.shutdown();
    }
  });

  describe("a row failed during a Batch submit", () => {
    const fixture = JSON.parse(
      readFileSync(new URL("./fixtures/interrupted-batch-submit.json", import.meta.url), "utf8"),
    ) as { error: string; row: Record<string, string> };

    it("the Batch-submit error equals the shared fixture text", () => {
      expect(BATCH_SUBMIT_INTERRUPTED_ERROR).toBe(fixture.error);
    });

    it("retryTask refuses it, a job run too, with the Batch-submit reason", async () => {
      const s = new Scheduler({ dbPath, feed: mockGridFeed(), signing: false });
      const store = new TaskStore({ dbPath });
      try {
        const r = fixture.row;
        const row: TaskRecord<unknown> = {
          taskId: r.task_id!,
          status: "failed",
          enqueuedAt: r.enqueued_at!,
          completedAt: r.completed_at,
          region: r.region!,
          bodyJson: r.body_json,
          deadline: r.deadline,
          error: r.error,
        };
        store.upsert(row);
        store.upsert({ ...row, taskId: "job-0000001a~1", jobId: "job-0000001a" });
        const { adapter, calls } = stallingBatchAdapter("submit");
        for (const id of [row.taskId, "job-0000001a~1"]) {
          const before = store.get(id);
          const err = (await s.retryTask(id, { anthropic: adapter }).catch((e: unknown) => e)) as Error;
          expect(err).toBeInstanceOf(TaskActionError);
          expect(err.message).toContain("check the provider's batch list");
          expect(err.message).not.toContain("retries failed runs itself");
          expect(store.get(id)).toEqual(before);
        }
        expect(calls).toEqual({ dispatch: 0, dispatchBatch: 0, retrieveBatch: 0 });
      } finally {
        store.close();
        s.shutdown();
      }
    });
  });

  it("leaves a running row it never dispatched (stranded by an earlier crash)", async () => {
    const store = new TaskStore({ dbPath });
    const s = new Scheduler({ dbPath, feed: mockGridFeed(), signing: false });
    try {
      store.upsert({ taskId: "stranded", status: "running", enqueuedAt: new Date().toISOString(), region: "US-CAL-CISO" });
      const slow = await due(s, "slow");
      const { adapter, release, inFlight } = stallingAdapter();
      const tick = s.tick({ anthropic: adapter });
      await inFlight;
      expect(s.failHeldRuns()).toEqual([slow]);
      expect(store.get("stranded")!.status).toBe("running");
      release();
      await tick;
    } finally {
      store.close();
      s.shutdown();
    }
  });
});
