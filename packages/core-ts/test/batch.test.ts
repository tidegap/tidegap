/**
 * Batch API routing tests (audit §0.1 + P1), through PUBLIC paths only.
 *
 * The audit flagged that the Batch API was previously unreachable from
 * any public entry point and only ever exercised by hand-forging
 * unreachable states. These tests drive the real enqueueProviderCall →
 * tick submit → tick poll → complete flow with a fake batch-capable
 * adapter.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockGridFeed, Scheduler } from "../src/index.js";

/**
 * The cross-language raw-row test writes the PY schema with the
 * node:sqlite builtin directly (no better-sqlite3 fallback like the
 * core's own store has). node:sqlite ships in Node >= 22.5, but CI's
 * Node 20 matrix leg lacks it — skip there; the Node 22 leg and the
 * Python suite keep the cross-language handoff covered.
 */
const nodeSqliteAvailable = (() => {
  try {
    createRequire(import.meta.url)("node:sqlite");
    return true;
  } catch {
    return false;
  }
})();
import type {
  BatchRetrieveResult,
  ProviderAdapter,
} from "../src/providers/base.js";

interface BatchAdapter extends ProviderAdapter {
  dispatchCalls: Array<{ model: string; prompt: string }>;
  dispatchBatchCalls: Array<{ model: string; prompts: string[] }>;
  retrieveCalls: string[];
  retrieveSequence: BatchRetrieveResult["status"][];
  retrieveUsage: { inputTokens: number; outputTokens: number };
  retrieveStopReason?: string;
}

function makeBatchAdapter(
  provider: "anthropic" | "openai" = "anthropic",
): BatchAdapter {
  const adapter: BatchAdapter = {
    provider,
    ready: true,
    dispatchCalls: [],
    dispatchBatchCalls: [],
    retrieveCalls: [],
    retrieveSequence: ["completed"],
    retrieveUsage: { inputTokens: 10, outputTokens: 5 },
    async dispatch(model, prompt) {
      adapter.dispatchCalls.push({ model, prompt });
      return {
        text: `sync:${prompt}`,
        model,
        provider,
        raw: null,
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      };
    },
    async dispatchBatch(model, prompts) {
      adapter.dispatchBatchCalls.push({ model, prompts });
      return { batchId: "batch-xyz", provider, size: prompts.length };
    },
    async retrieveBatch(batchId) {
      adapter.retrieveCalls.push(batchId);
      const status = adapter.retrieveSequence.shift() ?? "completed";
      if (status === "in_progress") return { status: "in_progress" };
      if (status === "failed" || status === "expired") {
        return { status, error: `batch ${status}` };
      }
      const { inputTokens, outputTokens } = adapter.retrieveUsage;
      return {
        status: "completed",
        results: [
          {
            text: "batch-result",
            model: "m",
            stopReason: adapter.retrieveStopReason,
            usage: {
              inputTokens,
              outputTokens,
              totalTokens: inputTokens + outputTokens,
            },
          },
        ],
      };
    },
  };
  return adapter;
}

/** Sync-only adapter (no dispatchBatch/retrieveBatch). */
function makeSyncOnlyAdapter(): ProviderAdapter {
  const calls: Array<{ model: string; prompt: string }> = [];
  return {
    provider: "anthropic",
    ready: true,
    // exposed for assertion
    dispatchCalls: calls,
    async dispatch(model: string, prompt: string) {
      calls.push({ model, prompt });
      return { text: "sync", model, provider: "anthropic", raw: null };
    },
    // dispatchBatch present but no retrieveBatch → not batch-capable per the
    // scheduler's `typeof adapter.dispatchBatch === "function"` gate? The
    // gate keys off dispatchBatch; to force the sync path we omit it.
  } as unknown as ProviderAdapter & {
    dispatchCalls: Array<{ model: string; prompt: string }>;
  };
}

function deadline(hours: number): Date {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

describe("Batch API routing (§0.1)", () => {
  it("submits → in_progress → completes across three ticks with real usage", async () => {
    const s = new Scheduler({ feed: mockGridFeed() });
    const adapter = makeBatchAdapter();
    adapter.retrieveSequence = ["in_progress", "completed"];
    const rec = await s.enqueueProviderCall(
      {
        type: "provider_call",
        provider: "anthropic",
        model: "m",
        prompt: "hello",
      },
      { deadline: deadline(60), region: "US-CAL-CISO", taskId: "bt-1" },
    );
    expect(s.getTask(rec.taskId)?.status).toBe("scheduled");

    // Tick 1: submit.
    const r1 = await s.tick({ anthropic: adapter });
    expect(r1.batchSubmitted).toBe(1);
    expect(adapter.dispatchBatchCalls).toHaveLength(1);
    expect(adapter.dispatchCalls).toHaveLength(0);
    const afterSubmit = s.getTask(rec.taskId);
    expect(afterSubmit?.status).toBe("submitted");
    expect(afterSubmit?.batchId).toBe("batch-xyz");

    // Tick 2: retrieve → in_progress, stays submitted.
    const r2 = await s.tick({ anthropic: adapter });
    expect(r2.batchPolled).toBe(1);
    expect(r2.dispatched).toBe(0);
    expect(s.getTask(rec.taskId)?.status).toBe("submitted");

    // Tick 3: retrieve → completed with usage {10,5}.
    const r3 = await s.tick({ anthropic: adapter });
    expect(r3.dispatched).toBe(1);
    const done = s.getTask(rec.taskId);
    expect(done?.status).toBe("completed");
    expect(done?.receipt?.totalTokens).toBe(15);
    expect(done?.receipt?.intensityGCo2PerKwh).toBeGreaterThan(0);
    expect(done?.receipt?.gridSource).toBeDefined();
    expect(done?.receipt?.energySource).toBeDefined();
    expect((done?.result as { text?: string })?.text).toBe("batch-result");
    s.shutdown();
  });

  it("a batch result cut off by max_tokens keeps its stopReason (R10)", async () => {
    const s = new Scheduler({ feed: mockGridFeed() });
    const adapter = makeBatchAdapter();
    adapter.retrieveStopReason = "max_tokens";
    const rec = await s.enqueueProviderCall(
      { type: "provider_call", provider: "anthropic", model: "m", prompt: "long" },
      { deadline: deadline(60), region: "US-CAL-CISO", taskId: "bt-maxtok" },
    );
    await s.tick({ anthropic: adapter }); // submit
    await s.tick({ anthropic: adapter }); // retrieve → completed
    const done = s.getTask(rec.taskId);
    expect(done?.status).toBe("completed");
    expect((done?.result as { stopReason?: string })?.stopReason).toBe("max_tokens");
    s.shutdown();
  });

  it("3h deadline uses the sync path (dispatchBatch never called)", async () => {
    const s = new Scheduler({ feed: mockGridFeed() });
    const adapter = makeBatchAdapter();
    const rec = await s.enqueueProviderCall(
      { type: "provider_call", provider: "anthropic", model: "m", prompt: "hi" },
      { deadline: deadline(3), region: "US-CAL-CISO", taskId: "bt-short" },
    );
    const stored = s.getTask(rec.taskId);
    if (stored) stored.scheduledFor = new Date(Date.now() - 1000).toISOString();
    const result = await s.tick({ anthropic: adapter });
    expect(result.batchSubmitted).toBe(0);
    expect(adapter.dispatchBatchCalls).toHaveLength(0);
    expect(adapter.dispatchCalls).toHaveLength(1);
    expect(s.getTask(rec.taskId)?.status).toBe("completed");
    s.shutdown();
  });

  it("preferBatch:false + 60h → sync at the scheduled window (nothing before)", async () => {
    const s = new Scheduler({ feed: mockGridFeed() });
    const adapter = makeBatchAdapter();
    const rec = await s.enqueueProviderCall(
      {
        type: "provider_call",
        provider: "anthropic",
        model: "m",
        prompt: "hi",
        preferBatch: false,
      },
      { deadline: deadline(60), region: "US-CAL-CISO", taskId: "bt-nobatch" },
    );
    // Force the window into the future — nothing should happen.
    let stored = s.getTask(rec.taskId);
    if (stored)
      stored.scheduledFor = new Date(Date.now() + 10 * 3600_000).toISOString();
    const r1 = await s.tick({ anthropic: adapter });
    expect(r1.batchSubmitted).toBe(0);
    expect(r1.inspected).toBe(0);
    expect(adapter.dispatchBatchCalls).toHaveLength(0);
    expect(adapter.dispatchCalls).toHaveLength(0);

    // Move the window to now → sync dispatch.
    stored = s.getTask(rec.taskId);
    if (stored) stored.scheduledFor = new Date(Date.now() - 1000).toISOString();
    const r2 = await s.tick({ anthropic: adapter });
    expect(r2.dispatched).toBe(1);
    expect(adapter.dispatchBatchCalls).toHaveLength(0);
    expect(adapter.dispatchCalls).toHaveLength(1);
    s.shutdown();
  });

  it("adapter without dispatchBatch falls back to sync", async () => {
    const s = new Scheduler({ feed: mockGridFeed() });
    const adapter = makeSyncOnlyAdapter() as ProviderAdapter & {
      dispatchCalls: Array<{ model: string; prompt: string }>;
    };
    const rec = await s.enqueueProviderCall(
      { type: "provider_call", provider: "anthropic", model: "m", prompt: "hi" },
      { deadline: deadline(60), region: "US-CAL-CISO", taskId: "bt-syncadp" },
    );
    const stored = s.getTask(rec.taskId);
    if (stored) stored.scheduledFor = new Date(Date.now() - 1000).toISOString();
    const result = await s.tick({ anthropic: adapter });
    expect(result.batchSubmitted).toBe(0);
    expect(adapter.dispatchCalls).toHaveLength(1);
    expect(s.getTask(rec.taskId)?.status).toBe("completed");
    s.shutdown();
  });

  it("retrieve → failed marks failed; retryTask re-dispatches sync + clears batchId", async () => {
    const s = new Scheduler({ feed: mockGridFeed() });
    const adapter = makeBatchAdapter();
    adapter.retrieveSequence = ["failed"];
    const rec = await s.enqueueProviderCall(
      { type: "provider_call", provider: "anthropic", model: "m", prompt: "hi" },
      { deadline: deadline(60), region: "US-CAL-CISO", taskId: "bt-fail" },
    );
    await s.tick({ anthropic: adapter }); // submit
    expect(s.getTask(rec.taskId)?.status).toBe("submitted");
    const r2 = await s.tick({ anthropic: adapter }); // poll → failed
    expect(r2.failed).toBe(1);
    expect(s.getTask(rec.taskId)?.status).toBe("failed");

    const entry = await s.retryTask(rec.taskId, { anthropic: adapter });
    expect(entry.status).toBe("completed");
    const done = s.getTask(rec.taskId);
    expect(done?.status).toBe("completed");
    expect(done?.batchId).toBeUndefined();
    expect(adapter.dispatchCalls).toHaveLength(1);
    s.shutdown();
  });

  it("expedite on a submitted task throws a clear error", async () => {
    const s = new Scheduler({ feed: mockGridFeed() });
    const adapter = makeBatchAdapter();
    adapter.retrieveSequence = ["in_progress"];
    const rec = await s.enqueueProviderCall(
      { type: "provider_call", provider: "anthropic", model: "m", prompt: "hi" },
      { deadline: deadline(60), region: "US-CAL-CISO", taskId: "bt-exp" },
    );
    await s.tick({ anthropic: adapter }); // submit
    expect(s.getTask(rec.taskId)?.status).toBe("submitted");
    await expect(
      s.expediteTask(rec.taskId, { anthropic: adapter }),
    ).rejects.toThrow(/already submitted/);
    s.shutdown();
  });

  it("two racing ticks on the same DB complete a submitted row exactly once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tidegap-batch-"));
    const dbPath = join(dir, "queue.db");
    const s1 = new Scheduler({ feed: mockGridFeed(), dbPath });
    const adapter = makeBatchAdapter();
    const rec = await s1.enqueueProviderCall(
      { type: "provider_call", provider: "anthropic", model: "m", prompt: "hi" },
      { deadline: deadline(60), region: "US-CAL-CISO", taskId: "bt-race" },
    );
    await s1.tick({ anthropic: adapter }); // submit
    expect(s1.getTask(rec.taskId)?.status).toBe("submitted");
    s1.shutdown();

    // Two fresh schedulers on the same DB race the poll.
    const sa = new Scheduler({ feed: mockGridFeed(), dbPath });
    const sb = new Scheduler({ feed: mockGridFeed(), dbPath });
    const ra = await sa.tick({ anthropic: makeBatchAdapter() });
    const rb = await sb.tick({ anthropic: makeBatchAdapter() });
    expect(ra.dispatched + rb.dispatched).toBe(1);
    sa.shutdown();
    sb.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(!nodeSqliteAvailable)("cross-language: a PY-submitted row is completed by a TS tick", async () => {
    // Reproduce the exact PY port's column layout (packages/core-py/src/
    // tidegap/scheduler.py _SCHEMA) — identical to the TS schema — with a
    // raw node:sqlite write, then read + poll it with the TS scheduler.
    // (createRequire dodges vitest's ESM resolver, which can't map the
    // "node:sqlite" builtin.)
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require("node:sqlite") as {
      DatabaseSync: new (path: string) => {
        exec(sql: string): void;
        prepare(sql: string): { run(...a: unknown[]): unknown };
        close(): void;
      };
    };
    const dir = mkdtempSync(join(tmpdir(), "tidegap-batch-xl-"));
    const dbPath = join(dir, "queue.db");
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE tasks (
        task_id           TEXT PRIMARY KEY,
        status            TEXT NOT NULL,
        enqueued_at       TEXT NOT NULL,
        scheduled_for     TEXT,
        completed_at      TEXT,
        region            TEXT NOT NULL,
        carbon_budget_g   REAL,
        result_json       TEXT,
        error             TEXT,
        receipt_json      TEXT,
        intensity_source  TEXT,
        body_json         TEXT,
        estimated_carbon_g REAL,
        deadline          TEXT,
        batch_id          TEXT
      );
    `);
    const dl = new Date(Date.now() + 60 * 3600_000).toISOString();
    const body = JSON.stringify({
      type: "provider_call",
      provider: "anthropic",
      model: "m",
      prompt: "hello",
    });
    raw
      .prepare(
        `INSERT INTO tasks (task_id, status, enqueued_at, region, body_json, deadline, batch_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("xl-py", "submitted", dl, "US-CAL-CISO", body, dl, "py-batch-1");
    raw.close();

    const s = new Scheduler({ feed: mockGridFeed(), dbPath });
    const loaded = s.loadPersistedTask("xl-py");
    expect(loaded?.status).toBe("submitted");
    expect(loaded?.batchId).toBe("py-batch-1");
    const adapter = makeBatchAdapter();
    const result = await s.tick({ anthropic: adapter });
    expect(result.dispatched).toBe(1);
    const done = s.getTask("xl-py");
    expect(done?.status).toBe("completed");
    expect(done?.receipt?.totalTokens).toBe(15);
    expect((done?.result as { text?: string })?.text).toBe("batch-result");
    s.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  it("a legacy row with no persisted deadline skips batch (sync path)", async () => {
    // In-memory scheduler so only the in-memory record matters (a DB-backed
    // store would round-trip the persisted deadline back in the tick's
    // store scan).
    const s = new Scheduler({ feed: mockGridFeed() });
    const rec = await s.enqueueProviderCall(
      { type: "provider_call", provider: "anthropic", model: "m", prompt: "hi" },
      { deadline: deadline(60), region: "US-CAL-CISO", taskId: "bt-legacy" },
    );
    // Simulate a legacy row: no persisted deadline + a due window.
    const stored = s.getTask(rec.taskId);
    if (stored) {
      stored.deadline = undefined;
      stored.scheduledFor = new Date(Date.now() - 1000).toISOString();
    }
    const adapter = makeBatchAdapter();
    const result = await s.tick({ anthropic: adapter });
    expect(result.batchSubmitted).toBe(0);
    expect(adapter.dispatchBatchCalls).toHaveLength(0);
    expect(adapter.dispatchCalls).toHaveLength(1);
    expect(s.getTask(rec.taskId)?.status).toBe("completed");
    s.shutdown();
  });
});
