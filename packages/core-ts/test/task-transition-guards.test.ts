/**
 * The Node side of the shared compare-and-set fixture (batch 27 KTD8).
 * `test/fixtures/task-transition-guards.json` lists the statuses each task
 * write accepts; this file drives the Node writes through the public API,
 * and `packages/core-py/tests/test_task_transitions.py` drives the Python
 * twins with the same file.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mockGridFeed, Scheduler, TaskStore } from "../src/index.js";
import type { CarbonReceipt, GridFeed, ProviderAdapter, RoutingDecision, TaskRecord, TaskStatus } from "../src/index.js";
import { PENDING_STATUSES, UNFINISHED_STATUSES } from "../src/scheduler.js";

interface DispatchRace {
  call: "succeeds" | "fails" | "submit" | "poll" | "routed_fallback";
  other_writer: "completed" | "cancelled";
  after: TaskStatus;
}

interface Fixture {
  statuses: TaskStatus[];
  pending: TaskStatus[];
  unfinished: TaskStatus[];
  actions: Record<string, { node: string; python: string; accepts: TaskStatus[] }>;
  writes: Record<string, { what: string; accepts: TaskStatus[] }>;
  dispatch_races: DispatchRace[];
}

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/task-transition-guards.json", import.meta.url), "utf8"),
) as Fixture;

const TASK = "tt:row";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const iso = (deltaMs = 0): string => new Date(Date.now() + deltaMs).toISOString();

/** A provider-call row in `status`, due now, with a deadline 3 h out (over 24 h makes it a Batch row). */
function row(status: TaskStatus, deadlineMs = 3 * HOUR, batchId?: string): TaskRecord<unknown> {
  const terminal = status === "completed" || status === "failed" || status === "cancelled";
  return {
    taskId: TASK,
    status,
    enqueuedAt: iso(-10 * MINUTE),
    scheduledFor: iso(-MINUTE),
    region: "DE",
    bodyJson: JSON.stringify({ type: "provider_call", provider: "anthropic", model: "m", prompt: "hi" }),
    deadline: iso(deadlineMs),
    deadlineKind: "absolute",
    ...(batchId ? { batchId } : {}),
    ...(terminal ? { completedAt: iso(-MINUTE) } : {}),
    ...(status === "failed" ? { error: "boom" } : {}),
  };
}

function recordingAdapter(): { adapter: ProviderAdapter; calls: string[] } {
  const calls: string[] = [];
  const adapter: ProviderAdapter = {
    provider: "anthropic",
    ready: true,
    async dispatch(model, prompt) {
      calls.push(prompt);
      return { text: "ours", model, provider: "anthropic", raw: null };
    },
  };
  return { adapter, calls };
}

async function act(s: Scheduler, action: string, adapter: ProviderAdapter): Promise<void> {
  if (action === "cancel") {
    s.cancelTask(TASK);
  } else if (action === "expedite") {
    await s.expediteTask(TASK, { anthropic: adapter });
  } else if (action === "update_deadline") {
    await s.updateDeadline(TASK, new Date(Date.now() + 5 * HOUR));
  } else if (action === "retry") {
    await s.retryTask(TASK, { anthropic: adapter });
  } else {
    throw new Error(`unknown action ${action}`);
  }
}

describe("compare-and-set: the statuses each user action writes (shared fixture)", () => {
  let dir: string;
  let dbPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-guards-"));
    dbPath = join(dir, "queue.sqlite");
    // cancelTask warns about a submitted row's live batch.
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("names the four actions of both cores", () => {
    expect(Object.values(fixture.actions).map((a) => a.node).sort()).toEqual(
      ["cancelTask", "expediteTask", "retryTask", "updateDeadline"],
    );
  });

  for (const [action, spec] of Object.entries(fixture.actions)) {
    for (const status of fixture.statuses) {
      const accepted = spec.accepts.includes(status);
      it(`${spec.node} on a ${status} row ${accepted ? "writes it" : "writes nothing"}`, async () => {
        const store = new TaskStore({ dbPath });
        // A fresh process: nothing cached, the row comes from the ledger.
        const s = new Scheduler({ dbPath, feed: mockGridFeed(), signing: false });
        try {
          store.upsert(row(status));
          const before = store.get(TASK)!;
          const { adapter, calls } = recordingAdapter();
          let raised = false;
          try {
            await act(s, action, adapter);
          } catch {
            raised = true;
          }
          const after = store.get(TASK)!;
          if (action === "cancel") {
            // A cancel of a finished row returns it unchanged.
            expect(raised).toBe(false);
            expect(after.status).toBe(accepted ? "cancelled" : status);
            return;
          }
          expect(raised).toBe(!accepted);
          if (!accepted) {
            expect(after.status).toBe(status);
            expect(after.deadline).toBe(before.deadline);
            expect(calls).toEqual([]);
          } else if (action === "update_deadline") {
            expect(after.status).toBe("scheduled");
            expect(after.deadline).not.toBe(before.deadline);
          } else {
            expect(calls).toEqual(["hi"]);
            expect(after.status).toBe("completed");
          }
        } finally {
          store.close();
          s.shutdown();
        }
      });
    }
  }
});

const FIRST_RECEIPT: CarbonReceipt = {
  taskId: TASK,
  ranAt: "2026-11-02T10:00:00.000Z",
  region: "DE",
  estimatedCarbonGCo2: 1.5,
  actualCarbonGCo2: 1.25,
  deltaPct: -16.7,
};

/**
 * A Batch-capable adapter: while the call named by `race.call` is in flight,
 * another process (its own ledger handle) moves the row from `running` to
 * `race.other_writer`.
 */
function racingAdapter(other: TaskStore, race: DispatchRace): ProviderAdapter {
  const otherProcess = (): void => {
    const current = other.get(TASK)!;
    const next: TaskRecord<unknown> =
      race.other_writer === "completed"
        ? { ...current, status: "completed", completedAt: iso(), result: "theirs", receipt: FIRST_RECEIPT }
        : { ...current, status: "cancelled", completedAt: iso() };
    expect(other.transitionIf(next, ["running"], undefined, { kind: race.other_writer })).toBe(true);
  };
  return {
    provider: "anthropic",
    ready: true,
    async dispatch(model) {
      otherProcess();
      if (race.call === "fails") throw new Error("provider refused the call");
      return { text: "ours", model, provider: "anthropic", raw: null };
    },
    async dispatchBatch(_model, prompts) {
      otherProcess();
      if (race.call === "routed_fallback") throw new Error("batch endpoint rejected the request");
      return { batchId: "batch-ours", provider: "anthropic", size: prompts.length };
    },
    async retrieveBatch() {
      otherProcess();
      return {
        status: "completed",
        results: [{ text: "ours", model: "m", usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } }],
      };
    },
  };
}

/** A routed row with one candidate: a failed Batch submit falls back to a sync call. */
const ROUTING: RoutingDecision = {
  weights: { carbon: 1, cost: 0, latency: 0 },
  considered: [{ provider: "anthropic", model: "m", estCarbonG: 1, estCostUsd: 0, latencyClass: 1, score: 1 }],
  chosen: "anthropic:m",
  reasoning: "one candidate",
};

describe("compare-and-set: a dispatch result never overwrites another process write (shared fixture)", () => {
  let dir: string;
  let dbPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-guards-"));
    dbPath = join(dir, "queue.sqlite");
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  for (const race of fixture.dispatch_races) {
    it(`a ${race.call} call while another process writes ${race.other_writer} leaves the row ${race.after}`, async () => {
      const store = new TaskStore({ dbPath });
      const other = new TaskStore({ dbPath });
      const s = new Scheduler({ dbPath, feed: mockGridFeed(), signing: false });
      try {
        if (race.call === "poll") store.upsert(row("submitted", 48 * HOUR, "batch-theirs"));
        else if (race.call === "routed_fallback") store.upsert({ ...row("scheduled", 48 * HOUR), routingDecision: ROUTING });
        else store.upsert(row("scheduled", race.call === "submit" ? 48 * HOUR : 3 * HOUR));
        const result = await s.tick({ anthropic: racingAdapter(other, race) });
        const after = store.get(TASK)!;
        expect(after.status).toBe(race.after);
        const kinds = store.listTaskEvents(TASK).map((e) => e.kind);
        expect(kinds).not.toContain("failed");
        if (race.after === "completed") {
          expect(after.result).toBe("theirs");
          expect(after.receipt).toEqual(FIRST_RECEIPT);
          expect(kinds.filter((k) => k === "completed")).toHaveLength(1);
        }
        if (race.call === "submit") expect(after.batchId).toBeUndefined();
        expect(result.results.map((e) => e.status)).toEqual(["failed"]);
        if (race.call === "submit") expect(result.results[0]!.error).toContain("batch batch-ours is not stored");
        // The sync call after the failed submit is never made.
        if (race.call === "routed_fallback") expect(result.results[0]!.error).toContain("before dispatch; not sent");
      } finally {
        store.close();
        other.close();
        s.shutdown();
      }
    });
  }
});

describe("compare-and-set: the write sets match the shared fixture", () => {
  it("the pending and unfinished sets are the fixture's, and each write lists one of them", () => {
    expect([...PENDING_STATUSES]).toEqual(fixture.pending);
    expect([...UNFINISHED_STATUSES]).toEqual(fixture.unfinished);
    expect(Object.fromEntries(Object.entries(fixture.writes).map(([name, w]) => [name, w.accepts]))).toEqual({
      schedule: fixture.pending,
      closure_dispatch: fixture.pending,
      pre_call: ["running", "scheduled"],
      result: ["running"],
      fail_while_planning: fixture.pending,
      fail: fixture.unfinished,
    });
  });
});

describe("compare-and-set: a closure write that misses rejects its awaiter", () => {
  // A fixed instant at a UTC quarter hour, with the clean hour ahead: the
  // window is in the future, so the schedule write runs after the forecast.
  const NOW = Date.parse("2026-11-02T10:07:30.000Z");
  const hour = (h: number): string => new Date(Date.UTC(2026, 10, 2, h)).toISOString();
  let dir: string;
  let dbPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-closure-"));
    dbPath = join(dir, "queue.sqlite");
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A forecast with the clean hour next; `hook` runs once inside the first fetch. */
  function hookedFeed(hook: () => void): GridFeed {
    let pending: (() => void) | undefined = hook;
    return {
      source: "mock",
      async fetchForecast(region) {
        const run = pending;
        pending = undefined;
        run?.();
        const entry = (h: number, g: number) => ({ datetime: hour(h), carbonIntensityGCo2PerKwh: g, band: "average" as const });
        return { region, source: "mock", generatedAt: new Date().toISOString(), entries: [entry(10, 900), entry(11, 50), entry(12, 900)] };
      },
    };
  }

  for (const [name, budget] of [["the schedule write", undefined], ["the budget failure", 0.000001]] as const) {
    it(`${name} after another process cancelled the row rejects the awaiter`, async () => {
      const other = new TaskStore({ dbPath });
      const s = new Scheduler({
        dbPath,
        signing: false,
        feed: hookedFeed(() => {
          const current = other.get(TASK)!;
          expect(other.transitionIf({ ...current, status: "cancelled", completedAt: iso() }, ["queued"], undefined, { kind: "cancelled" })).toBe(true);
        }),
      });
      try {
        const ran: number[] = [];
        const awaiter = s.defer(() => ran.push(1), {
          taskId: TASK,
          deadline: new Date(NOW + 3 * HOUR),
          ...(budget === undefined ? {} : { carbonBudgetG: budget }),
        });
        await expect(awaiter).rejects.toThrow(`task ${TASK} cancelled`);
        expect(ran).toEqual([]);
        expect(other.get(TASK)!.status).toBe("cancelled");
        expect(other.listTaskEvents(TASK).map((e) => e.kind)).toEqual(["created", "cancelled"]);
      } finally {
        other.close();
        s.shutdown();
      }
    });
  }
});

describe("compare-and-set: enqueueProviderCall inserts once", () => {
  let dir: string;
  let dbPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-enqueue-"));
    dbPath = join(dir, "queue.sqlite");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("never overwrites a row another process inserted after the duplicate check", async () => {
    const store = new TaskStore({ dbPath });
    const s = new Scheduler({ dbPath, feed: mockGridFeed(), signing: false });
    try {
      store.upsert(row("running"));
      // The duplicate check reads before the other process's insert lands.
      vi.spyOn(TaskStore.prototype, "get").mockReturnValueOnce(undefined);
      await expect(
        s.enqueueProviderCall(
          { type: "provider_call", provider: "anthropic", model: "m", prompt: "again" },
          { taskId: TASK, deadline: new Date(Date.now() + 3 * HOUR) },
        ),
      ).rejects.toThrow("already in the queue");
      expect(store.get(TASK)!.status).toBe("running");
      expect(s.getTask(TASK)!.status).toBe("running");
    } finally {
      store.close();
      s.shutdown();
    }
  });
});
