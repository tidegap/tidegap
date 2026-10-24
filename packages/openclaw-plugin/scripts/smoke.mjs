#!/usr/bin/env node
/**
 * Dispatcher smoke test for @vitalini/tidegap.
 *
 * Schedules a provider-call task, forces its window into the past, runs
 * one Scheduler.tick with a stub adapter, and confirms the task does NOT
 * stay `scheduled` after it is due. Also checks cross-instance cancel.
 *
 * Exercises @tidegap/core through Node's built-in node:sqlite — there is
 * no better-sqlite3 build step. Run with: `pnpm --filter @vitalini/tidegap smoke`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mockGridFeed, Scheduler, TaskStore } from "@tidegap/core";

const tmp = mkdtempSync(join(tmpdir(), "tidegap-smoke-"));
const dbPath = join(tmp, "queue.db");
// Also on an unexpected throw, not only on the pass and fail paths.
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));

function fail(msg) {
  console.error(`✖ SMOKE FAIL: ${msg}`);
  rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
}

const stubAdapter = {
  provider: "anthropic",
  ready: true,
  async dispatch(model, prompt) {
    return { text: `stub-reply: ${prompt}`, model, provider: "anthropic", raw: {} };
  },
};

try {
  const store = new TaskStore({ dbPath });
  const scheduler = new Scheduler({ store, feed: mockGridFeed() });

  // 1. schedule a deferred provider-call task
  const rec = await scheduler.enqueueProviderCall(
    {
      type: "provider_call",
      provider: "anthropic",
      model: "claude-sonnet-5",
      prompt: "smoke-test prompt",
    },
    { deadline: new Date(Date.now() + 6 * 3600_000), region: "GB" },
  );
  console.log(`· scheduled ${rec.taskId} (status=${rec.status})`);
  if (rec.status !== "scheduled") fail(`expected status "scheduled", got "${rec.status}"`);

  // 2. force the chosen window into the past — the task is now overdue
  const overdue = store.get(rec.taskId);
  if (!overdue) fail("task was not persisted to the store");
  overdue.status = "scheduled";
  overdue.scheduledFor = new Date(Date.now() - 60_000).toISOString();
  store.upsert(overdue);
  console.log("· forced scheduledFor 60s into the past");

  // 3. a fresh scheduler (== gateway restart) runs one dispatch sweep
  const fresh = new Scheduler({ store, feed: mockGridFeed() });
  const result = await fresh.tick({ anthropic: stubAdapter });
  console.log(
    `· tick: inspected=${result.inspected} dispatched=${result.dispatched} failed=${result.failed}`,
  );

  const final = store.get(rec.taskId);
  console.log(`· final status: ${final?.status}`);
  if (final?.status === "scheduled") {
    fail("task is STILL scheduled after tick — the dispatcher did not pick it up");
  }
  if (final?.status !== "completed") {
    fail(`expected status "completed", got "${final?.status}"`);
  }

  // 4. cross-instance cancel — a fresh scheduler must resolve a persisted task
  const r2 = await scheduler.enqueueProviderCall(
    { type: "provider_call", provider: "anthropic", model: "m", prompt: "cancel me" },
    { deadline: new Date(Date.now() + 6 * 3600_000), region: "GB" },
  );
  const freshCancel = new Scheduler({ store, feed: mockGridFeed() });
  const cancelled = freshCancel.cancelTask(r2.taskId);
  if (cancelled.status !== "cancelled") {
    fail(`cross-instance cancel failed — status is "${cancelled.status}"`);
  }
  console.log(`· cancelled ${r2.taskId} from a fresh scheduler instance`);

  store.close();
  rmSync(tmp, { recursive: true, force: true });
  console.log(
    "✓ SMOKE PASS — schedule → overdue → dispatched → completed; cross-instance cancel works",
  );
} catch (err) {
  fail(err instanceof Error ? (err.stack ?? err.message) : String(err));
}
