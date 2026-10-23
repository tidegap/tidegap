/**
 * The job sweep (U3, KTD2 and KTD9): one live occurrence per active job,
 * outcomes, one retry per slot, auto-pause after three failed slots, skips,
 * catch-up, interrupted runs and the stop-flag-first rule.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { JOB_INTERRUPTED_ERROR, pauseJob, prepareTick, resumeJob, sweepJobs, TaskActionError } from "../src/index.js";
import type { TaskRecord } from "../src/index.js";
import { DAY, H, MIN, T0, at, harness, job, live, llm, type Harness } from "./jobs-harness.js";

describe("job sweep", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });
  afterEach(() => h.done());

  /** Expedite the job's pending occurrence and tick it with `adapter`. */
  async function runPending(jobId: string, adapter = llm()): Promise<TaskRecord<unknown>> {
    const id = h.store.getJob(jobId)!.pendingTaskId!;
    h.s.runNow(id);
    await h.s.tick({ anthropic: adapter });
    return h.store.get(id)!;
  }

  it("sweeping twice with no change keeps exactly one live occurrence", async () => {
    const j = await job(h.s);
    await sweepJobs(h.s);
    const second = await sweepJobs(h.s);
    expect(second.materialized).toEqual([]);
    expect(live(h.store, j.jobId).map((t) => t.taskId)).toEqual([`${j.jobId}~1`]);
  });

  it("a completed occurrence gets <job>~2 and last_outcome ok, and no series successor", async () => {
    const j = await job(h.s);
    expect((await runPending(j.jobId)).status).toBe("completed");
    const result = await sweepJobs(h.s);
    expect(result.materialized).toEqual([`${j.jobId}~2`]);
    expect(h.store.getJob(j.jobId)).toMatchObject({
      lastOutcome: "ok",
      lastTaskId: `${j.jobId}~1`,
      pendingTaskId: `${j.jobId}~2`,
      lastRunStartedAt: new Date(T0).toISOString(),
    });
    expect(h.store.list().map((t) => t.taskId).sort()).toEqual([`${j.jobId}~1`, `${j.jobId}~2`]);
    // Run-anchored: due 12 h to 24 h after the run.
    expect(h.store.get(`${j.jobId}~2`)).toMatchObject({
      notBefore: new Date(T0 + 12 * H).toISOString(),
      deadline: new Date(T0 + DAY).toISOString(),
    });
  });

  it("covers AE4: an occurrence overdue by 14 h runs once; one successor anchored to that run", async () => {
    const j = await job(h.s);
    at(T0 + DAY + 14 * H); // the machine slept past the deadline
    const prep = await prepareTick(h.s, { quotaConfig: {} });
    expect(prep.join("\n")).not.toContain("materialized");
    const result = await h.s.tick({ anthropic: llm() });
    expect(result.dispatched).toBe(1);
    await sweepJobs(h.s);
    const rows = live(h.store, j.jobId);
    expect(rows.map((t) => t.taskId)).toEqual([`${j.jobId}~2`]);
    expect(rows[0]!.notBefore).toBe(new Date(T0 + DAY + 14 * H + 12 * H).toISOString());
  });

  it("covers AE9: while an occurrence runs, the sweep makes nothing even when its next window opens", async () => {
    // A long run: caps big enough that it does not count as interrupted.
    const j = await job(h.s, { window: { start: "00:00", end: "08:00" }, caps: { llmTimeoutMs: DAY } });
    at(Date.parse("2026-10-21T07:00:00.000Z"));
    let release!: () => void;
    h.s.runNow(`${j.jobId}~1`);
    const tick = h.s.tick({ anthropic: llm({ gate: new Promise<void>((r) => (release = r)) }) });
    await new Promise((r) => setTimeout(r, 10));
    at(Date.parse("2026-10-22T00:30:00.000Z")); // the next slot opened
    expect((await sweepJobs(h.s)).materialized).toEqual([]);
    release();
    await tick;
    expect((await sweepJobs(h.s)).materialized).toEqual([`${j.jobId}~2`]);
  });

  it("a failure with 5 h left retries once after 30 min; a second failure counts and moves on", async () => {
    const j = await job(h.s, { deadline: new Date(T0 + 5 * H) });
    await runPending(j.jobId, llm({ fail: "boom" }));
    const first = await sweepJobs(h.s);
    expect(first.retried).toEqual([`${j.jobId}~1r`]);
    expect(h.store.get(`${j.jobId}~1r`)).toMatchObject({
      notBefore: new Date(T0 + 30 * MIN).toISOString(),
      deadline: new Date(T0 + 5 * H).toISOString(),
    });
    expect(h.store.getJob(j.jobId)).toMatchObject({ consecutiveFailures: 0, retryUsed: true, lastOutcome: "failed" });
    at(T0 + 40 * MIN);
    await runPending(j.jobId, llm({ fail: "boom" }));
    const second = await sweepJobs(h.s);
    expect(second.retried).toEqual([]);
    expect(second.materialized).toEqual([`${j.jobId}~2`]);
    expect(h.store.getJob(j.jobId)).toMatchObject({ consecutiveFailures: 1, retryUsed: false });
  });

  it("a failure with 10 min left is not retried and counts", async () => {
    const j = await job(h.s, { deadline: new Date(T0 + 10 * MIN) });
    await runPending(j.jobId, llm({ fail: "boom" }));
    const result = await sweepJobs(h.s);
    expect(result.retried).toEqual([]);
    expect(h.store.getJob(j.jobId)).toMatchObject({ consecutiveFailures: 1, pendingTaskId: `${j.jobId}~2` });
  });

  it("a retry at 07:45 in a 00:00-08:00 slot keeps the 08:00 deadline", async () => {
    const j = await job(h.s, { window: { start: "00:00", end: "08:00" } });
    at(Date.parse("2026-10-21T07:15:00.000Z"));
    await runPending(j.jobId, llm({ fail: "boom" }));
    await sweepJobs(h.s);
    expect(h.store.get(`${j.jobId}~1r`)).toMatchObject({
      notBefore: "2026-10-21T07:45:00.000Z",
      deadline: "2026-10-21T08:00:00.000Z",
    });
  });

  it("covers AE8: three failed slots in a row pause the job with the first error line", async () => {
    const j = await job(h.s);
    let now = T0;
    for (let slot = 1; slot <= 3; slot++) {
      // Fail each slot 10 min before its deadline, so no retry fits.
      now = Date.parse(h.store.get(h.store.getJob(j.jobId)!.pendingTaskId!)!.deadline!) - 10 * MIN;
      at(now);
      await runPending(j.jobId, llm({ fail: "mailbox locked\n    at fetch (imap.js:1)" }));
      const result = await sweepJobs(h.s);
      expect(result.autoPaused).toEqual(slot === 3 ? [j.jobId] : []);
    }
    expect(h.store.getJob(j.jobId)).toMatchObject({
      status: "paused",
      pauseReason: "auto: mailbox locked",
      pausedAt: new Date(now).toISOString(),
      pauseNotifiedAt: undefined,
      consecutiveFailures: 3,
      pendingTaskId: undefined,
    });
    expect(live(h.store, j.jobId)).toEqual([]);
  });

  it("a usage-limit deferral puts the occurrence back and does not count", async () => {
    const j = await job(h.s);
    const row = await runPending(j.jobId, llm({ defer: new Date(T0 + 2 * H) }));
    expect(row.status).toBe("scheduled");
    expect((await sweepJobs(h.s)).materialized).toEqual([]);
    expect(h.store.getJob(j.jobId)).toMatchObject({ consecutiveFailures: 0, pendingTaskId: `${j.jobId}~1` });
  });

  it("a skip (plain cancel) materializes the successor, keeps the counter and moves the deadline later", async () => {
    const j = await job(h.s);
    h.s.cancelTask(`${j.jobId}~1`);
    await sweepJobs(h.s);
    expect(h.store.getJob(j.jobId)).toMatchObject({ lastOutcome: "skipped", consecutiveFailures: 0 });
    const second = h.store.get(`${j.jobId}~2`)!;
    expect(Date.parse(second.deadline!)).toBeGreaterThan(Date.parse(h.store.get(`${j.jobId}~1`)!.deadline!));
    h.s.cancelTask(`${j.jobId}~2`);
    await sweepJobs(h.s);
    expect(Date.parse(h.store.get(`${j.jobId}~3`)!.deadline!)).toBeGreaterThan(Date.parse(second.deadline!));
  });

  it("a running occurrence older than its caps fails as interrupted and gets a retry", async () => {
    const j = await job(h.s);
    const id = `${j.jobId}~1`;
    expect(h.store.claimScheduled(id)).toBe(true);
    h.store.recordEvent(id, { kind: "dispatched", actor: "tick" });
    at(T0 + 19 * MIN); // caps 5 + 10 min, plus 5 min grace: not yet
    expect((await sweepJobs(h.s)).interrupted).toEqual([]);
    at(T0 + 21 * MIN);
    const result = await sweepJobs(h.s);
    expect(result.interrupted).toEqual([id]);
    expect(h.store.get(id)).toMatchObject({ status: "failed", error: JOB_INTERRUPTED_ERROR });
    expect(result.retried).toEqual([`${id}r`]);
  });

  it("a Batch row being polled keeps its old submit event and is not failed as interrupted before its deadline", async () => {
    const j = await job(h.s, { deadline: new Date(T0 + 3 * DAY) });
    const id = `${j.jobId}~1`;
    h.store.recordEvent(id, { kind: "dispatched", actor: "tick", details: { batch_id: "b1" } });
    expect(h.store.claimScheduled(id)).toBe(true);
    // The poll claims submitted -> running and writes no new event.
    expect(h.store.transitionIf({ ...h.store.get(id)!, batchId: "b1" }, ["running"])).toBe(true);
    at(T0 + DAY);
    expect((await sweepJobs(h.s)).interrupted).toEqual([]);
    at(T0 + 3 * DAY + 21 * MIN);
    expect((await sweepJobs(h.s)).interrupted).toEqual([id]);
  });

  it("a running row with no dispatched event (the tick died in the claim) fails as interrupted after its deadline", async () => {
    const j = await job(h.s);
    const id = `${j.jobId}~1`;
    expect(h.store.claimScheduled(id)).toBe(true);
    at(T0 + DAY + 19 * MIN);
    expect((await sweepJobs(h.s)).interrupted).toEqual([]);
    at(T0 + DAY + 21 * MIN);
    expect((await sweepJobs(h.s)).interrupted).toEqual([id]);
    expect(h.store.get(id)).toMatchObject({ status: "failed", error: JOB_INTERRUPTED_ERROR });
  });

  it("a second pending occurrence next to the tracked one is cancelled as a duplicate", async () => {
    const j = await job(h.s);
    await h.s.materializeOccurrence(
      {
        taskId: `${j.jobId}~9`,
        jobId: j.jobId,
        earliest: new Date(T0).toISOString(),
        deadline: new Date(T0 + DAY).toISOString(),
        title: j.title,
        bodyJson: h.store.get(`${j.jobId}~1`)!.bodyJson!,
      },
      { job_id: j.jobId, seq: 9, anchor: "run" },
    );
    await sweepJobs(h.s);
    expect(live(h.store, j.jobId).map((t) => t.taskId)).toEqual([`${j.jobId}~1`]);
    expect(h.store.get(`${j.jobId}~9`)!.status).toBe("cancelled");
    expect(h.s.listTaskEvents(`${j.jobId}~9`).at(-1)!.details).toMatchObject({ reason: "duplicate" });
  });

  it("a calendar job's successor is the next local slot after the run", async () => {
    const j = await job(h.s, { window: { start: "00:00", end: "08:00" } });
    at(Date.parse("2026-10-21T03:00:00.000Z"));
    expect((await runPending(j.jobId)).status).toBe("completed");
    await sweepJobs(h.s);
    expect(h.store.get(`${j.jobId}~2`)).toMatchObject({
      notBefore: "2026-10-22T00:00:00.000Z",
      deadline: "2026-10-22T08:00:00.000Z",
    });
  });

  it("a run-now occurrence that fails before dispatch late in its slot moves on to the next slot", async () => {
    const j = await job(h.s, { window: { start: "00:00", end: "08:00" } });
    at(Date.parse("2026-10-21T07:45:00.000Z")); // 15 min left: no retry
    const id = `${j.jobId}~1`;
    h.s.runNow(id); // clears notBefore
    expect(h.store.transitionIf({ ...h.store.get(id)!, status: "failed", error: "no adapter" }, ["scheduled"])).toBe(true);
    await sweepJobs(h.s);
    expect(h.store.get(`${j.jobId}~2`)).toMatchObject({
      notBefore: "2026-10-22T00:00:00.000Z",
      deadline: "2026-10-22T08:00:00.000Z",
    });
  });

  it("resume inside a calendar slot the job already ran in waits for the next slot", async () => {
    const j = await job(h.s, { window: { start: "10:00", end: "20:00" } });
    expect((await runPending(j.jobId)).status).toBe("completed"); // ran at 12:00 in today's slot
    await sweepJobs(h.s);
    at(T0 + H);
    await pauseJob(h.s, j.jobId);
    at(T0 + 2 * H);
    await resumeJob(h.s, j.jobId);
    const rows = live(h.store, j.jobId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ notBefore: "2026-10-21T10:00:00.000Z", deadline: "2026-10-21T20:00:00.000Z" });
  });

  it("retryTask refuses a job occurrence: the job retries failed runs itself", async () => {
    const j = await job(h.s);
    await runPending(j.jobId, llm({ fail: "boom" }));
    await sweepJobs(h.s);
    await expect(h.s.retryTask(`${j.jobId}~1`, { anthropic: llm() })).rejects.toBeInstanceOf(TaskActionError);
    expect(h.store.get(`${j.jobId}~1`)!.status).toBe("failed");
  });

  it("a sweep whose insert crosses a pause cancels its own insert (stop flag first)", async () => {
    const j = await job(h.s);
    h.s.cancelTask(`${j.jobId}~1`); // skipped: the next sweep inserts ~2
    const insert = h.store.insertIfAbsent.bind(h.store);
    h.store.insertIfAbsent = (record, event) => {
      const inserted = insert(record, event);
      // Another process pauses the job right after the insert.
      const current = h.store.getJob(j.jobId)!;
      h.store.updateJobIf({ ...current, status: "paused", pauseReason: "manual" }, current.revision);
      h.store.insertIfAbsent = insert;
      return inserted;
    };
    await sweepJobs(h.s);
    expect(h.store.get(`${j.jobId}~2`)!.status).toBe("cancelled");
    expect(live(h.store, j.jobId)).toEqual([]);
    expect(h.store.getJob(j.jobId)!.status).toBe("paused");
  });

  it("an occurrence inserted without its job write is adopted, not duplicated", async () => {
    const j = await job(h.s);
    h.s.cancelTask(`${j.jobId}~1`);
    // A crash between the insert and the job write left ~2 untracked.
    await h.s.materializeOccurrence(
      {
        taskId: `${j.jobId}~2`,
        jobId: j.jobId,
        earliest: new Date(T0).toISOString(),
        deadline: new Date(T0 + DAY).toISOString(),
        title: j.title,
        bodyJson: h.store.get(`${j.jobId}~1`)!.bodyJson!,
      },
      { job_id: j.jobId, seq: 2, anchor: "run" },
    );
    await sweepJobs(h.s);
    expect(live(h.store, j.jobId).map((t) => t.taskId)).toEqual([`${j.jobId}~2`]);
    expect(h.store.getJob(j.jobId)).toMatchObject({ pendingTaskId: `${j.jobId}~2`, nextSeq: 3 });
  });

  it("a paused job's running occurrence finishes with no successor", async () => {
    const j = await job(h.s);
    let release!: () => void;
    h.s.runNow(`${j.jobId}~1`);
    const tick = h.s.tick({ anthropic: llm({ gate: new Promise<void>((r) => (release = r)) }) });
    await new Promise((r) => setTimeout(r, 10));
    await pauseJob(h.s, j.jobId);
    release();
    await tick;
    await sweepJobs(h.s);
    expect(h.store.getJob(j.jobId)).toMatchObject({ status: "paused", lastOutcome: "ok", pendingTaskId: undefined });
    expect(live(h.store, j.jobId)).toEqual([]);
  });
});

describe("prepareTick", () => {
  it("runs the job sweep and the quota sweep; a throwing job sweep is logged and the quota sweep still runs", async () => {
    const h = harness();
    try {
      await h.s.enqueueProviderCall(
        { type: "provider_call", provider: "anthropic", model: "claude-sonnet-5", prompt: "weekly report" },
        { deadline: new Date(T0 + 6 * H), deadlineKind: "quota_reset", quotaProvider: "claude" },
      );
      const j = await job(h.s);
      h.s.cancelTask(`${j.jobId}~1`);
      const ok = await prepareTick(h.s, { quotaConfig: {} });
      expect(ok).toContain(`materialized job occurrence ${j.jobId}~2`);
      expect(ok.some((m) => m.startsWith('quota provider "claude" is not configured'))).toBe(true);
      h.store.listJobs = () => {
        throw new Error("disk I/O error");
      };
      const broken = await prepareTick(h.s, { quotaConfig: {} });
      expect(broken).toContain("job sweep: cannot read the ledger: disk I/O error");
      expect(broken.some((m) => m.startsWith('quota provider "claude" is not configured'))).toBe(true);
    } finally {
      h.done();
    }
  });
});
