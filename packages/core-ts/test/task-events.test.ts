/**
 * Task events (audit trail): the `task_events` table, its transaction with
 * the task write, and one event per scheduler mutation path with the right
 * actor and details.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  commandContextFor,
  formatTaskEvent,
  mockGridFeed,
  normalizeActor,
  ProviderDeferError,
  Scheduler,
  TaskStore,
} from "../src/index.js";
import type { ProviderAdapter, TaskEvent } from "../src/index.js";

const H = 3_600_000;
const SPEC = {
  type: "provider_call" as const,
  provider: "anthropic" as const,
  model: "claude-sonnet-4-6",
  prompt: "Summarise the log",
};

function adapter(opts: { fail?: Error; batch?: boolean } = {}): ProviderAdapter {
  const a: ProviderAdapter = {
    provider: "anthropic",
    ready: true,
    async dispatch(model, prompt) {
      if (opts.fail) throw opts.fail;
      return { text: `ok ${prompt}`, model, provider: "anthropic", raw: null };
    },
  };
  if (opts.batch) {
    a.dispatchBatch = async (_m, prompts) => ({ batchId: "b-1", provider: "anthropic", size: prompts.length });
    a.retrieveBatch = async () => ({ status: "in_progress" });
  }
  return a;
}

describe("task events", () => {
  let dir: string;
  let dbPath: string;
  const open: Array<{ shutdown?: () => void; close?: () => void }> = [];

  function sched(actor?: string): Scheduler {
    const s = new Scheduler({ dbPath, feed: mockGridFeed(), signing: false, rng: () => 0, ...(actor ? { actor } : {}) });
    open.push(s);
    return s;
  }
  function store(): TaskStore {
    const s = new TaskStore({ dbPath });
    open.push(s);
    return s;
  }
  function events(taskId: string): TaskEvent[] {
    return store().listTaskEvents(taskId);
  }
  /** The events written since `n` were seen. */
  function after(taskId: string, n: number): TaskEvent[] {
    return events(taskId).slice(n);
  }
  async function enqueue(s: Scheduler, extra: Record<string, unknown> = {}) {
    return s.enqueueProviderCall(SPEC, { deadline: new Date(Date.now() + 6 * H), region: "DE", ...extra });
  }
  /** Make the stored row due now, without an event. */
  function makeDue(taskId: string): void {
    const st = store();
    st.upsert({ ...st.get(taskId)!, scheduledFor: new Date(Date.now() - 60_000).toISOString() });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-events-"));
    dbPath = join(dir, "queue.db");
  });

  afterEach(() => {
    for (const o of open.splice(0)) {
      o.shutdown?.();
      o.close?.();
    }
    rmSync(dir, { recursive: true, force: true });
  });

  describe("store", () => {
    it("creates the table and index; events of a deleted task go with it", async () => {
      const s = sched("cli");
      const rec = await enqueue(s);
      expect(events(rec.taskId).map((e) => e.kind)).toEqual(["created"]);
      const req = createRequire(import.meta.url);
      const { DatabaseSync } = req("node:sqlite") as { DatabaseSync: new (p: string) => { prepare(sql: string): { all(...a: unknown[]): unknown[]; run(...a: unknown[]): unknown }; close(): void } };
      const db = new DatabaseSync(dbPath);
      const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'task_events'`).all();
      expect(idx).toEqual([{ name: "task_events_task_idx" }]);
      db.prepare(`DELETE FROM tasks WHERE task_id = ?`).run(rec.taskId);
      expect(db.prepare(`SELECT COUNT(*) AS n FROM task_events WHERE task_id = ?`).all(rec.taskId)).toEqual([{ n: 0 }]);
      db.close();
    });

    it("a compare-and-set miss writes no event; a hit writes one", async () => {
      const s = sched();
      const rec = await enqueue(s);
      const st = store();
      const row = st.get(rec.taskId)!;
      expect(st.transitionIf({ ...row, status: "cancelled" }, ["running"], undefined, { kind: "cancelled" })).toBe(false);
      expect(events(rec.taskId)).toHaveLength(1);
      expect(st.transitionIf({ ...row, status: "cancelled" }, ["scheduled"], undefined, { kind: "cancelled", actor: "cli" })).toBe(true);
      expect(after(rec.taskId, 1).map((e) => [e.kind, e.actor])).toEqual([["cancelled", "cli"]]);
    });

    it("a failing event insert rolls back the task write", async () => {
      const s = sched();
      const rec = await enqueue(s);
      const st = store();
      const row = st.get(rec.taskId)!;
      const spy = (st as unknown as { insertEvent: (...a: unknown[]) => void });
      const orig = spy.insertEvent.bind(st);
      spy.insertEvent = () => {
        throw new Error("insert failed");
      };
      expect(() => st.transitionIf({ ...row, status: "cancelled" }, ["scheduled"], undefined, { kind: "cancelled" })).toThrow("insert failed");
      spy.insertEvent = orig;
      expect(st.get(rec.taskId)?.status).toBe("scheduled");
    });

    it("limit keeps the newest rows, oldest first; unknown actors read as system", async () => {
      const st = store();
      const s = sched();
      const rec = await enqueue(s);
      for (let i = 0; i < 5; i++) st.recordEvent(rec.taskId, { kind: "replied", actor: "bogus", details: { child_task_id: `c${i}` } });
      const last = st.listTaskEvents(rec.taskId, { limit: 3 });
      expect(last.map((e) => e.details.child_task_id)).toEqual(["c2", "c3", "c4"]);
      expect(last.every((e) => e.actor === "system")).toBe(true);
    });

    it("normalizes actors", () => {
      expect(normalizeActor("page")).toBe("page");
      expect(normalizeActor("client:Mac\u0007 app")).toBe("client:Mac app");
      expect(normalizeActor(`agent:${"x".repeat(100)}`)).toBe(`agent:${"x".repeat(64)}`);
      expect(normalizeActor("client:")).toBe("system");
      expect(normalizeActor("root")).toBe("system");
    });

    it("reads a row written with the Python core's INSERT", async () => {
      const s = sched();
      const rec = await enqueue(s);
      const req = createRequire(import.meta.url);
      const { DatabaseSync } = req("node:sqlite") as { DatabaseSync: new (p: string) => { prepare(sql: string): { run(...a: unknown[]): unknown }; close(): void } };
      const db = new DatabaseSync(dbPath);
      // Same statement as `_insert_event` in packages/core-py/src/tidegap/scheduler.py.
      db.prepare("INSERT INTO task_events (task_id, at, kind, actor, details) VALUES (?, ?, ?, ?, ?)").run(
        rec.taskId,
        "2026-10-17T12:00:00.000000+00:00",
        "dispatched",
        "tick",
        JSON.stringify({ provider: "anthropic", model: "claude-sonnet-4-6" }),
      );
      db.close();
      const last = events(rec.taskId).find((e) => e.kind === "dispatched")!;
      expect(last).toMatchObject({ kind: "dispatched", actor: "tick", details: { provider: "anthropic" } });
    });
  });

  describe("scheduler paths", () => {
    it("enqueueProviderCall records created with the per-call actor and provider/model", async () => {
      const rec = await enqueue(sched("cli"), { actor: "page" });
      const [e] = events(rec.taskId);
      expect(e).toMatchObject({ kind: "created", actor: "page", details: { provider: "anthropic", model: "claude-sonnet-4-6" } });
      expect(e!.details.deadline).toBe(store().get(rec.taskId)!.deadline);
    });

    it("enqueue (closure) records created with the scheduler actor", () => {
      const s = new Scheduler({ dbPath, feed: mockGridFeed(), signing: false, eager: false, actor: "agent:mcp" });
      open.push(s);
      const rec = s.enqueue(async () => 1, { deadline: new Date(Date.now() + 6 * H) });
      expect(events(rec.taskId).map((e) => [e.kind, e.actor])).toEqual([["created", "agent:mcp"]]);
    });

    it("runNow records expedited with the old not_before (regression: run-now-clears-not-before)", async () => {
      const s = sched("cli");
      const notBefore = new Date(Date.now() + 30 * H).toISOString();
      const rec = await s.enqueueProviderCall(SPEC, { deadline: new Date(Date.now() + 60 * H), notBefore, region: "DE" });
      const before = store().get(rec.taskId)!;
      expect(before.notBefore).toBe(notBefore);
      const n = events(rec.taskId).length;
      s.runNow(rec.taskId, { actor: "page" });
      const evs = after(rec.taskId, n);
      expect(evs).toHaveLength(1);
      expect(evs[0]).toMatchObject({
        kind: "expedited",
        actor: "page",
        details: { from: { not_before: notBefore, scheduled_for: before.scheduledFor }, to: { not_before: null } },
      });
      expect(formatTaskEvent(evs[0]!)).toContain(`not_before was ${notBefore}`);
    });

    it("a refused runNow records nothing", async () => {
      const s = sched();
      const rec = await enqueue(s);
      store().claimScheduled(rec.taskId);
      const n = events(rec.taskId).length;
      expect(() => s.runNow(rec.taskId)).toThrow();
      expect(after(rec.taskId, n)).toEqual([]);
    });

    it("cancelTask records cancelled; series cancel records series: true", async () => {
      const s = sched("cli");
      const rec = await enqueue(s, { repeat: "weekly" });
      const n = events(rec.taskId).length;
      s.cancelTask(rec.taskId, { series: true, actor: "telegram" });
      expect(after(rec.taskId, n)).toMatchObject([{ kind: "cancelled", actor: "telegram", details: { series: true } }]);
    });

    it("cancel as a skip records cancelled on the occurrence and created (system) on the successor", async () => {
      const s = sched("cli");
      const rec = await enqueue(s, { repeat: "weekly" });
      const n = events(rec.taskId).length;
      s.cancelTask(rec.taskId);
      expect(after(rec.taskId, n).map((e) => [e.kind, e.actor])).toEqual([["cancelled", "cli"]]);
      const successor = store().list({ seriesId: rec.seriesId! }).find((r) => r.taskId !== rec.taskId)!;
      expect(events(successor.taskId)).toMatchObject([
        { kind: "created", actor: "system", details: { series_id: rec.seriesId, previous_task_id: rec.taskId } },
      ]);
    });

    it("rescheduleTask records rescheduled with from/to timing", async () => {
      const s = sched("cli");
      const rec = await enqueue(s);
      const before = store().get(rec.taskId)!;
      const n = events(rec.taskId).length;
      const at = new Date(Date.now() + 3 * H);
      await s.rescheduleTask(rec.taskId, { at });
      expect(after(rec.taskId, n)).toMatchObject([
        {
          kind: "rescheduled",
          actor: "cli",
          details: { from: { scheduled_for: before.scheduledFor }, to: { scheduled_for: at.toISOString(), not_before: at.toISOString() } },
        },
      ]);
    });

    it("rescheduleTask through the window picker (deadline) records one rescheduled", async () => {
      const s = sched();
      const rec = await enqueue(s);
      const n = events(rec.taskId).length;
      await s.rescheduleTask(rec.taskId, { deadline: new Date(Date.now() + 12 * H) }, { actor: "client:Mac" });
      const evs = after(rec.taskId, n);
      expect(evs.map((e) => [e.kind, e.actor])).toEqual([["rescheduled", "client:Mac"]]);
      expect((evs[0]!.details.to as { deadline: string }).deadline).toBe(store().get(rec.taskId)!.deadline);
    });

    it("postponeTask records postponed with the preset", async () => {
      const s = sched();
      const rec = await enqueue(s);
      const n = events(rec.taskId).length;
      await s.postponeTask(rec.taskId, { delayMs: 2 * H }, { actor: "telegram" });
      expect(after(rec.taskId, n).map((e) => [e.kind, e.actor])).toEqual([["postponed", "telegram"]]);
      const m = events(rec.taskId).length;
      await s.postponeTask(rec.taskId, { preset: "tomorrow_morning" });
      expect(after(rec.taskId, m)).toMatchObject([{ kind: "postponed", details: { preset: "tomorrow_morning" } }]);
    });

    it("updateDeadline and rescheduleIfPending record rescheduled with a reason", async () => {
      const s = sched("agent:mcp");
      const rec = await enqueue(s);
      const n = events(rec.taskId).length;
      await s.updateDeadline(rec.taskId, new Date(Date.now() + 10 * H));
      await s.rescheduleIfPending(rec.taskId, new Date(Date.now() + 11 * H));
      expect(after(rec.taskId, n).map((e) => [e.kind, e.actor, e.details.reason])).toEqual([
        ["rescheduled", "agent:mcp", "deadline"],
        ["rescheduled", "system", "quota_sweep"],
      ]);
    });

    it("tick dispatch records dispatched then completed, actor tick", async () => {
      const rec = await enqueue(sched("cli"));
      makeDue(rec.taskId);
      const n = events(rec.taskId).length;
      await sched("tick").tick({ anthropic: adapter() });
      expect(after(rec.taskId, n)).toMatchObject([
        { kind: "dispatched", actor: "tick", details: { provider: "anthropic", model: "claude-sonnet-4-6" } },
        { kind: "completed", actor: "tick", details: { provider: "anthropic" } },
      ]);
    });

    it("a failed dispatch records dispatched then failed with the error", async () => {
      const rec = await enqueue(sched());
      makeDue(rec.taskId);
      const n = events(rec.taskId).length;
      await sched("tick").tick({ anthropic: adapter({ fail: Object.assign(new Error("bad request\nmore"), { status: 400 }) }) });
      expect(after(rec.taskId, n)).toMatchObject([
        { kind: "dispatched" },
        { kind: "failed", actor: "tick", details: { error: "bad request" } },
      ]);
    });

    it("a missing adapter records one failed (no dispatched)", async () => {
      const rec = await enqueue(sched());
      makeDue(rec.taskId);
      const n = events(rec.taskId).length;
      await sched("tick").tick({});
      expect(after(rec.taskId, n).map((e) => e.kind)).toEqual(["failed"]);
    });

    it("a limit deferral (claude-code) records dispatched then deferred with retry_at", async () => {
      const rec = await enqueue(sched());
      makeDue(rec.taskId);
      const n = events(rec.taskId).length;
      const retryAt = new Date(Date.now() + 2 * H);
      await sched("tick").tick({ anthropic: adapter({ fail: new ProviderDeferError("limit reached", retryAt) }) });
      expect(after(rec.taskId, n)).toMatchObject([
        { kind: "dispatched" },
        { kind: "deferred", actor: "tick", details: { retry_at: retryAt.toISOString(), reason: "limit reached" } },
      ]);
    });

    it("batch submit records dispatched with the batch id; a released claim records nothing", async () => {
      const s = sched();
      const rec = await s.enqueueProviderCall(SPEC, { deadline: new Date(Date.now() + 72 * H), region: "DE" });
      const n = events(rec.taskId).length;
      await sched("tick").tick({ anthropic: adapter({ batch: true }) });
      expect(after(rec.taskId, n)).toMatchObject([{ kind: "dispatched", details: { batch_id: "b-1" } }]);

      const later = await enqueue(s);
      const st = store();
      st.upsert({ ...st.get(later.taskId)!, scheduledFor: new Date(Date.now() + 5 * H).toISOString() });
      const m = events(later.taskId).length;
      await sched("tick").tick({ anthropic: adapter() });
      expect(after(later.taskId, m)).toEqual([]);
    });

    it("expediteTask records expedited then dispatched and completed", async () => {
      const s = sched("openclaw");
      const rec = await enqueue(s);
      const n = events(rec.taskId).length;
      await s.expediteTask(rec.taskId, { anthropic: adapter() });
      expect(after(rec.taskId, n).map((e) => [e.kind, e.actor])).toEqual([
        ["expedited", "openclaw"],
        ["dispatched", "openclaw"],
        ["completed", "openclaw"],
      ]);
    });

    it("retryTask records rescheduled (reason retry) then dispatched and completed", async () => {
      const s = sched("agent:mcp");
      const rec = await enqueue(s);
      makeDue(rec.taskId);
      await s.tick({ anthropic: adapter({ fail: Object.assign(new Error("400"), { status: 400 }) }) });
      const n = events(rec.taskId).length;
      await s.retryTask(rec.taskId, { anthropic: adapter() });
      expect(after(rec.taskId, n).map((e) => [e.kind, e.details.reason])).toEqual([
        ["rescheduled", "retry"],
        ["dispatched", undefined],
        ["completed", undefined],
      ]);
    });

    it("replyToTask records replied on the parent and created with parent_task_id on the child", async () => {
      const s = sched();
      const rec = await enqueue(s);
      s.runNow(rec.taskId);
      await s.tick({ anthropic: adapter() });
      const n = events(rec.taskId).length;
      const child = await s.replyToTask(rec.taskId, "more please", { actor: "page" });
      expect(after(rec.taskId, n)).toMatchObject([{ kind: "replied", actor: "page", details: { child_task_id: child.taskId } }]);
      expect(events(child.taskId)).toMatchObject([{ kind: "created", actor: "page", details: { parent_task_id: rec.taskId } }]);
    });

    it("Telegram commands record actor telegram", async () => {
      const s = sched("system");
      const rec = await enqueue(s);
      const other = await enqueue(s);
      const ctx = commandContextFor(s, store());
      ctx.runNow(rec.taskId);
      ctx.cancel(other.taskId);
      expect(events(rec.taskId).at(-1)).toMatchObject({ kind: "expedited", actor: "telegram" });
      expect(events(other.taskId).at(-1)).toMatchObject({ kind: "cancelled", actor: "telegram" });
    });

    it("a closure task records created, dispatched, completed", async () => {
      const s = new Scheduler({ dbPath, feed: mockGridFeed(), signing: false, actor: "cli" });
      open.push(s);
      const value = await s.defer(async () => 42, { deadline: new Date(Date.now() + 60_000) });
      expect(value).toBe(42);
      const id = store().list()[0]!.taskId;
      expect(events(id).map((e) => e.kind)).toEqual(["created", "dispatched", "completed"]);
    });
  });
});
