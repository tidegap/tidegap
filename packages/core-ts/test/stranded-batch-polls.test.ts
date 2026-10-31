/**
 * A stranded Batch poll is polled again (batch 27 U8, AE6). A tick killed
 * during a Batch poll leaves a plain row `running` with its batch id; the
 * next tick sends it back to `submitted` at the head of the Batch-poll sweep
 * once its deadline plus a 5-minute grace has passed, and polls it there.
 * `test/fixtures/stranded-batch-polls.json` holds the grace, the clock and the
 * rows; `packages/core-py/tests/test_stranded_batch_polls.py` runs the Python
 * core on the same file. Only `Date` is faked: no sleeps.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mockGridFeed, Scheduler, TaskStore } from "../src/index.js";
import type { ProviderAdapter, TaskStatus } from "../src/index.js";
import { STRANDED_POLL_GRACE_MS } from "../src/scheduler.js";

interface StrandedRow {
  task_id: string;
  batch_id: string | null;
  job_id: string | null;
  deadline: string;
  after: TaskStatus;
}

interface Fixture {
  grace_ms: number;
  now: string;
  rows: StrandedRow[];
  polled: string[];
}

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/stranded-batch-polls.json", import.meta.url), "utf8"),
) as Fixture;
const NOW = Date.parse(fixture.now);
const PAST = fixture.rows.find((r) => r.after === "completed")!;

/** A Batch row submitted two days before NOW. */
function insert(store: TaskStore, row: StrandedRow, status: TaskStatus = "running"): void {
  const enqueued = new Date(NOW - 2 * 24 * 60 * 60_000).toISOString();
  store.upsert({
    taskId: row.task_id,
    status,
    enqueuedAt: enqueued,
    scheduledFor: enqueued,
    region: "DE",
    bodyJson: JSON.stringify({ type: "provider_call", provider: "anthropic", model: "m", prompt: "hi" }),
    deadline: row.deadline,
    deadlineKind: "absolute",
    ...(row.batch_id ? { batchId: row.batch_id } : {}),
    ...(row.job_id ? { jobId: row.job_id } : {}),
  });
}

/** A Batch adapter whose poll returns the result `text`; with `stall`, each poll waits for `release()`. */
function pollAdapter(text: string, stall = false) {
  const polled: string[] = [];
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const inFlight = new Promise<void>((r) => (started = r));
  const adapter: ProviderAdapter = {
    provider: "anthropic",
    ready: true,
    async dispatch() {
      throw new Error("a stranded poll makes no sync call");
    },
    async dispatchBatch() {
      throw new Error("a stranded poll submits no batch");
    },
    async retrieveBatch(batchId) {
      polled.push(batchId);
      started();
      if (stall) await gate;
      return {
        status: "completed",
        results: [{ text, model: "m", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }],
      };
    },
  };
  return { adapter, polled, release, inFlight };
}

describe("a stranded Batch poll is polled again (shared fixture)", () => {
  let dir: string;
  let dbPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-stranded-"));
    dbPath = join(dir, "queue.sqlite");
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it("the grace matches the fixture", () => {
    expect(STRANDED_POLL_GRACE_MS).toBe(fixture.grace_ms);
  });

  it("one tick frees and polls only a plain row past its deadline and grace", async () => {
    const store = new TaskStore({ dbPath });
    const s = new Scheduler({ dbPath, feed: mockGridFeed(), signing: false });
    try {
      for (const row of fixture.rows) insert(store, row);
      const { adapter, polled } = pollAdapter("polled");
      const result = await s.tick({ anthropic: adapter });
      expect(Object.fromEntries(fixture.rows.map((r) => [r.task_id, store.get(r.task_id)!.status]))).toEqual(
        Object.fromEntries(fixture.rows.map((r) => [r.task_id, r.after])),
      );
      expect(polled).toEqual(fixture.polled);
      expect(result.results.map((e) => [e.taskId, e.status])).toEqual([[PAST.task_id, "completed"]]);
      const done = store.get(PAST.task_id)!;
      expect(done.receipt).toBeDefined();
      expect(done.batchId).toBe(PAST.batch_id);
      expect(store.listTaskEvents(PAST.task_id).map((e) => e.kind)).toEqual(["completed"]);
    } finally {
      store.close();
      s.shutdown();
    }
  });

  it("a row this scheduler's tick holds in a poll is not freed", async () => {
    const store = new TaskStore({ dbPath });
    const s = new Scheduler({ dbPath, feed: mockGridFeed(), signing: false });
    try {
      insert(store, PAST, "submitted");
      const { adapter, polled, release, inFlight } = pollAdapter("polled", true);
      const first = s.tick({ anthropic: adapter });
      await inFlight;
      // A second tick of the same scheduler while the first polls the row.
      const secondAdapter = pollAdapter("second");
      const second = await s.tick({ anthropic: secondAdapter.adapter });
      expect(second.results).toEqual([]);
      expect(secondAdapter.polled).toEqual([]);
      expect(store.get(PAST.task_id)!.status).toBe("running");
      release();
      await first;
      expect(polled).toEqual([PAST.batch_id]);
      expect(store.get(PAST.task_id)!.status).toBe("completed");
    } finally {
      store.close();
      s.shutdown();
    }
  });

  it("two pollers on a freed row land one completion", async () => {
    const store = new TaskStore({ dbPath });
    // Another process still polls the row past its deadline.
    const other = new Scheduler({ dbPath, feed: mockGridFeed(), signing: false });
    const s = new Scheduler({ dbPath, feed: mockGridFeed(), signing: false });
    try {
      insert(store, PAST, "submitted");
      const late = pollAdapter("late", true);
      const otherTick = other.tick({ anthropic: late.adapter });
      await late.inFlight;
      const result = await s.tick({ anthropic: pollAdapter("first").adapter });
      late.release();
      const otherResult = await otherTick;
      expect(result.results.map((e) => e.status)).toEqual(["completed"]);
      expect(otherResult.results.map((e) => e.status)).toEqual(["failed"]);
      expect(otherResult.results[0]!.error).toContain("result dropped");
      const row = store.get(PAST.task_id)!;
      expect(row.status).toBe("completed");
      expect((row.result as { text?: string }).text).toBe("first");
      expect(store.listTaskEvents(PAST.task_id).map((e) => e.kind)).toEqual(["completed"]);
    } finally {
      store.close();
      other.shutdown();
      s.shutdown();
    }
  });
});
