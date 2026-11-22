/**
 * Job actions (U3): create, edit, pause, resume, run now, remove, list and
 * history, plus the scheduler touch points for command occurrences.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createJob,
  JOB_INTERRUPTED_ERROR,
  jobHistory,
  jobLastRun,
  listJobs,
  pauseJob,
  removeJob,
  resumeJob,
  runJobNow,
  sweepJobs,
  taskActions,
  updateJob,
  zoneTimeLabel,
} from "../src/index.js";
import { DAY, H, MIN, harness, job, live, llm, PROMPT_JOB, T0, at, type Harness } from "./jobs-harness.js";

const COMMAND_JOB = {
  ...PROMPT_JOB,
  title: "Disk report",
  template: { runner: "command" as const, command: "df -h", secrets: [] },
};

describe("job actions", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });
  afterEach(() => h.done());

  it("create makes one scheduled occurrence <job>~1 with job_id, repeat none and no series", async () => {
    const j = await job(h.s);
    expect(j.jobId).toMatch(/^job-[0-9a-f]{8}$/);
    expect(j).toMatchObject({ status: "active", pendingTaskId: `${j.jobId}~1`, nextSeq: 2, createdBy: "cli" });
    const occ = h.store.get(`${j.jobId}~1`)!;
    expect(occ).toMatchObject({ status: "scheduled", jobId: j.jobId, title: "Mail digest", notBefore: new Date(T0).toISOString() });
    expect(occ.repeat).toBe("none");
    expect(occ.seriesId).toBeUndefined();
    expect(occ.deadline).toBe(new Date(T0 + DAY).toISOString());
    expect(JSON.parse(occ.bodyJson!)).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5", tools: [], caps: j.caps });
    const created = h.s.listTaskEvents(occ.taskId).find((e) => e.kind === "created")!;
    expect(created.details).toMatchObject({ job_id: j.jobId, seq: 1, anchor: "run" });
  });

  it("an agent job's first occurrence uses the call's deadline (AS9)", async () => {
    const j = await job(h.s, { deadline: new Date(T0 + 3 * H) });
    expect(h.store.get(j.pendingTaskId!)).toMatchObject({
      notBefore: new Date(T0).toISOString(),
      deadline: new Date(T0 + 3 * H).toISOString(),
    });
  });

  it("bad input is refused with the rule", async () => {
    const bad = (extra: object) => createJob(h.s, { ...PROMPT_JOB, ...extra });
    await expect(bad({ cadence: { kind: "weekly", days: [] } })).rejects.toThrow("pick at least one day");
    await expect(bad({ cadence: { kind: "hours", every: 6 }, window: { start: "00:00", end: "08:00" } })).rejects.toThrow(
      "a window works only with daily, weekdays or weekly",
    );
    await expect(
      bad({ template: { runner: "prompt", prompt: "x", provider: "command", tools: "none" } }),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      bad({ template: { runner: "command", command: "ls", secrets: ["mail-token"] } }),
    ).rejects.toThrow("secret name");
    await expect(bad({ originHost: "web" })).rejects.toThrow("originHost must be page, cli, mcp or openclaw");
    await expect(bad({ deadline: new Date(T0 - H) })).rejects.toThrow("deadline must be a future instant");
    await expect(bad({ caps: { wallMs: 1 } })).rejects.toThrow('unknown cap "wallMs"');
    await expect(bad({ caps: { commandTimeoutMs: 0 } })).rejects.toThrow("cap commandTimeoutMs: 0 is not a time limit; use none for no time limit.");
    await expect(bad({ caps: { llmTimeoutMs: 8 * 24 * H } })).rejects.toThrow("cap llmTimeoutMs: A time limit must be from 1s to 7d");
    await expect(bad({ caps: { maxBudgetUsd: 0 } })).rejects.toThrow("cap maxBudgetUsd must be a positive number");
    await expect(bad({ notify: "never" })).rejects.toThrow("notify must be every_run, failures or summary");
    await expect(bad({ title: " " })).rejects.toThrow("title must be a non-empty string");
    await expect(bad({ template: { ...PROMPT_JOB.template, tools: "shell" } })).rejects.toThrow("tools must be none, files or web");
    expect(listJobs(h.s, { includeRemoved: true })).toEqual([]);
  });

  it("stores only the time limits the caller set, takes none, and an edit with null removes one", async () => {
    const plain = await job(h.s);
    expect(plain.caps).toEqual({ maxBudgetUsd: 1, outputCapBytes: 10 * 1024 * 1024, summarizeInputCapBytes: 200 * 1024, capsVersion: 2 });
    const own = await job(h.s, { caps: { llmTimeoutMs: "none", commandTimeoutMs: 5 * 60_000 } });
    expect(own.caps).toMatchObject({ llmTimeoutMs: "none", commandTimeoutMs: 300_000, capsVersion: 2 });
    const renamed = await updateJob(h.s, own.jobId, { title: "Renamed" });
    expect(renamed.caps).toEqual(own.caps);
    const cleared = await updateJob(h.s, own.jobId, { caps: { commandTimeoutMs: null } });
    expect(cleared.caps).toEqual({ maxBudgetUsd: 1, outputCapBytes: 10 * 1024 * 1024, summarizeInputCapBytes: 200 * 1024, llmTimeoutMs: "none", capsVersion: 2 });
  });

  it("an edit of a job stored before this change drops the old default limits and keeps one the user set", async () => {
    const j = await job(h.s);
    const stored = h.store.getJob(j.jobId)!;
    const legacy = { commandTimeoutMs: 300_000, llmTimeoutMs: 120_000, maxBudgetUsd: 1, outputCapBytes: 10 * 1024 * 1024, summarizeInputCapBytes: 200 * 1024 };
    expect(h.store.updateJobIf({ ...stored, caps: legacy }, stored.revision)).toBe(true);
    const edited = await updateJob(h.s, j.jobId, { title: "Edited" });
    expect(edited.caps).toEqual({ llmTimeoutMs: 120_000, maxBudgetUsd: 1, outputCapBytes: 10 * 1024 * 1024, summarizeInputCapBytes: 200 * 1024, capsVersion: 2 });
  });

  it("a create whose first insert throws leaves no job; a retry yields exactly one", async () => {
    const insert = h.store.insertIfAbsent.bind(h.store);
    h.store.insertIfAbsent = () => {
      h.store.insertIfAbsent = insert;
      throw new Error("database is locked");
    };
    await expect(job(h.s)).rejects.toThrow("database is locked");
    expect(listJobs(h.s)).toEqual([]);
    const j = await job(h.s);
    expect(listJobs(h.s).map((x) => x.jobId)).toEqual([j.jobId]);
    expect(live(h.store, j.jobId).map((t) => t.taskId)).toEqual([`${j.jobId}~1`]);
  });

  it("a create whose job write throws after the insert cancels that insert; a retry yields exactly one live occurrence", async () => {
    const write = h.store.updateJobIf.bind(h.store);
    h.store.updateJobIf = () => {
      h.store.updateJobIf = write;
      throw new Error("database is locked");
    };
    await expect(job(h.s)).rejects.toThrow("database is locked");
    expect(listJobs(h.s)).toEqual([]);
    const [failed] = listJobs(h.s, { includeRemoved: true });
    expect(failed!.status).toBe("removed");
    expect(h.store.list({ jobId: failed!.jobId }).map((t) => [t.taskId, t.status])).toEqual([[`${failed!.jobId}~1`, "cancelled"]]);
    const j = await job(h.s);
    expect(listJobs(h.s).map((x) => x.jobId)).toEqual([j.jobId]);
    expect(live(h.store, j.jobId)).toHaveLength(1);
  });

  it("pause cancels the pending occurrence with reason paused and makes no successor", async () => {
    const j = await job(h.s);
    const paused = await pauseJob(h.s, j.jobId, { actor: "page" });
    expect(paused).toMatchObject({ status: "paused", pauseReason: "manual", pendingTaskId: undefined, lastOutcome: undefined });
    const cancelled = h.s.listTaskEvents(`${j.jobId}~1`).find((e) => e.kind === "cancelled")!;
    expect(cancelled).toMatchObject({ actor: "page", details: { job_id: j.jobId, reason: "paused" } });
    await sweepJobs(h.s);
    expect(live(h.store, j.jobId)).toEqual([]);
    await expect(pauseJob(h.s, j.jobId)).rejects.toThrow("job is already paused");
    await expect(runJobNow(h.s, j.jobId)).rejects.toThrow("job is paused");
  });

  it("covers AE5: resume at 14:00 makes one occurrence from 14:00, no backfill, counter reset", async () => {
    const j = await job(h.s);
    await pauseJob(h.s, j.jobId);
    at(T0 + 3 * DAY + 2 * H); // three days later, 14:00
    const resumed = await resumeJob(h.s, j.jobId);
    expect(resumed).toMatchObject({ status: "active", consecutiveFailures: 0, pauseReason: undefined });
    const rows = live(h.store, j.jobId);
    expect(rows.map((r) => r.taskId)).toEqual([`${j.jobId}~2`]);
    expect(rows[0]!.notBefore).toBe("2026-10-23T14:00:00.000Z");
    await expect(resumeJob(h.s, j.jobId)).rejects.toThrow("job is not paused");
  });

  it("run now is refused while the planned occurrence runs", async () => {
    const j = await job(h.s);
    h.s.runNow(`${j.jobId}~1`);
    let release!: () => void;
    const tick = h.s.tick({ anthropic: llm({ gate: new Promise<void>((r) => (release = r)) }) });
    await new Promise((r) => setTimeout(r, 10));
    await expect(runJobNow(h.s, j.jobId)).rejects.toThrow("an occurrence is already running");
    release();
    await tick;
  });

  it("edit cancels the pending occurrence with reason edited; the new one follows the new rule", async () => {
    const j = await job(h.s);
    const edited = await updateJob(h.s, j.jobId, { window: { start: "00:00", end: "08:00" } });
    expect(h.s.listTaskEvents(`${j.jobId}~1`).find((e) => e.kind === "cancelled")!.details).toMatchObject({
      reason: "edited",
    });
    expect(edited).toMatchObject({ pendingTaskId: `${j.jobId}~2`, lastOutcome: undefined, window: { start: "00:00", end: "08:00" } });
    expect(h.store.get(`${j.jobId}~2`)).toMatchObject({
      notBefore: "2026-10-21T00:00:00.000Z",
      deadline: "2026-10-21T08:00:00.000Z",
    });
    expect(live(h.store, j.jobId)).toHaveLength(1);
  });

  it("remove hides the job, cancels the pending occurrence and keeps history", async () => {
    const j = await job(h.s);
    const removed = await removeJob(h.s, j.jobId);
    expect(removed.status).toBe("removed");
    expect(h.store.get(`${j.jobId}~1`)!.status).toBe("cancelled");
    expect(listJobs(h.s)).toEqual([]);
    expect(listJobs(h.s, { includeRemoved: true }).map((x) => x.jobId)).toEqual([j.jobId]);
    expect(jobHistory(h.s, j.jobId).map((e) => [e.taskId, e.status])).toEqual([[`${j.jobId}~1`, "cancelled"]]);
    await expect(updateJob(h.s, j.jobId, { title: "x" })).rejects.toThrow("job was removed");
    await expect(pauseJob(h.s, "job-ffffffff")).rejects.toMatchObject({ code: "not_found" });
  });

  it("history lists occurrences newest first with the first error line", async () => {
    const j = await job(h.s);
    h.s.runNow(`${j.jobId}~1`);
    await h.s.tick({ anthropic: llm({ fail: "mail server said no\nat line 2" }) });
    await sweepJobs(h.s);
    const history = jobHistory(h.s, j.jobId);
    expect(history.map((e) => e.taskId)).toEqual([`${j.jobId}~1r`, `${j.jobId}~1`]);
    expect(history[1]).toMatchObject({ status: "failed", error: "mail server said no", hasReceipt: false });
  });
});

describe("command occurrences in the scheduler", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });
  afterEach(() => h.done());

  it("a command-only occurrence (empty prompt) inserts and plans", async () => {
    const j = await createJob(h.s, COMMAND_JOB);
    const occ = h.store.get(j.pendingTaskId!)!;
    expect(JSON.parse(occ.bodyJson!)).toMatchObject({
      provider: "command",
      model: "none",
      prompt: "",
      command: { run: "df -h", secrets: [] },
    });
    expect(occ.estimatedCarbonGCo2).toBeDefined();
  });

  it("a tick without a command adapter leaves the occurrence scheduled with no failed event", async () => {
    const j = await createJob(h.s, COMMAND_JOB);
    h.s.runNow(j.pendingTaskId!);
    const result = await h.s.tick({ anthropic: llm() });
    expect(result).toMatchObject({ inspected: 0, failed: 0 });
    expect(h.store.get(j.pendingTaskId!)!.status).toBe("scheduled");
    expect(h.s.listTaskEvents(j.pendingTaskId!).map((e) => e.kind)).not.toContain("failed");
    await expect(h.s.expediteTask(j.pendingTaskId!, { anthropic: llm() })).rejects.toThrow("runs a shell command");
  });

  it("enqueueProviderCall rejects provider command; a finished command occurrence offers no reply", async () => {
    await expect(
      h.s.enqueueProviderCall({ type: "provider_call", provider: "command", model: "none", prompt: "x" }),
    ).rejects.toThrow('unsupported provider "command"');
    const j = await createJob(h.s, COMMAND_JOB);
    const row = { ...h.store.get(j.pendingTaskId!)!, status: "completed" as const };
    expect(taskActions(row).reply).toBe(false);
    const prompt = await job(h.s);
    expect(taskActions({ ...h.store.get(prompt.pendingTaskId!)!, status: "completed" }).reply).toBe(true);
  });
});

describe("planning inside the occurrence window (R18)", () => {
  const flat = {
    source: "mock" as const,
    async fetchForecast(region: string, hours: number) {
      const start = Math.floor(Date.now() / H) * H;
      return {
        region,
        source: "mock" as const,
        generatedAt: new Date().toISOString(),
        entries: Array.from({ length: hours }, (_, i) => ({
          datetime: new Date(start + i * H).toISOString(),
          carbonIntensityGCo2PerKwh: 300,
          band: "average" as const,
        })),
      };
    },
  };

  for (const [name, feed] of [["a flat forecast", flat], ["the mock curve", undefined]] as const) {
    it(`the planned hour lies inside [earliest, deadline] under ${name}`, async () => {
      const h = harness(feed);
      try {
        for (const window of [undefined, { start: "14:00", end: "18:00" }, { start: "02:00", end: "03:00" }]) {
          const j = await job(h.s, { window });
          const occ = h.store.get(j.pendingTaskId!)!;
          const planned = Date.parse(occ.scheduledFor!);
          expect(planned).toBeGreaterThanOrEqual(Date.parse(occ.notBefore!));
          expect(planned).toBeLessThanOrEqual(Date.parse(occ.deadline!));
          expect(occ.estimatedCarbonGCo2).toBeDefined();
        }
      } finally {
        h.done();
      }
    });
  }

  it("a one-hour window keeps a one-hour span", async () => {
    const h = harness();
    try {
      const j = await job(h.s, { window: { start: "02:00", end: "03:00" } });
      const occ = h.store.get(j.pendingTaskId!)!;
      expect(Date.parse(occ.deadline!) - Date.parse(occ.notBefore!)).toBe(H);
      expect(occ.notBefore).toBe("2026-10-21T02:00:00.000Z");
    } finally {
      h.done();
    }
  });
});

describe("run now: an extra run beside the planned occurrence", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });
  afterEach(() => h.done());

  const cancelReasonOf = (taskId: string) => h.s.listTaskEvents(taskId).find((e) => e.kind === "cancelled")?.details.reason;

  it("adds <job>~<n>x due now with the job's template; the planned row and the schedule anchor stay; the run becomes the last run", async () => {
    const j = await job(h.s);
    const planned = h.store.get(`${j.jobId}~1`)!;
    const extra = await runJobNow(h.s, j.jobId, { actor: "cli" });
    expect(extra).toMatchObject({
      taskId: `${j.jobId}~2x`,
      jobId: j.jobId,
      status: "scheduled",
      intensitySource: "expedited",
      scheduledFor: new Date(T0).toISOString(),
      notBefore: undefined,
      deadline: new Date(T0 + DAY).toISOString(),
    });
    expect(JSON.parse(extra.bodyJson!)).toEqual(JSON.parse(planned.bodyJson!));
    expect(h.s.listTaskEvents(extra.taskId).find((e) => e.kind === "created")).toMatchObject({
      actor: "cli",
      details: { job_id: j.jobId, seq: 2, anchor: "run_now" },
    });
    expect(h.store.getJob(j.jobId)).toMatchObject({ pendingTaskId: planned.taskId, extraTaskId: extra.taskId, nextSeq: 3 });
    await expect(runJobNow(h.s, j.jobId)).rejects.toThrow(`a run is already starting at 12:00 (${extra.taskId})`);
    await h.s.tick({ anthropic: llm() });
    expect(h.store.get(extra.taskId)!.status).toBe("completed");
    await sweepJobs(h.s);
    expect(h.store.getJob(j.jobId)).toMatchObject({
      pendingTaskId: planned.taskId,
      extraTaskId: undefined,
      lastTaskId: extra.taskId,
      lastOutcome: "ok",
      lastRunStartedAt: undefined,
      nextSeq: 3,
    });
    expect(h.store.get(planned.taskId)).toMatchObject({ status: "scheduled", notBefore: planned.notBefore, scheduledFor: planned.scheduledFor, deadline: planned.deadline });
    expect(live(h.store, j.jobId).map((t) => t.taskId)).toEqual([planned.taskId]);
  });

  it("is refused while the planned occurrence starts within 5 minutes, and allowed 6 minutes before it", async () => {
    const j = await job(h.s);
    const planned = h.store.get(`${j.jobId}~1`)!;
    const start = Date.parse(planned.scheduledFor!);
    at(start - 4 * MIN);
    const label = zoneTimeLabel(new Date(start), new Date(start - 4 * MIN), "UTC");
    await expect(runJobNow(h.s, j.jobId)).rejects.toThrow(`a run is already starting at ${label} (${planned.taskId})`);
    expect(h.store.list({ jobId: j.jobId })).toHaveLength(1);
    at(start - 6 * MIN);
    expect((await runJobNow(h.s, j.jobId)).taskId).toBe(`${j.jobId}~2x`);
  });

  it("a failed extra run gets the job's retry; neither counts toward the failure count or the runs left", async () => {
    const j = await job(h.s, { count: 2 });
    const extra = await runJobNow(h.s, j.jobId);
    await h.s.tick({ anthropic: llm({ fail: "mailbox locked" }) });
    expect((await sweepJobs(h.s)).retried).toEqual([`${j.jobId}~2xr`]);
    const retry = h.store.get(`${j.jobId}~2xr`)!;
    expect(retry).toMatchObject({ status: "scheduled", notBefore: new Date(T0 + 30 * MIN).toISOString(), deadline: extra.deadline });
    expect(h.store.getJob(j.jobId)).toMatchObject({
      extraTaskId: retry.taskId,
      lastTaskId: extra.taskId,
      lastOutcome: "failed",
      consecutiveFailures: 0,
      retryUsed: 0,
      runsLeft: 2,
      pendingTaskId: `${j.jobId}~1`,
    });
    at(T0 + 31 * MIN);
    h.s.runNow(retry.taskId);
    await h.s.tick({ anthropic: llm({ fail: "mailbox locked" }) });
    await sweepJobs(h.s);
    expect(h.store.getJob(j.jobId)).toMatchObject({
      status: "active",
      extraTaskId: undefined,
      lastTaskId: retry.taskId,
      lastOutcome: "failed",
      consecutiveFailures: 0,
      runsLeft: 2,
    });
    expect(live(h.store, j.jobId).map((t) => t.taskId)).toEqual([`${j.jobId}~1`]);
  });

  it("the sweep that ends the job cancels its pending extra retry in the same pass", async () => {
    const j = await job(h.s, { count: 1 });
    await runJobNow(h.s, j.jobId);
    await h.s.tick({ anthropic: llm({ fail: "mailbox locked" }) });
    await sweepJobs(h.s);
    expect(h.store.get(`${j.jobId}~2xr`)!.status).toBe("scheduled");
    h.s.runNow(`${j.jobId}~1`);
    await h.s.tick({ anthropic: llm() });
    expect((await sweepJobs(h.s)).ended).toEqual([j.jobId]);
    expect(cancelReasonOf(`${j.jobId}~2xr`)).toBe("ended");
    expect(h.store.getJob(j.jobId)).toMatchObject({ status: "ended", extraTaskId: undefined, lastTaskId: `${j.jobId}~1` });
    expect(live(h.store, j.jobId)).toEqual([]);
  });

  it("a later pending retry of an extra run is replaced by a new run now", async () => {
    const j = await job(h.s);
    await runJobNow(h.s, j.jobId);
    await h.s.tick({ anthropic: llm({ fail: "mailbox locked" }) });
    await sweepJobs(h.s);
    const next = await runJobNow(h.s, j.jobId);
    expect(next.taskId).toBe(`${j.jobId}~3x`);
    expect(cancelReasonOf(`${j.jobId}~2xr`)).toBe("duplicate");
    expect(h.store.getJob(j.jobId)!.extraTaskId).toBe(next.taskId);
  });

  it("an edit of what the job runs and a pause cancel an extra run that has not started; a title or schedule edit keeps it", async () => {
    const j = await job(h.s);
    const a = await runJobNow(h.s, j.jobId);
    await updateJob(h.s, j.jobId, { title: "Renamed" });
    await updateJob(h.s, j.jobId, { window: { start: "00:00", end: "08:00" } });
    expect(h.store.get(a.taskId)!.status).toBe("scheduled");
    expect(h.store.getJob(j.jobId)!.extraTaskId).toBe(a.taskId);
    await updateJob(h.s, j.jobId, { template: { ...PROMPT_JOB.template, prompt: "another prompt" } });
    expect(cancelReasonOf(a.taskId)).toBe("edited");
    expect(h.store.getJob(j.jobId)).toMatchObject({ extraTaskId: undefined, lastTaskId: undefined });
    const b = await runJobNow(h.s, j.jobId);
    await pauseJob(h.s, j.jobId);
    expect(cancelReasonOf(b.taskId)).toBe("paused");
    expect(h.store.getJob(j.jobId)!.extraTaskId).toBeUndefined();
    expect(live(h.store, j.jobId)).toEqual([]);
  });

  it("a running extra run its tick left fails as interrupted in the daemon sweep and gets its retry", async () => {
    const j = await job(h.s);
    const extra = await runJobNow(h.s, j.jobId);
    expect(h.store.claimScheduled(extra.taskId)).toBe(true);
    h.store.recordEvent(extra.taskId, { kind: "dispatched", actor: "tick" });
    at(T0 + 16 * MIN);
    const result = await sweepJobs(h.s);
    expect(result.interrupted).toEqual([extra.taskId]);
    expect(h.store.get(extra.taskId)).toMatchObject({ status: "failed", error: JOB_INTERRUPTED_ERROR });
    expect(result.retried).toEqual([`${extra.taskId}r`]);
    expect(h.store.getJob(j.jobId)).toMatchObject({ extraTaskId: `${extra.taskId}r`, consecutiveFailures: 0, pendingTaskId: `${j.jobId}~1` });
  });

  it("an extra-run row the job does not track (a crash before run now's job write) is adopted, not cancelled", async () => {
    const j = await job(h.s);
    const planned = h.store.get(`${j.jobId}~1`)!;
    const taskId = `${j.jobId}~2x`;
    const occ = { taskId, jobId: j.jobId, earliest: new Date(T0).toISOString(), deadline: new Date(T0 + DAY).toISOString(), title: j.title, bodyJson: planned.bodyJson! };
    expect(await h.s.materializeOccurrence(occ, { job_id: j.jobId, seq: 2, anchor: "run_now" }, { runNow: {} })).toBe(true);
    await sweepJobs(h.s);
    expect(h.store.getJob(j.jobId)).toMatchObject({ pendingTaskId: planned.taskId, extraTaskId: taskId });
    expect(live(h.store, j.jobId).map((t) => t.taskId).sort()).toEqual([planned.taskId, taskId].sort());
  });

  it("the later finish is the last run, in whichever order one sweep records the planned run and the extra run", async () => {
    for (const extraLater of [true, false]) {
      const j = await job(h.s);
      const extra = await runJobNow(h.s, j.jobId);
      h.s.runNow(`${j.jobId}~1`);
      await h.s.tick({ anthropic: llm() });
      // The sweep records the extra run first, then the planned one.
      const later = extraLater ? extra.taskId : `${j.jobId}~1`;
      h.store.upsert({ ...h.store.get(later)!, completedAt: new Date(T0 + MIN).toISOString() });
      await sweepJobs(h.s);
      expect(h.store.getJob(j.jobId)).toMatchObject({ lastTaskId: later, lastOutcome: "ok" });
    }
  });
});

describe("last run (jobs show)", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });
  afterEach(() => h.done());

  it("an edit's cancel and a skip never become the last run; a job row that names a cancelled one falls back to the newest run", async () => {
    const j = await job(h.s);
    h.s.runNow(`${j.jobId}~1`);
    await h.s.tick({ anthropic: llm() });
    await sweepJobs(h.s);
    const ran = h.store.getJob(j.jobId)!;
    expect(ran).toMatchObject({ lastTaskId: `${j.jobId}~1`, lastOutcome: "ok", pendingTaskId: `${j.jobId}~2` });
    await updateJob(h.s, j.jobId, { window: { start: "00:00", end: "08:00" } });
    expect(h.store.get(`${j.jobId}~2`)!.status).toBe("cancelled");
    expect(h.store.getJob(j.jobId)).toMatchObject({ lastTaskId: `${j.jobId}~1`, lastOutcome: "ok", lastRunStartedAt: ran.lastRunStartedAt });
    h.s.cancelTask(`${j.jobId}~3`);
    await sweepJobs(h.s);
    expect(h.store.getJob(j.jobId)).toMatchObject({ lastTaskId: `${j.jobId}~1`, lastOutcome: "ok", pendingTaskId: `${j.jobId}~4` });
    // A row an older version wrote: the outcome of the run before, the id of the cancelled occurrence.
    const before = h.store.getJob(j.jobId)!;
    expect(h.store.updateJobIf({ ...before, lastTaskId: `${j.jobId}~2`, revision: before.revision + 1 }, before.revision)).toBe(true);
    expect(jobLastRun(h.store, h.store.getJob(j.jobId)!)!.taskId).toBe(`${j.jobId}~1`);
  });
});
