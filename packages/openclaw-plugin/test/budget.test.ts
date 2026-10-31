/**
 * Aggregate carbon-budget alerts in the OpenClaw plugin (ROADMAP item 4).
 *
 * Covers the alert message/delivery helpers and the end-to-end wiring: a
 * dispatch that crosses the configured budget records the DB marker and
 * routes through the delivery machinery.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskStore, windowBounds, type CarbonAlert } from "@tidegap/core";

import tidegapPlugin, { runDispatchTick } from "../src/index.js";
import {
  deliverCarbonAlert,
  formatCarbonAlertMessage,
} from "../src/delivery.js";
import type { StubResolvedTool } from "./stub-tool-plugin.js";

function tool(name: string): StubResolvedTool {
  const found = tidegapPlugin.tools.find((t: StubResolvedTool) => t.name === name);
  if (!found) throw new Error(`tool ${name} is not registered`);
  return found;
}

function deadlineISO(hoursAhead = 24): string {
  return new Date(Date.now() + hoursAhead * 60 * 60 * 1000).toISOString();
}

const ALERT: CarbonAlert = {
  windowKind: "daily",
  windowStart: "2026-07-17T00:00:00.000Z",
  thresholdG: 100,
  actualG: 123.4,
  taskIdThatCrossed: "t-x",
};

describe("carbon-alert delivery helpers", () => {
  it("formats a compact alert message", () => {
    const msg = formatCarbonAlertMessage(ALERT);
    expect(msg).toMatch(/daily carbon budget crossed/);
    expect(msg).toMatch(/123.4 gCO2e/);
    expect(msg).toMatch(/100 g threshold/);
    expect(msg).toMatch(/t-x/);
  });

  it("chat mode with no channel reports the alert was logged only", async () => {
    const outcomes = await deliverCarbonAlert(ALERT, undefined, { modes: ["chat"] });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.mode).toBe("chat");
    expect(outcomes[0]!.ok).toBe(false);
    expect(outcomes[0]!.detail).toMatch(/no chat channel/);
  });

  it("queue mode always succeeds (marker already persisted)", async () => {
    const outcomes = await deliverCarbonAlert(ALERT, undefined, { modes: ["queue"] });
    expect(outcomes[0]!.ok).toBe(true);
  });

  it("file mode writes the alert to disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tidegap-alert-file-"));
    const filePath = join(dir, "alert.txt");
    const outcomes = await deliverCarbonAlert(ALERT, undefined, {
      modes: ["file"],
      filePath,
    });
    expect(outcomes[0]!.ok).toBe(true);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(filePath, "utf8")).toMatch(/daily carbon budget crossed/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("runDispatchTick fires a carbon-budget alert on crossing", () => {
  let tmp: string;
  let dbPath: string;
  // Tiny threshold so a single dispatched task crosses it. The threshold now
  // comes from PLUGIN CONFIG (the TIDEGAP_CARBON_BUDGET_* environment variables
  // configure the CLI and MCP server, not the plugin), and plugin config
  // overrides the ~/.tidegap/config file — so the test never touches the real
  // config and never touches the environment.
  let config: { dbPath: string; carbonBudgetG: number; carbonBudgetWindow: "daily" };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "tidegap-plugin-budget-"));
    dbPath = join(tmp, "queue.db");
    config = { dbPath, carbonBudgetG: 0.0001, carbonBudgetWindow: "daily" };
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("records the alert marker after a crossing dispatch", async () => {
    const sched = (await tool("schedule_task").execute(
      { prompt: "budget cross", deadline: deadlineISO(), region: "GB" },
      config,
    )) as { task_id: string };

    // Force the task overdue.
    const store = new TaskStore({ dbPath });
    const rec = store.get(sched.task_id);
    if (!rec) throw new Error("task not persisted");
    rec.status = "scheduled";
    rec.scheduledFor = new Date(Date.now() - 60_000).toISOString();
    store.upsert(rec);
    store.close();

    const stub = {
      provider: "anthropic" as const,
      ready: true,
      async dispatch(model: string, prompt: string) {
        return { text: `stub:${prompt}`, model, provider: "anthropic", raw: {} };
      },
    };
    const result = await runDispatchTick(config, { anthropic: stub });
    expect(result.dispatched).toBeGreaterThanOrEqual(1);

    // The alert marker for the current daily window must now exist.
    const windowStart = windowBounds("daily", new Date()).start.toISOString();
    const probe = new TaskStore({ dbPath });
    expect(probe.hasBudgetAlert("daily", windowStart, 0.0001)).toBe(true);
    probe.close();
  });
});
