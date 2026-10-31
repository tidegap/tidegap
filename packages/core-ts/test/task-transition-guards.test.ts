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
import type { ProviderAdapter, TaskRecord, TaskStatus } from "../src/index.js";

interface Fixture {
  statuses: TaskStatus[];
  actions: Record<string, { node: string; python: string; accepts: TaskStatus[] }>;
}

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/task-transition-guards.json", import.meta.url), "utf8"),
) as Fixture;

const TASK = "tt:row";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const iso = (deltaMs = 0): string => new Date(Date.now() + deltaMs).toISOString();

/** A provider-call row in `status`, due now, with a deadline 3 h out. */
function row(status: TaskStatus): TaskRecord<unknown> {
  const terminal = status === "completed" || status === "failed" || status === "cancelled";
  return {
    taskId: TASK,
    status,
    enqueuedAt: iso(-10 * MINUTE),
    scheduledFor: iso(-MINUTE),
    region: "DE",
    bodyJson: JSON.stringify({ type: "provider_call", provider: "anthropic", model: "m", prompt: "hi" }),
    deadline: iso(3 * HOUR),
    deadlineKind: "absolute",
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
