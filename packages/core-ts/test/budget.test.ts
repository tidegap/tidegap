/**
 * Aggregate carbon-budget alerts (ROADMAP item 4).
 *
 * Covers the pure helpers (window math, usage summation, status), config
 * loading (file + env override), and the scheduler hook: threshold crossing
 * fires exactly once, is idempotent across restarts, resets on window
 * rollover, and is guarded against a multi-process double-fire by the DB
 * marker.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  carbonBudgetStatus,
  carbonBudgetUsage,
  loadCarbonBudgetConfig,
  mockGridFeed,
  receiptCarbonG,
  Scheduler,
  TaskStore,
  windowBounds,
  type CarbonAlert,
  type CarbonBudgetEnv,
  type TaskRecord,
} from "../src/index.js";
import type { ProviderAdapter } from "../src/providers/base.js";

function makeFakeAdapter(provider: "anthropic" | "openai"): ProviderAdapter {
  return {
    provider,
    ready: true,
    async dispatch(model, prompt) {
      return { text: "ok", model, provider, raw: null };
    },
    async dispatchBatch(model, prompts) {
      return { batchId: "b1", provider, size: prompts.length };
    },
  };
}

/** A synthetic completed row with a receipt at `ranAt` carrying `actualG`. */
function completedRow(
  taskId: string,
  ranAt: string,
  actualG: number,
  estimatedG?: number,
): TaskRecord<unknown> {
  return {
    taskId,
    status: "completed",
    enqueuedAt: ranAt,
    region: "US-CAL-CISO",
    receipt: {
      taskId,
      ranAt,
      region: "US-CAL-CISO",
      estimatedCarbonGCo2: estimatedG ?? actualG,
      actualCarbonGCo2: actualG,
    },
  };
}

describe("windowBounds", () => {
  it("computes the UTC calendar day for daily", () => {
    const { start, end } = windowBounds("daily", new Date("2026-07-17T13:45:00Z"));
    expect(start.toISOString()).toBe("2026-07-17T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-07-18T00:00:00.000Z");
  });

  it("computes the ISO week (Monday-start) for weekly", () => {
    // 2026-07-17 is a Friday → week starts Monday 2026-07-13.
    const { start, end } = windowBounds("weekly", new Date("2026-07-17T13:45:00Z"));
    expect(start.toISOString()).toBe("2026-07-13T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-07-20T00:00:00.000Z");
  });

  it("computes the UTC calendar month for monthly", () => {
    const { start, end } = windowBounds("monthly", new Date("2026-07-17T13:45:00Z"));
    expect(start.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });
});

describe("receiptCarbonG", () => {
  it("prefers actual, falls back to estimated", () => {
    expect(receiptCarbonG({ taskId: "t", ranAt: "x", region: "r", estimatedCarbonGCo2: 5, actualCarbonGCo2: 7 })).toBe(7);
    expect(receiptCarbonG({ taskId: "t", ranAt: "x", region: "r", estimatedCarbonGCo2: 5 })).toBe(5);
    expect(receiptCarbonG(undefined)).toBe(0);
  });
});

describe("carbonBudgetUsage", () => {
  it("sums only receipts inside the window", () => {
    const at = new Date("2026-07-17T12:00:00Z");
    const rows = [
      completedRow("a", "2026-07-17T01:00:00Z", 10),
      completedRow("b", "2026-07-17T23:00:00Z", 4),
      completedRow("c", "2026-07-16T23:00:00Z", 100), // previous day → excluded
    ];
    const usage = carbonBudgetUsage(rows, "daily", at);
    expect(usage.usedG).toBe(14);
    expect(usage.taskCount).toBe(2);
    expect(usage.windowStart).toBe("2026-07-17T00:00:00.000Z");
  });
});

describe("carbonBudgetStatus", () => {
  it("computes percent and exceeded", () => {
    const at = new Date("2026-07-17T12:00:00Z");
    const rows = [completedRow("a", "2026-07-17T01:00:00Z", 75)];
    const status = carbonBudgetStatus(rows, { windowKind: "daily", thresholdG: 100 }, at, false);
    expect(status.usedG).toBe(75);
    expect(status.pct).toBe(75);
    expect(status.exceeded).toBe(false);
    const over = carbonBudgetStatus(
      [...rows, completedRow("b", "2026-07-17T02:00:00Z", 40)],
      { windowKind: "daily", thresholdG: 100 },
      at,
      true,
    );
    expect(over.usedG).toBe(115);
    expect(over.pct).toBe(115);
    expect(over.exceeded).toBe(true);
    expect(over.alerted).toBe(true);
  });
});

describe("loadCarbonBudgetConfig", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-budget-cfg-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns undefined when no threshold is configured", () => {
    expect(loadCarbonBudgetConfig({ path: join(dir, "missing"), env: {} })).toBeUndefined();
  });

  it("parses the KEY=VALUE config file", () => {
    const p = join(dir, "config");
    writeFileSync(p, "# budget\nTIDEGAP_CARBON_BUDGET_G=500\nTIDEGAP_CARBON_BUDGET_WINDOW=weekly\n");
    expect(loadCarbonBudgetConfig({ path: p, env: {} })).toEqual({
      windowKind: "weekly",
      thresholdG: 500,
    });
  });

  it("defaults the window to daily", () => {
    const p = join(dir, "config");
    writeFileSync(p, "TIDEGAP_CARBON_BUDGET_G=250\n");
    expect(loadCarbonBudgetConfig({ path: p, env: {} })?.windowKind).toBe("daily");
  });

  it("lets an env var override the file", () => {
    const p = join(dir, "config");
    writeFileSync(p, "TIDEGAP_CARBON_BUDGET_G=500\nTIDEGAP_CARBON_BUDGET_WINDOW=weekly\n");
    const cfg = loadCarbonBudgetConfig({
      path: p,
      env: { TIDEGAP_CARBON_BUDGET_G: "999", TIDEGAP_CARBON_BUDGET_WINDOW: "monthly" },
    });
    expect(cfg).toEqual({ windowKind: "monthly", thresholdG: 999 });
  });

  it("ignores a 0.17 EBB_* key in the file (removed in 0.19)", () => {
    const p = join(dir, "config");
    writeFileSync(p, "EBB_CARBON_BUDGET_G=500\nEBB_CARBON_BUDGET_WINDOW=weekly\n");
    expect(loadCarbonBudgetConfig({ path: p, env: {} })).toBeUndefined();
  });

  it("uses the TIDEGAP_* key next to an EBB_* key in the file", () => {
    const p = join(dir, "config");
    writeFileSync(p, "EBB_CARBON_BUDGET_G=500\nTIDEGAP_CARBON_BUDGET_G=300\n");
    expect(loadCarbonBudgetConfig({ path: p, env: {} })?.thresholdG).toBe(300);
  });

  it("ignores an EBB_* host override", () => {
    const p = join(dir, "absent");
    const legacyEnv = { EBB_CARBON_BUDGET_G: "40" } as unknown as CarbonBudgetEnv;
    expect(loadCarbonBudgetConfig({ path: p, env: legacyEnv })).toBeUndefined();
  });

  it("disables on a non-positive or malformed threshold", () => {
    const p = join(dir, "config");
    writeFileSync(p, "TIDEGAP_CARBON_BUDGET_G=0\n");
    expect(loadCarbonBudgetConfig({ path: p, env: {} })).toBeUndefined();
    expect(loadCarbonBudgetConfig({ path: join(dir, "x"), env: { TIDEGAP_CARBON_BUDGET_G: "abc" } })).toBeUndefined();
  });
});

describe("TaskStore carbon-budget markers", () => {
  it("records a marker once per (window, threshold) — the double-fire guard", () => {
    const store = new TaskStore({ dbPath: ":memory:" });
    const first = store.recordBudgetAlert("daily", "2026-07-17T00:00:00.000Z", 100, 120, "t-1", "now");
    const second = store.recordBudgetAlert("daily", "2026-07-17T00:00:00.000Z", 100, 130, "t-2", "now");
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(store.hasBudgetAlert("daily", "2026-07-17T00:00:00.000Z", 100)).toBe(true);
    // A different window (rollover) fires again.
    expect(store.recordBudgetAlert("daily", "2026-07-18T00:00:00.000Z", 100, 120, "t-3", "now")).toBe(true);
    // A different threshold is a distinct budget.
    expect(store.recordBudgetAlert("daily", "2026-07-17T00:00:00.000Z", 50, 120, "t-4", "now")).toBe(true);
    store.close();
  });

  it("shares the marker across two handles on the same file (multi-process)", () => {
    const dir = mkdtempSync(join(tmpdir(), "tidegap-budget-mp-"));
    const dbPath = join(dir, "queue.db");
    const a = new TaskStore({ dbPath });
    const b = new TaskStore({ dbPath });
    expect(a.recordBudgetAlert("daily", "2026-07-17T00:00:00.000Z", 100, 120, "t-1", "now")).toBe(true);
    // The second process sees the marker and does NOT re-fire.
    expect(b.recordBudgetAlert("daily", "2026-07-17T00:00:00.000Z", 100, 130, "t-2", "now")).toBe(false);
    expect(b.hasBudgetAlert("daily", "2026-07-17T00:00:00.000Z", 100)).toBe(true);
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

/** Enqueue a provider-call task and force it due, then return its id. */
async function enqueueDue(s: Scheduler, taskId: string): Promise<string> {
  const rec = await s.enqueueProviderCall(
    { type: "provider_call", provider: "anthropic", model: "claude-sonnet-4-5", prompt: "hi" },
    { deadline: new Date(Date.now() + 1500), region: "US-CAL-CISO", taskId },
  );
  const stored = s.getTask(rec.taskId);
  if (stored) stored.scheduledFor = new Date().toISOString();
  return rec.taskId;
}

describe("Scheduler carbon-budget alert hook", () => {
  let dir: string;
  let dbPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-budget-sched-"));
    dbPath = join(dir, "queue.db");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("fires once when a tick crosses the threshold, then never again", async () => {
    const alerts: CarbonAlert[] = [];
    const s = new Scheduler({
      feed: mockGridFeed(),
      dbPath,
      signing: false,
      // Threshold tiny enough that a single dispatched task crosses it.
      carbonBudget: { windowKind: "daily", thresholdG: 0.0001 },
      onCarbonAlert: (a) => {
        alerts.push(a);
      },
    });
    const fake = makeFakeAdapter("anthropic");
    const id = await enqueueDue(s, "t-cross");
    const res = await s.tick({ anthropic: fake });
    expect(res.dispatched).toBe(1);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.windowKind).toBe("daily");
    expect(alerts[0]!.taskIdThatCrossed).toBe(id);
    expect(alerts[0]!.actualG).toBeGreaterThanOrEqual(0.0001);

    // A second tick (nothing new completes) must not re-fire.
    await s.tick({ anthropic: fake });
    expect(alerts).toHaveLength(1);
    s.shutdown();
  });

  it("does not fire under the threshold", async () => {
    const alerts: CarbonAlert[] = [];
    const s = new Scheduler({
      feed: mockGridFeed(),
      dbPath,
      signing: false,
      carbonBudget: { windowKind: "daily", thresholdG: 1_000_000 },
      onCarbonAlert: (a) => void alerts.push(a),
    });
    await enqueueDue(s, "t-under");
    await s.tick({ anthropic: makeFakeAdapter("anthropic") });
    expect(alerts).toHaveLength(0);
    s.shutdown();
  });

  it("is idempotent across a restart — a fresh scheduler on the same DB does not re-fire", async () => {
    const first: CarbonAlert[] = [];
    const s1 = new Scheduler({
      feed: mockGridFeed(),
      dbPath,
      signing: false,
      carbonBudget: { windowKind: "daily", thresholdG: 0.0001 },
      onCarbonAlert: (a) => void first.push(a),
    });
    await enqueueDue(s1, "t-a");
    await s1.tick({ anthropic: makeFakeAdapter("anthropic") });
    expect(first).toHaveLength(1);
    s1.shutdown();

    // New process on the same ledger: complete another task in the same
    // window. The marker already exists → no second alert.
    const second: CarbonAlert[] = [];
    const s2 = new Scheduler({
      feed: mockGridFeed(),
      dbPath,
      signing: false,
      carbonBudget: { windowKind: "daily", thresholdG: 0.0001 },
      onCarbonAlert: (a) => void second.push(a),
    });
    await enqueueDue(s2, "t-b");
    await s2.tick({ anthropic: makeFakeAdapter("anthropic") });
    expect(second).toHaveLength(0);
    s2.shutdown();
  });

  it("getCarbonBudgetStatus reports used/threshold/alerted", async () => {
    const s = new Scheduler({
      feed: mockGridFeed(),
      dbPath,
      signing: false,
      carbonBudget: { windowKind: "daily", thresholdG: 0.0001 },
      onCarbonAlert: () => {},
    });
    expect(s.getCarbonBudgetStatus()?.taskCount).toBe(0);
    await enqueueDue(s, "t-s");
    await s.tick({ anthropic: makeFakeAdapter("anthropic") });
    const status = s.getCarbonBudgetStatus();
    expect(status?.taskCount).toBe(1);
    expect(status?.exceeded).toBe(true);
    expect(status?.alerted).toBe(true);
    s.shutdown();
  });

  it("returns undefined status when no budget is configured", () => {
    const s = new Scheduler({ feed: mockGridFeed(), dbPath, signing: false });
    expect(s.getCarbonBudgetStatus()).toBeUndefined();
    s.shutdown();
  });
});
