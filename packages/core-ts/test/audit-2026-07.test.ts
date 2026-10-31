/**
 * Regression tests for the verified findings of audit-2026-07-07:
 *
 *   §0.2 / §1.6 / §1.8 — receipt provenance (intensity, gridSource,
 *                        energySource; SYNTHETIC disclosure in recommend)
 *   §0.5             — a paid provider call must never be re-labelled failed
 *   §1.1–1.4         — multi-process pack (busy_timeout, claim guards,
 *                        duplicate taskId vs store, cancel-overwrite)
 *   §0.8             — ledger permissions + body_json redaction + patterns
 *   §1.7             — the current hour is a valid dispatch candidate
 *   §1.5             — fire-and-forget scheduling routes errors to failTask
 *   §1.13            — retry policy: no retry on ambiguous mid-flight errors
 *   V27              — previewProviderCall mirrors the commit-path fallback
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bandHistogram,
  recommendWindow,
  Scheduler,
  TaskStore,
} from "../src/index.js";
import type {
  GridFeed,
  GridForecast,
  GridForecastEntry,
  ProviderAdapter,
  TaskRecord,
} from "../src/index.js";

// --------------------------------------------------------------------------
// Helpers

function band(g: number): GridForecastEntry["band"] {
  if (g < 100) return "very_clean";
  if (g < 250) return "clean";
  if (g < 450) return "average";
  if (g < 700) return "dirty";
  return "very_dirty";
}

/** Deterministic feed from [hoursFromNow, intensity] pairs (fractional hours ok). */
function staticFeed(
  intensities: Array<[hours: number, intensity: number]>,
  opts: { failAfterCalls?: number; anchor?: Date } = {},
): GridFeed & { calls: () => number } {
  let calls = 0;
  return {
    source: "mock",
    calls: () => calls,
    async fetchForecast(region: string): Promise<GridForecast> {
      calls += 1;
      if (opts.failAfterCalls !== undefined && calls > opts.failAfterCalls) {
        throw new Error("feed down");
      }
      const now = opts.anchor ?? new Date();
      return {
        region,
        source: "mock",
        generatedAt: now.toISOString(),
        entries: intensities.map(([h, g]) => ({
          datetime: new Date(now.getTime() + h * 60 * 60 * 1000).toISOString(),
          carbonIntensityGCo2PerKwh: g,
          band: band(g),
        })),
      };
    },
  };
}

function rejectingFeed(): GridFeed {
  return {
    source: "mock",
    async fetchForecast(): Promise<GridForecast> {
      throw new Error("feed down");
    },
  };
}

interface CountingAdapter extends ProviderAdapter {
  calls: () => number;
}

function fakeAdapter(opts: {
  provider?: "anthropic" | "openai";
  echoModel?: string;
  delayMs?: number;
  throwFirst?: unknown[];
} = {}): CountingAdapter {
  const provider = opts.provider ?? "anthropic";
  let calls = 0;
  const pendingThrows = [...(opts.throwFirst ?? [])];
  return {
    provider,
    ready: true,
    calls: () => calls,
    async dispatch(model, prompt) {
      calls += 1;
      if (pendingThrows.length > 0) throw pendingThrows.shift();
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      return {
        text: `ok:${prompt.slice(0, 8)}`,
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        model: opts.echoModel ?? model,
        provider,
        raw: null,
      };
    },
    async dispatchBatch() {
      throw new Error("batch not used in these tests");
    },
  };
}

const hoursFromNow = (h: number) => new Date(Date.now() + h * 60 * 60 * 1000);

function providerSpec(prompt = "hello", extra: Record<string, unknown> = {}) {
  return {
    type: "provider_call" as const,
    provider: "anthropic" as const,
    model: "claude-sonnet-4-5",
    prompt,
    ...extra,
  };
}

// Capture unhandled rejections for the duration of a test.
function trapUnhandledRejections() {
  const seen: unknown[] = [];
  const listener = (reason: unknown) => {
    seen.push(reason);
  };
  process.on("unhandledRejection", listener);
  return {
    seen,
    dispose: () => process.removeListener("unhandledRejection", listener),
  };
}

// --------------------------------------------------------------------------
// §0.2 / §1.6 / §1.8 — receipt provenance

describe("receipt provenance (§0.2, §1.6, §1.8)", () => {
  it("records intensity, gridSource, and energySource on provider-call receipts", async () => {
    const s = new Scheduler({ feed: staticFeed([[0.2, 120], [1, 300]]) });
    const adapter = fakeAdapter({ echoModel: "claude-sonnet-4-5" });
    const rec = await s.enqueueProviderCall(providerSpec(), {
      deadline: hoursFromNow(2),
      region: "US-CAL-CISO",
    });
    const entry = await s.expediteTask(rec.taskId, { anthropic: adapter });
    expect(entry.status).toBe("completed");
    const receipt = s.getTask(rec.taskId)?.receipt;
    expect(receipt?.intensityGCo2PerKwh).toBe(120);
    expect(receipt?.gridSource).toBe("mock");
    // claude-sonnet-4-5 has closed-model (estimated) coefficients, resolved
    // by an exact table hit (§1.8 resolution provenance).
    expect(receipt?.energySource).toBe("estimated");
    expect(receipt?.energyResolution).toBe("exact");
    s.shutdown();
  });

  it("marks unknown-model receipts with the fallback energy tier", async () => {
    const s = new Scheduler({ feed: staticFeed([[0.2, 120]]) });
    const adapter = fakeAdapter({ echoModel: "totally-unknown-model" });
    const rec = await s.enqueueProviderCall(
      { ...providerSpec(), model: "totally-unknown-model" },
      { deadline: hoursFromNow(2), region: "US-CAL-CISO" },
    );
    await s.expediteTask(rec.taskId, { anthropic: adapter });
    expect(s.getTask(rec.taskId)?.receipt?.energySource).toBe("fallback");
    expect(s.getTask(rec.taskId)?.receipt?.energyResolution).toBe("default");
    s.shutdown();
  });

  it("marks family-fallback receipts honestly (§1.8): estimated + family-fallback", async () => {
    // An unknown Sonnet-family id resolves to the sonnet representative's
    // coefficients — an estimate — and the receipt discloses it was a
    // family fallback rather than an exact hit.
    const s = new Scheduler({ feed: staticFeed([[0.2, 120]]) });
    const adapter = fakeAdapter({ echoModel: "claude-sonnet-9" });
    const rec = await s.enqueueProviderCall(
      { ...providerSpec(), model: "claude-sonnet-9" },
      { deadline: hoursFromNow(2), region: "US-CAL-CISO" },
    );
    await s.expediteTask(rec.taskId, { anthropic: adapter });
    const receipt = s.getTask(rec.taskId)?.receipt;
    expect(receipt?.energySource).toBe("estimated");
    expect(receipt?.energyResolution).toBe("family-fallback");
    s.shutdown();
  });

  it("records provenance on closure-task receipts (energySource=fallback)", async () => {
    // Single entry covering "now" → immediate dispatch, no timer wait.
    const s = new Scheduler({ feed: staticFeed([[-0.5, 90]]) });
    await s.defer(async () => "done", { deadline: hoursFromNow(1) });
    const record = s.listTasks()[0]!;
    expect(record.receipt?.intensityGCo2PerKwh).toBe(90);
    expect(record.receipt?.gridSource).toBe("mock");
    expect(record.receipt?.energySource).toBe("fallback");
    expect(record.receipt?.energyResolution).toBe("default");
    s.shutdown();
  });

  it("recommendWindow reports gridSource and prefixes mock reasoning as SYNTHETIC", async () => {
    const r = await recommendWindow(
      { deadline: hoursFromNow(6), region: "US-CAL-CISO" },
      { feed: staticFeed([[0, 500], [2, 100]]) },
    );
    expect(r.gridSource).toBe("mock");
    expect(r.reasoning.startsWith("SYNTHETIC (mock) grid data — ")).toBe(true);
  });

  it("bandHistogram classifies by receipt.intensityGCo2PerKwh when present", () => {
    const mk = (
      taskId: string,
      receipt: Record<string, unknown>,
    ): TaskRecord<unknown> => ({
      taskId,
      status: "completed",
      enqueuedAt: "2026-07-01T00:00:00.000Z",
      region: "US-CAL-CISO",
      receipt: { taskId, ranAt: "2026-07-01T01:00:00.000Z", region: "US-CAL-CISO", ...receipt } as TaskRecord["receipt"],
    });
    const out = bandHistogram([
      // v0.12+ receipt: absurdly large grams (opus-class model) but the
      // recorded intensity says the grid was clean — intensity must win.
      mk("a", { estimatedCarbonGCo2: 9.9, intensityGCo2PerKwh: 120 }),
      // Legacy receipt: back-computed from the flat 0.0015 kWh model.
      mk("b", { estimatedCarbonGCo2: 300 * 0.0015 }),
    ]);
    expect(out.clean).toBe(1); // 120 g/kWh, direct
    expect(out.average).toBe(1); // 300 g/kWh, back-computed
    expect(out.veryDirty).toBe(0);
  });
});

// --------------------------------------------------------------------------
// §0.5 — a paid call must never become "failed"

describe("paid call never failed (§0.5)", () => {
  it("keeps the task completed when the receipt-side intensity fetch throws", async () => {
    const trap = trapUnhandledRejections();
    // First fetch (scheduling) succeeds; every later fetch (receipt) throws.
    const feed = staticFeed([[0.2, 150], [1, 300]], { failAfterCalls: 1 });
    const s = new Scheduler({ feed });
    const adapter = fakeAdapter({ echoModel: "claude-sonnet-4-5" });
    const rec = await s.enqueueProviderCall(providerSpec(), {
      deadline: hoursFromNow(2),
      region: "US-CAL-CISO",
    });
    const projected = s.getTask(rec.taskId)!.estimatedCarbonGCo2!;
    expect(projected).toBeGreaterThan(0);

    const entry = await s.expediteTask(rec.taskId, { anthropic: adapter });
    expect(entry.status).toBe("completed");
    const after = s.getTask(rec.taskId)!;
    expect(after.status).toBe("completed");
    expect((after.result as { text: string }).text).toMatch(/^ok:/);
    // Receipt falls back to the schedule-time estimate; provenance fields
    // stay undefined because the fetch failed.
    expect(after.receipt?.estimatedCarbonGCo2).toBe(projected);
    expect(after.receipt?.actualCarbonGCo2).toBe(projected);
    expect(after.receipt?.intensityGCo2PerKwh).toBeUndefined();
    expect(after.receipt?.gridSource).toBeUndefined();
    expect(adapter.calls()).toBe(1);

    // A retry on the completed (billed!) task must throw — and must not
    // reach the provider a second time.
    await expect(s.retryTask(rec.taskId, { anthropic: adapter })).rejects.toThrow(
      /retry is only valid on failed/,
    );
    expect(adapter.calls()).toBe(1);

    await new Promise((r) => setTimeout(r, 10));
    expect(trap.seen).toEqual([]);
    trap.dispose();
    s.shutdown();
  });
});

// --------------------------------------------------------------------------
// §1.1–1.4 — multi-process pack

describe("multi-process safety (§1.1–1.4)", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-audit-"));
    dbPath = join(dir, "queue.db");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("sets busy_timeout=5000 on disk-backed stores", () => {
    const store = new TaskStore({ dbPath });
    const db = (store as unknown as {
      db: { prepare: (s: string) => { get(): { timeout: number } } };
    }).db;
    expect(db.prepare("PRAGMA busy_timeout").get().timeout).toBe(5000);
    store.close();
  });

  it("persists the normalized deadline on the record and in SQLite", async () => {
    const s = new Scheduler({ dbPath, feed: staticFeed([[1, 100]]) });
    const deadline = hoursFromNow(6);
    const rec = await s.enqueueProviderCall(providerSpec(), {
      deadline,
      region: "US-CAL-CISO",
    });
    expect(rec.deadline).toBe(deadline.toISOString());
    s.shutdown();
    const store = new TaskStore({ dbPath });
    expect(store.get(rec.taskId)?.deadline).toBe(deadline.toISOString());
    store.close();
  });

  it("ensureColumns tolerates a concurrent 'duplicate column name' migration", () => {
    // Simulate the TOCTOU: pragma_table_info reports the columns missing,
    // but each ALTER races another process and throws duplicate-column.
    const backing = new TaskStore({ dbPath });
    const backingDb = (backing as unknown as {
      db: {
        exec(sql: string): void;
        prepare(sql: string): { all(...p: unknown[]): Record<string, unknown>[]; get(...p: unknown[]): Record<string, unknown> | undefined; run(...p: unknown[]): { changes: number; lastInsertRowid: number } };
        close(): void;
      };
    }).db;
    const wrapper = {
      exec(sql: string): void {
        if (/ALTER TABLE tasks ADD COLUMN/.test(sql)) {
          throw new Error("duplicate column name: deadline");
        }
        backingDb.exec(sql);
      },
      prepare(sql: string) {
        if (/pragma_table_info/.test(sql)) {
          // Pretend all migrated columns are missing to force the ALTERs.
          return {
            all: () => [{ name: "task_id" }, { name: "status" }],
            get: () => undefined,
            run: () => ({ changes: 0, lastInsertRowid: 0 }),
          };
        }
        return backingDb.prepare(sql);
      },
      close(): void {
        backingDb.close();
      },
    };
    // Must not throw despite every ALTER "racing" another process.
    const store = new TaskStore({ dbPath: ":memory:", db: wrapper });
    store.close();
  });

  it("expediteTask refuses to dispatch when another process claimed the row", async () => {
    const store = new TaskStore({ dbPath });
    let allowClaims = true;
    const realClaim = store.claimScheduled.bind(store);
    store.claimScheduled = (taskId: string) =>
      allowClaims ? realClaim(taskId) : false;
    const s = new Scheduler({ store, feed: staticFeed([[1, 100]]) });
    const adapter = fakeAdapter();
    const rec = await s.enqueueProviderCall(providerSpec(), {
      deadline: hoursFromNow(6),
      region: "US-CAL-CISO",
    });
    allowClaims = false;
    await expect(s.expediteTask(rec.taskId, { anthropic: adapter })).rejects.toThrow(
      /just claimed by another process/,
    );
    expect(adapter.calls()).toBe(0);
    s.shutdown();
  });

  it("retryTask refuses to dispatch when another process claimed the row", async () => {
    const store = new TaskStore({ dbPath });
    let allowClaims = true;
    const realClaim = store.claimScheduled.bind(store);
    store.claimScheduled = (taskId: string) =>
      allowClaims ? realClaim(taskId) : false;
    const s = new Scheduler({ store, feed: staticFeed([[1, 100]]) });
    const failing = fakeAdapter({ throwFirst: [{ status: 400, message: "bad" }] });
    const rec = await s.enqueueProviderCall(providerSpec(), {
      deadline: hoursFromNow(6),
      region: "US-CAL-CISO",
    });
    const failedEntry = await s.expediteTask(rec.taskId, { anthropic: failing });
    expect(failedEntry.status).toBe("failed");
    allowClaims = false;
    const adapter = fakeAdapter();
    await expect(s.retryTask(rec.taskId, { anthropic: adapter })).rejects.toThrow(
      /just claimed by another process/,
    );
    expect(adapter.calls()).toBe(0);
    s.shutdown();
  });

  it("rejects a duplicate taskId that exists only in the store — old row intact (§1.3)", async () => {
    const s1 = new Scheduler({ dbPath, feed: staticFeed([[1, 100]]) });
    const adapter = fakeAdapter({ echoModel: "claude-sonnet-4-5" });
    await s1.enqueueProviderCall(providerSpec("original prompt"), {
      taskId: "dup-1",
      deadline: hoursFromNow(6),
      region: "US-CAL-CISO",
    });
    await s1.expediteTask("dup-1", { anthropic: adapter });
    expect(s1.getTask("dup-1")?.status).toBe("completed");
    s1.shutdown();

    // A fresh process (empty in-memory map) must not overwrite the
    // persisted, completed + signed ledger row.
    const s2 = new Scheduler({ dbPath, feed: staticFeed([[1, 100]]) });
    await expect(
      s2.enqueueProviderCall(providerSpec("attacker overwrite"), {
        taskId: "dup-1",
        deadline: hoursFromNow(6),
        region: "US-CAL-CISO",
      }),
    ).rejects.toThrow(/already in the queue/);
    expect(() =>
      s2.enqueue(async () => "x", { taskId: "dup-1", deadline: hoursFromNow(1) }),
    ).toThrow(/already in the queue/);
    s2.shutdown();

    const store = new TaskStore({ dbPath });
    const row = store.get("dup-1");
    expect(row?.status).toBe("completed");
    expect(row?.receipt).toBeDefined();
    expect(JSON.stringify(row?.result)).toContain("ok:");
    store.close();
  });

  it("does not overwrite a mid-flight cancellation with completed (§1.2, provider-call path)", async () => {
    const s = new Scheduler({ dbPath, feed: staticFeed([[-0.5, 100]]) });
    const adapter = fakeAdapter({ delayMs: 120 });
    const rec = await s.enqueueProviderCall(providerSpec(), {
      deadline: hoursFromNow(1),
      region: "US-CAL-CISO",
    });
    const tickPromise = s.tick({ anthropic: adapter });
    await new Promise((r) => setTimeout(r, 40));
    expect(s.getTask(rec.taskId)?.status).toBe("running");
    s.cancelTask(rec.taskId);
    const result = await tickPromise;
    // The (billed) call finished after the cancel: the record stays
    // cancelled, the late result is dropped, and the tick reports the
    // drop instead of a completion.
    expect(result.results[0]?.error).toMatch(/cancelled while running/);
    const after = s.getTask(rec.taskId)!;
    expect(after.status).toBe("cancelled");
    expect(after.result).toBeUndefined();
    expect(after.receipt).toBeUndefined();
    const store = new TaskStore({ dbPath });
    expect(store.get(rec.taskId)?.status).toBe("cancelled");
    expect(store.get(rec.taskId)?.result).toBeUndefined();
    store.close();
    s.shutdown();
  });

  it("does not overwrite a mid-flight cancellation with completed (§1.2, closure path)", async () => {
    const s = new Scheduler({ dbPath, feed: staticFeed([[-0.5, 100]]) });
    const rec = s.enqueue(
      async () => {
        await new Promise((r) => setTimeout(r, 120));
        return "late result";
      },
      { deadline: hoursFromNow(1) },
    );
    await new Promise((r) => setTimeout(r, 40));
    expect(s.getTask(rec.taskId)?.status).toBe("running");
    s.cancelTask(rec.taskId);
    await new Promise((r) => setTimeout(r, 150));
    const after = s.getTask(rec.taskId)!;
    expect(after.status).toBe("cancelled");
    expect(after.result).toBeUndefined();
    const store = new TaskStore({ dbPath });
    expect(store.get(rec.taskId)?.status).toBe("cancelled");
    store.close();
    s.shutdown();
  });
});

// --------------------------------------------------------------------------
// §0.8 — ledger permissions + body redaction + vendor-shaped patterns

describe("ledger permissions and redaction (§0.8)", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-perm-"));
    dbPath = join(dir, "queue.db");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("chmods the ledger to 0600 and its directory to 0700", () => {
    chmodSync(dir, 0o755); // simulate a permissive parent dir
    const store = new TaskStore({ dbPath });
    store.upsert({
      taskId: "perm-1",
      status: "queued",
      enqueuedAt: new Date().toISOString(),
      region: "US-CAL-CISO",
    });
    expect(statSync(dbPath).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    store.close();
  });

  it("redacts body_json on completion; live dispatch used the original prompt", async () => {
    const secret = "sk-ant-AAAAABBBBBBCCCCCCDDDDDD";
    const prompt = `use ${secret} to call the API`;
    let promptSeenByProvider: string | undefined;
    const adapter: ProviderAdapter = {
      provider: "anthropic",
      ready: true,
      async dispatch(model, p) {
        promptSeenByProvider = p;
        return { text: "ok", model, provider: "anthropic", raw: null };
      },
      async dispatchBatch() {
        throw new Error("unused");
      },
    };
    const s = new Scheduler({ dbPath, feed: staticFeed([[1, 100]]) });
    const rec = await s.enqueueProviderCall(providerSpec(prompt), {
      deadline: hoursFromNow(6),
      region: "US-CAL-CISO",
    });
    await s.expediteTask(rec.taskId, { anthropic: adapter });
    // The wire call used the caller's original prompt…
    expect(promptSeenByProvider).toContain(secret);
    // …but the terminal ledger row no longer contains the secret.
    const store = new TaskStore({ dbPath });
    const row = store.get(rec.taskId)!;
    expect(row.bodyJson).toBeDefined();
    expect(row.bodyJson).not.toContain(secret);
    expect(row.bodyJson).toContain("[REDACTED]");
    store.close();
    s.shutdown();
  });

  it("redacts body_json on cancellation, but keeps it on failure for retry", async () => {
    const secret = "sk-ant-AAAAABBBBBBCCCCCCDDDDDD";
    const s = new Scheduler({ dbPath, feed: staticFeed([[1, 100]]) });
    // Failure path: original body retained so retryTask can re-dispatch.
    const failing = fakeAdapter({ throwFirst: [{ status: 400, message: "bad" }] });
    const failed = await s.enqueueProviderCall(providerSpec(`f ${secret}`), {
      deadline: hoursFromNow(6),
      region: "US-CAL-CISO",
    });
    await s.expediteTask(failed.taskId, { anthropic: failing });
    // Cancellation path: terminal, so the body is redacted.
    const cancelled = await s.enqueueProviderCall(providerSpec(`c ${secret}`), {
      deadline: hoursFromNow(6),
      region: "US-CAL-CISO",
    });
    s.cancelTask(cancelled.taskId);
    s.shutdown();
    const store = new TaskStore({ dbPath });
    expect(store.get(failed.taskId)?.status).toBe("failed");
    expect(store.get(failed.taskId)?.bodyJson).toContain(secret);
    expect(store.get(cancelled.taskId)?.status).toBe("cancelled");
    expect(store.get(cancelled.taskId)?.bodyJson).not.toContain(secret);
    store.close();
  });

  it("redacts vendor-shaped credentials but leaves legitimate prose alone", async () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop";
    const secrets = [
      "sk-ant-AAAAABBBBBBCCCCCCDDDDDD",
      "sk-proj-abcdefghijklmnopqrstuvwx",
      "Bearer abcdefghijklmnopqrstuvwxyz",
      "AKIAIOSFODNN7EXAMPLE",
      `ghp_${"A".repeat(36)}`,
      `github_pat_${"a".repeat(30)}`,
      `AIza${"S".repeat(35)}`,
      "xoxb-1234567890-ABCDEFG",
      jwt,
    ];
    const prose =
      "region US-MIDA-PJM, set DB_PASSWORD env var, timestamps use ISO_8601";
    const prompt = `${prose}\n${secrets.join("\n")}`;
    const s = new Scheduler({ feed: staticFeed([[1, 100]]) });
    const rec = await s.enqueueProviderCall(providerSpec(prompt), {
      deadline: hoursFromNow(6),
      region: "US-CAL-CISO",
    });
    await s.expediteTask(rec.taskId, { anthropic: fakeAdapter() });
    const redacted = s.getTask(rec.taskId)!.receipt!.prompt!;
    for (const secret of secrets) {
      expect(redacted).not.toContain(secret);
    }
    expect(redacted).toContain("US-MIDA-PJM");
    expect(redacted).toContain("set DB_PASSWORD env var");
    expect(redacted).toContain("ISO_8601");
    s.shutdown();
  });
});

// --------------------------------------------------------------------------
// §1.7 — the current hour is a candidate window

describe("current-hour candidacy (§1.7)", () => {
  // Entry[0] covers "now" (started 30 min ago) and is the cheapest.
  const currentHourCheapest = () =>
    staticFeed([
      [-0.5, 50],
      [0.5, 400],
      [1.5, 500],
    ]);

  it("recommendWindow can recommend the current hour with savings=0", async () => {
    const feed = currentHourCheapest();
    const r = await recommendWindow(
      { deadline: hoursFromNow(2), region: "US-CAL-CISO" },
      { feed, rng: () => 0 },
    );
    expect(r.intensityGCo2PerKwh).toBe(50);
    expect(r.estimatedSavingsVsNowPct).toBe(0);
  });

  it("scheduleProviderCall schedules the current-hour pick for 'now' (immediate tick)", async () => {
    const s = new Scheduler({ feed: currentHourCheapest() });
    const rec = await s.enqueueProviderCall(providerSpec(), {
      deadline: hoursFromNow(2),
      region: "US-CAL-CISO",
    });
    const scheduledFor = new Date(s.getTask(rec.taskId)!.scheduledFor!).getTime();
    expect(Math.abs(scheduledFor - Date.now())).toBeLessThan(5_000);
    // Its projected carbon comes from the current-hour intensity (50 →
    // ~0.2g for claude-sonnet-4-5), not from the 400/500 g/kWh future
    // hours (which would project ≥1.4g).
    expect(s.getTask(rec.taskId)!.estimatedCarbonGCo2!).toBeLessThan(1);
    const adapter = fakeAdapter();
    const result = await s.tick({ anthropic: adapter });
    expect(result.dispatched).toBe(1);
    expect(adapter.calls()).toBe(1);
    s.shutdown();
  });

  it("closure tasks dispatch immediately when the current hour is chosen", async () => {
    const s = new Scheduler({ feed: currentHourCheapest() });
    const started = Date.now();
    const value = await s.defer(async () => "now-please", {
      deadline: hoursFromNow(2),
    });
    expect(value).toBe("now-please");
    expect(Date.now() - started).toBeLessThan(2_000);
    const record = s.listTasks()[0]!;
    expect(record.status).toBe("completed");
    expect(record.intensitySource).toBe("scored");
    s.shutdown();
  });
});

// --------------------------------------------------------------------------
// §1.5 — fire-and-forget scheduling must fail the task, not the process

describe("fire-and-forget error routing (§1.5)", () => {
  it("a rejecting feed fails the deferred task and rejects defer() — no unhandledRejection", async () => {
    const trap = trapUnhandledRejections();
    const s = new Scheduler({ feed: rejectingFeed() });
    await expect(
      s.defer(async () => "never runs", { deadline: hoursFromNow(1) }),
    ).rejects.toThrow("feed down");
    const record = s.listTasks()[0]!;
    expect(record.status).toBe("failed");
    expect(record.error).toBe("feed down");
    await new Promise((r) => setTimeout(r, 10));
    expect(trap.seen).toEqual([]);
    trap.dispose();
    s.shutdown();
  });

  it("a scheduling failure after the queued upsert fails the provider-call row (no stranded queued)", async () => {
    const trap = trapUnhandledRejections();
    const s = new Scheduler({ feed: rejectingFeed() });
    await expect(
      s.enqueueProviderCall(providerSpec(), {
        deadline: hoursFromNow(1),
        region: "US-CAL-CISO",
      }),
    ).rejects.toThrow("feed down");
    const record = s.listTasks()[0]!;
    expect(record.status).toBe("failed");
    await new Promise((r) => setTimeout(r, 10));
    expect(trap.seen).toEqual([]);
    trap.dispose();
    s.shutdown();
  });
});

// --------------------------------------------------------------------------
// §1.13 — retry policy: ambiguous mid-flight errors are not retried

describe("retry policy (§1.13)", () => {
  it("does not retry ECONNRESET (call may already be billed)", async () => {
    const adapter = fakeAdapter({
      throwFirst: [{ code: "ECONNRESET", message: "socket hang up" }],
    });
    const s = new Scheduler({ feed: staticFeed([[1, 100]]) });
    const rec = await s.enqueueProviderCall(providerSpec(), {
      deadline: hoursFromNow(6),
      region: "US-CAL-CISO",
    });
    const entry = await s.expediteTask(rec.taskId, { anthropic: adapter });
    expect(entry.status).toBe("failed");
    expect(adapter.calls()).toBe(1);
    s.shutdown();
  });

  it("does not retry ETIMEDOUT", async () => {
    const adapter = fakeAdapter({
      throwFirst: [{ code: "ETIMEDOUT", message: "timed out" }],
    });
    const s = new Scheduler({ feed: staticFeed([[1, 100]]) });
    const rec = await s.enqueueProviderCall(providerSpec(), {
      deadline: hoursFromNow(6),
      region: "US-CAL-CISO",
    });
    const entry = await s.expediteTask(rec.taskId, { anthropic: adapter });
    expect(entry.status).toBe("failed");
    expect(adapter.calls()).toBe(1);
    s.shutdown();
  });

  it("retries pre-connect failures, including codes wrapped in error.cause", async () => {
    const adapter = fakeAdapter({
      throwFirst: [
        Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } }),
      ],
    });
    const s = new Scheduler({ feed: staticFeed([[1, 100]]) });
    const rec = await s.enqueueProviderCall(providerSpec(), {
      deadline: hoursFromNow(6),
      region: "US-CAL-CISO",
    });
    const realSetTimeout = global.setTimeout;
    vi.spyOn(global, "setTimeout").mockImplementation(
      (cb: () => void) => realSetTimeout(cb, 0) as unknown as NodeJS.Timeout,
    );
    try {
      const entry = await s.expediteTask(rec.taskId, { anthropic: adapter });
      expect(entry.status).toBe("completed");
      expect(adapter.calls()).toBe(2);
    } finally {
      vi.restoreAllMocks();
    }
    s.shutdown();
  });
});

// --------------------------------------------------------------------------
// V27 — previewProviderCall mirrors the commit-path "schedule for now" fallback

describe("dry_run/commit parity (V27)", () => {
  // Every entry starts after the deadline: no usable window.
  const outOfWindowFeed = () => staticFeed([[2, 200], [3, 300]]);

  it("preview returns a schedule-for-now plan instead of throwing", async () => {
    const s = new Scheduler({ feed: outOfWindowFeed() });
    const plan = await s.previewProviderCall(providerSpec(), {
      deadline: new Date(Date.now() + 30 * 60 * 1000),
      region: "US-CAL-CISO",
    });
    expect(Math.abs(new Date(plan.scheduledFor).getTime() - Date.now())).toBeLessThan(5_000);
    expect(plan.intensityGCo2PerKwh).toBe(200); // current-cell proxy: entry[0]
    expect(plan.batchEligible).toBe(false);
    s.shutdown();
  });

  it("commit path does the same thing for the same inputs", async () => {
    const s = new Scheduler({ feed: outOfWindowFeed() });
    const rec = await s.enqueueProviderCall(providerSpec(), {
      deadline: new Date(Date.now() + 30 * 60 * 1000),
      region: "US-CAL-CISO",
    });
    const stored = s.getTask(rec.taskId)!;
    expect(stored.status).toBe("scheduled");
    expect(Math.abs(new Date(stored.scheduledFor!).getTime() - Date.now())).toBeLessThan(5_000);
    s.shutdown();
  });

  it("preview still throws CarbonBudgetExceededError when the budget is unmeetable", async () => {
    const s = new Scheduler({ feed: outOfWindowFeed() });
    await expect(
      s.previewProviderCall(providerSpec(), {
        deadline: new Date(Date.now() + 30 * 60 * 1000),
        region: "US-CAL-CISO",
        carbonBudgetG: 0.000001,
      }),
    ).rejects.toThrow(/carbon budget|gCO2e/i);
    s.shutdown();
  });
});
