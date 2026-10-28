/**
 * The job sweep (U3, KTD2 and KTD9): one live occurrence per active job,
 * outcomes, one retry per slot, auto-pause after three failed slots, skips,
 * catch-up, interrupted runs and the stop-flag-first rule.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  JOB_INTERRUPTED_ERROR,
  JobActionError,
  jobHistory,
  NonRetryableError,
  pauseJob,
  prepareTick,
  resumeJob,
  runJobNow,
  sweepJobs,
  TaskActionError,
  updateJob,
} from "../src/index.js";
import type { ProviderAdapter, TaskRecord } from "../src/index.js";
import { BATCH_SUBMIT_INTERRUPTED_ERROR } from "../src/jobs.js";
import { DAY, H, MIN, PROMPT_JOB, T0, at, harness, job, live, llm, type Harness } from "./jobs-harness.js";

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

  it("a failure after the command step ran is not retried: the retry would run the command again", async () => {
    const j = await job(h.s, { deadline: new Date(T0 + 5 * H) });
    const summarizeFailed: ProviderAdapter = {
      provider: "anthropic",
      ready: true,
      dispatch: async () => {
        throw new NonRetryableError("summarize: boom", { steps: ["command", "prompt"] });
      },
    };
    await runPending(j.jobId, summarizeFailed);
    const result = await sweepJobs(h.s);
    expect(result.retried).toEqual([]);
    expect(h.store.getJob(j.jobId)).toMatchObject({ consecutiveFailures: 1, pendingTaskId: `${j.jobId}~2` });
  });

  it("a job run failed during a Batch submit is not retried and counts toward auto-pause", async () => {
    // The provider may hold a batch for the run: a retry could run it twice.
    const j = await job(h.s, { deadline: new Date(T0 + 3 * DAY) });
    const id = `${j.jobId}~1`;
    expect(h.store.claimScheduled(id)).toBe(true);
    // What a forced stop writes (Scheduler.failHeldRuns, phase batch_submit).
    expect(
      h.store.transitionIf(
        { ...h.store.get(id)!, status: "failed", completedAt: new Date().toISOString(), error: BATCH_SUBMIT_INTERRUPTED_ERROR },
        ["running"],
        undefined,
        { kind: "failed", actor: "tick", details: { reason: "interrupted", phase: "batch_submit", job_id: j.jobId } },
      ),
    ).toBe(true);
    const result = await sweepJobs(h.s);
    expect(result.retried).toEqual([]);
    expect(h.store.getJob(j.jobId)).toMatchObject({ consecutiveFailures: 1, lastOutcome: "failed", pendingTaskId: `${j.jobId}~2` });
    expect(h.store.get(`${j.jobId}~1r`)).toBeUndefined();
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

  it("a run the machine slept through is not interrupted: its age counts on awake time", async () => {
    const j = await job(h.s);
    const id = `${j.jobId}~1`;
    const boot = T0 - DAY;
    expect(h.store.claimScheduled(id)).toBe(true);
    h.store.recordEvent(id, { kind: "dispatched", actor: "tick", details: { sleep: { boot_at: boot, slept_ms: 1_000 } } });
    at(T0 + 8 * H); // the Mac slept for 7 h 58 min of these 8 h
    const asleep = { boot_at: boot, slept_ms: 1_000 + 8 * H - 2 * MIN };
    expect((await sweepJobs(h.s, new Date(), { sleepNow: asleep })).interrupted).toEqual([]);
    expect((await prepareTick(h.s, { quotaConfig: {}, sleepNow: asleep })).join("\n")).not.toContain("interrupted");
    expect(h.store.get(id)!.status).toBe("running");
    // Awake for 21 min of the run: over the caps.
    const awake = { boot_at: boot, slept_ms: 1_000 + 8 * H - 21 * MIN };
    expect((await sweepJobs(h.s, new Date(), { sleepNow: awake })).interrupted).toEqual([id]);
  });

  it("a page or CLI action never fails a running occurrence as interrupted", async () => {
    const j = await job(h.s);
    const id = `${j.jobId}~1`;
    expect(h.store.claimScheduled(id)).toBe(true);
    h.store.recordEvent(id, { kind: "dispatched", actor: "tick" });
    at(T0 + 8 * H);
    await pauseJob(h.s, j.jobId);
    expect(h.store.get(id)!.status).toBe("running");
  });

  it("a job's Batch row a killed tick left running goes back to submitted; the next tick polls it", async () => {
    const j = await job(h.s, { deadline: new Date(T0 + 3 * DAY) });
    const id = `${j.jobId}~1`;
    h.store.recordEvent(id, { kind: "dispatched", actor: "tick", details: { batch_id: "b1" } });
    expect(h.store.claimScheduled(id)).toBe(true);
    // The poll claims submitted -> running and writes no new event.
    expect(h.store.transitionIf({ ...h.store.get(id)!, batchId: "b1" }, ["running"])).toBe(true);
    at(T0 + DAY);
    expect((await sweepJobs(h.s)).interrupted).toEqual([]);
    expect(h.store.get(id)!.status).toBe("running");
    at(T0 + 3 * DAY + 21 * MIN);
    const result = await sweepJobs(h.s);
    expect(result.interrupted).toEqual([]);
    expect(result.messages).toEqual([`job ${j.jobId}: ${id} back to submitted: the tick stopped while it polled the batch`]);
    expect(h.store.get(id)).toMatchObject({ status: "submitted", batchId: "b1" });
    expect(h.store.get(id)!.error).toBeUndefined();
    const polled: string[] = [];
    const batch: ProviderAdapter = {
      ...llm(),
      dispatchBatch: async () => {
        throw new Error("no new batch");
      },
      retrieveBatch: async (batchId) => {
        polled.push(batchId);
        return { status: "completed", results: [{ text: "mail digest", model: "m", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }] };
      },
    };
    await h.s.tick({ anthropic: batch });
    expect(polled).toEqual(["b1"]);
    expect(h.store.get(id)).toMatchObject({ status: "completed", batchId: "b1" });
  });

  it("a running row with no dispatched event (the tick died in the claim) fails as interrupted after its deadline", async () => {
    const j = await job(h.s);
    const id = `${j.jobId}~1`;
    expect(h.store.claimScheduled(id)).toBe(true);
    at(T0 + DAY + 19 * MIN);
    expect((await sweepJobs(h.s)).interrupted).toEqual([]);
    at(T0 + DAY + 21 * MIN);
    const result = await sweepJobs(h.s);
    expect(result.interrupted).toEqual([id]);
    expect(h.store.get(id)).toMatchObject({ status: "failed", error: JOB_INTERRUPTED_ERROR });
    // Past its deadline: no retry run, so a Batch submit a killed tick cut off is not sent again.
    expect(result.retried).toEqual([]);
    expect((await sweepJobs(h.s)).retried).toEqual([]);
    expect(h.store.get(`${j.jobId}~1r`)).toBeUndefined();
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

describe("job sweep and actions under races (follow-ups U1)", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });
  afterEach(() => h.done());

  /** Run `during` right after the next insert, as if another writer landed while the sweep awaits the forecast. */
  function afterNextInsert(during: () => void): void {
    const insert = h.store.insertIfAbsent.bind(h.store);
    h.store.insertIfAbsent = (record, event) => {
      h.store.insertIfAbsent = insert;
      const inserted = insert(record, event);
      during();
      return inserted;
    };
  }

  /** A tick claims `taskId` right after the next read of it, so the reader holds a stale pending copy. */
  function claimAfterNextRead(taskId: string): void {
    const get = h.store.get.bind(h.store);
    h.store.get = (id) => {
      const row = get(id);
      if (id === taskId) {
        h.store.get = get;
        expect(h.store.claimScheduled(taskId)).toBe(true);
      }
      return row;
    };
  }

  const reasonOf = (taskId: string) => h.s.listTaskEvents(taskId).findLast((e) => e.kind === "cancelled")?.details.reason;
  const bodyOf = (taskId: string) => JSON.parse(h.store.get(taskId)!.bodyJson!) as { prompt: string; model: string };

  /** Skip ~1, then edit the job right after the sweep inserts ~2 from the old template. */
  async function editDuringInsert(jobId: string, patch: Parameters<typeof updateJob>[2]): Promise<void> {
    h.s.cancelTask(`${jobId}~1`);
    let edit: Promise<unknown> | undefined;
    afterNextInsert(() => {
      edit = updateJob(h.s, jobId, patch);
    });
    await sweepJobs(h.s);
    await edit;
  }

  /** A crash between the sweep's insert of `taskId` (old template) and its job write left the row untracked. */
  async function crashOrphan(jobId: string, taskId: string, earliest: number, deadline: number, anchor: string): Promise<void> {
    await h.s.materializeOccurrence(
      {
        taskId,
        jobId,
        earliest: new Date(earliest).toISOString(),
        deadline: new Date(deadline).toISOString(),
        title: h.store.getJob(jobId)!.title,
        bodyJson: h.store.get(`${jobId}~1`)!.bodyJson!,
      },
      { job_id: jobId, seq: Number(/~(\d+)/.exec(taskId)![1]), anchor },
    );
  }

  it("an edit that lands after the sweep's insert cancels the stale row as edited; the live row has the new prompt", async () => {
    const j = await job(h.s);
    await editDuringInsert(j.jobId, { template: { ...PROMPT_JOB.template, prompt: "check the new inbox" } });
    expect(h.store.get(`${j.jobId}~2`)!.status).toBe("cancelled");
    expect(reasonOf(`${j.jobId}~2`)).toBe("edited");
    const rows = live(h.store, j.jobId);
    expect(rows).toHaveLength(1);
    expect(bodyOf(rows[0]!.taskId).prompt).toBe("check the new inbox");
    expect(h.store.getJob(j.jobId)!.pendingTaskId).toBe(rows[0]!.taskId);
  });

  it("the same race with a model-only edit cancels the stale row; the live row has the new model", async () => {
    const j = await job(h.s);
    await editDuringInsert(j.jobId, { template: { ...PROMPT_JOB.template, model: "claude-opus-5" } });
    expect(reasonOf(`${j.jobId}~2`)).toBe("edited");
    const rows = live(h.store, j.jobId);
    expect(rows).toHaveLength(1);
    expect(bodyOf(rows[0]!.taskId).model).toBe("claude-opus-5");
  });

  it("the same race with a title-only edit adopts the inserted row", async () => {
    const j = await job(h.s);
    await editDuringInsert(j.jobId, { title: "Inbox digest" });
    expect(live(h.store, j.jobId).map((t) => t.taskId)).toEqual([`${j.jobId}~2`]);
    expect(h.store.getJob(j.jobId)).toMatchObject({ title: "Inbox digest", pendingTaskId: `${j.jobId}~2` });
  });

  it("an edit after a crash left a stale orphan cancels it as edited and makes a live row of the new template at once", async () => {
    const j = await job(h.s);
    h.s.cancelTask(`${j.jobId}~1`);
    await crashOrphan(j.jobId, `${j.jobId}~2`, T0, T0 + DAY, "run");
    const edited = await updateJob(h.s, j.jobId, { template: { ...PROMPT_JOB.template, prompt: "check the new inbox" } });
    expect(reasonOf(`${j.jobId}~2`)).toBe("edited");
    const rows = live(h.store, j.jobId);
    expect(rows.map((t) => t.taskId)).toEqual([`${j.jobId}~3`]);
    expect(bodyOf(`${j.jobId}~3`).prompt).toBe("check the new inbox");
    expect(edited).toMatchObject({ pendingTaskId: `${j.jobId}~3`, nextSeq: 4 });
  });

  it("an edit after a crash left a stale retry orphan makes a regular row of the new template; the failure is not counted", async () => {
    const j = await job(h.s, { deadline: new Date(T0 + 5 * H) });
    h.s.runNow(`${j.jobId}~1`);
    await h.s.tick({ anthropic: llm({ fail: "boom" }) });
    await crashOrphan(j.jobId, `${j.jobId}~1r`, T0 + 30 * MIN, T0 + 5 * H, "retry");
    const edited = await updateJob(h.s, j.jobId, { template: { ...PROMPT_JOB.template, prompt: "check the new inbox" } });
    expect(reasonOf(`${j.jobId}~1r`)).toBe("edited");
    expect(live(h.store, j.jobId).map((t) => t.taskId)).toEqual([`${j.jobId}~2`]);
    expect(bodyOf(`${j.jobId}~2`).prompt).toBe("check the new inbox");
    expect(edited).toMatchObject({ pendingTaskId: `${j.jobId}~2`, nextSeq: 3, retryUsed: false, consecutiveFailures: 0, lastOutcome: "failed" });
  });

  it("a pause that read the row as pending before a tick claimed it leaves the run alone; it completes with no successor", async () => {
    const j = await job(h.s);
    const id = `${j.jobId}~1`;
    claimAfterNextRead(id);
    await pauseJob(h.s, j.jobId);
    expect(h.store.get(id)!.status).toBe("running");
    expect(h.store.transitionIf({ ...h.store.get(id)!, status: "completed", completedAt: new Date().toISOString() }, ["running"])).toBe(true);
    await sweepJobs(h.s);
    expect(h.store.get(id)!.status).toBe("completed");
    expect(h.store.getJob(j.jobId)).toMatchObject({ status: "paused", lastOutcome: "ok", pendingTaskId: undefined });
    expect(live(h.store, j.jobId)).toEqual([]);
  });

  it("the sweep's duplicate cancel never cancels a row a tick claimed between its read and its cancel", async () => {
    const j = await job(h.s);
    const dup = `${j.jobId}~9`;
    await h.s.materializeOccurrence(
      {
        taskId: dup,
        jobId: j.jobId,
        earliest: new Date(T0).toISOString(),
        deadline: new Date(T0 + DAY).toISOString(),
        title: j.title,
        bodyJson: h.store.get(`${j.jobId}~1`)!.bodyJson!,
      },
      { job_id: j.jobId, seq: 9, anchor: "run" },
    );
    claimAfterNextRead(dup);
    await sweepJobs(h.s);
    expect(h.store.get(dup)!.status).toBe("running");
  });

  it.each([
    { last: "removed", row: "cancelled", reason: "removed" },
    { last: "paused", row: "cancelled", reason: "paused" },
    { last: "active", row: "scheduled", reason: undefined },
  ] as const)("a sweep whose three job writes all miss, the last leaving the job $last, leaves its insert $row", async ({ last, row, reason }) => {
    const j = await job(h.s);
    h.s.cancelTask(`${j.jobId}~1`);
    const write = h.store.updateJobIf.bind(h.store);
    let misses = 0;
    h.store.updateJobIf = (next, revision) => {
      // Another writer moves the job before each sweep write; the third time it sets the final status.
      const current = h.store.getJob(j.jobId)!;
      misses++;
      write({ ...current, status: misses === 3 ? last : current.status }, current.revision);
      if (misses === 3) h.store.updateJobIf = write;
      return write(next, revision);
    };
    const result = await sweepJobs(h.s);
    expect(misses).toBe(3);
    expect(result.messages.join("\n")).toContain("kept changing");
    expect(h.store.get(`${j.jobId}~2`)!.status).toBe(row);
    expect(reasonOf(`${j.jobId}~2`)).toBe(reason);
    if (last !== "active") {
      expect(live(h.store, j.jobId)).toEqual([]);
      return;
    }
    // An active job keeps the row: the next sweep adopts it.
    await sweepJobs(h.s);
    expect(live(h.store, j.jobId).map((t) => t.taskId)).toEqual([`${j.jobId}~2`]);
    expect(h.store.getJob(j.jobId)!.pendingTaskId).toBe(`${j.jobId}~2`);
  });

  it("run now right after the third failed slot, before any sweep, gives the auto-pause reason", async () => {
    const j = await job(h.s);
    const current = h.store.getJob(j.jobId)!;
    // Two failed slots already; this slot's retry is spent.
    expect(h.store.updateJobIf({ ...current, consecutiveFailures: 2, retryUsed: true }, current.revision)).toBe(true);
    h.s.runNow(`${j.jobId}~1`);
    await h.s.tick({ anthropic: llm({ fail: "mailbox quota exceeded\nat line 2" }) });
    const refusal = runJobNow(h.s, j.jobId);
    await expect(refusal).rejects.toThrow("job is paused");
    await expect(refusal).rejects.toThrow("mailbox quota exceeded");
    expect(h.store.getJob(j.jobId)!.status).toBe("paused");
  });

  it("updateJob applies with the current expected revision or none; a stale one is refused as stale_revision", async () => {
    const j = await job(h.s);
    const a = await updateJob(h.s, j.jobId, { title: "A" }, { expectedRevision: j.revision });
    expect(a.title).toBe("A");
    expect((await updateJob(h.s, j.jobId, { title: "B" })).title).toBe("B");
    const stale = updateJob(h.s, j.jobId, { title: "C" }, { expectedRevision: j.revision });
    await expect(stale).rejects.toBeInstanceOf(JobActionError);
    await expect(stale).rejects.toMatchObject({ code: "conflict", reason: "stale_revision" });
    expect(h.store.getJob(j.jobId)!.title).toBe("B");
  });

  describe("a host with no sleep reading and a dispatch that carried one", () => {
    const boot = T0 - DAY;
    async function runningWithSleep(): Promise<string> {
      const j = await job(h.s);
      const id = `${j.jobId}~1`;
      expect(h.store.claimScheduled(id)).toBe(true);
      h.store.recordEvent(id, { kind: "dispatched", actor: "tick", details: { sleep: { boot_at: boot, slept_ms: 1_000 } } });
      return id;
    }

    it("keeps the run while the wall age is past the caps but before deadline plus caps", async () => {
      const id = await runningWithSleep();
      at(T0 + 8 * H);
      expect((await sweepJobs(h.s)).interrupted).toEqual([]);
      expect((await sweepJobs(h.s, new Date(), { sleepNow: null })).interrupted).toEqual([]);
      at(T0 + DAY + 19 * MIN); // deadline T0 + 1 day, plus caps 5 + 10 min and 5 min grace
      expect((await sweepJobs(h.s, new Date(), { sleepNow: null })).interrupted).toEqual([]);
      expect(h.store.get(id)!.status).toBe("running");
    });

    it("fails the run as interrupted once the wall age passes deadline plus caps", async () => {
      const id = await runningWithSleep();
      at(T0 + DAY + 21 * MIN);
      expect((await sweepJobs(h.s)).interrupted).toEqual([id]);
      expect(h.store.get(id)).toMatchObject({ status: "failed", error: JOB_INTERRUPTED_ERROR });
    });

    it("a host that reads the counter and saw no sleep still fails it at the caps limit (v1 rule)", async () => {
      const id = await runningWithSleep();
      at(T0 + 21 * MIN);
      expect((await sweepJobs(h.s, new Date(), { sleepNow: { boot_at: boot, slept_ms: 1_000 } })).interrupted).toEqual([id]);
    });
  });

  it("with 200 finished rows the sweep reads live rows only, and history returns the newest 20", async () => {
    const j = await job(h.s);
    const base = h.store.get(`${j.jobId}~1`)!;
    for (let i = 1; i <= 200; i++) {
      const enqueuedAt = new Date(T0 - (201 - i) * H).toISOString();
      h.store.insertIfAbsent({ ...base, taskId: `${j.jobId}~old${i}`, status: "completed", enqueuedAt, completedAt: enqueuedAt });
    }
    const filters: Array<Parameters<typeof h.store.list>[0]> = [];
    const list = h.store.list.bind(h.store);
    h.store.list = (filter) => {
      filters.push(filter);
      return list(filter);
    };
    await sweepJobs(h.s);
    const jobReads = filters.filter((f) => f?.jobId === j.jobId);
    expect(jobReads.length).toBeGreaterThan(0);
    for (const f of jobReads) expect([...(f!.status as string[])].sort()).toEqual(["queued", "running", "scheduled", "submitted"]);
    h.store.list = list;
    const history = jobHistory(h.s, j.jobId);
    expect(history).toHaveLength(20);
    expect(history.slice(0, 3).map((e) => e.taskId)).toEqual([`${j.jobId}~1`, `${j.jobId}~old200`, `${j.jobId}~old199`]);
  });

  it("a corrupt template row is skipped and the other job is still swept; resume refuses it", async () => {
    const bad = await job(h.s);
    const good = await job(h.s, { title: "Disk report" });
    const db = (h.store as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).db;
    db.prepare(`UPDATE jobs SET template_json = '{not json' WHERE job_id = ?`).run(bad.jobId);
    h.s.cancelTask(`${good.jobId}~1`);
    const result = await sweepJobs(h.s);
    expect(result.materialized).toEqual([`${good.jobId}~2`]);
    expect(live(h.store, bad.jobId).map((t) => t.taskId)).toEqual([`${bad.jobId}~1`]);
    await expect(resumeJob(h.s, bad.jobId)).rejects.toThrow("corrupt template");
  });
});
