/**
 * Job actions (U3): create, edit, pause, resume, run now, remove, list and
 * history, plus the scheduler touch points for command occurrences.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createJob,
  jobHistory,
  listJobs,
  pauseJob,
  removeJob,
  resumeJob,
  runJobNow,
  sweepJobs,
  taskActions,
  updateJob,
} from "../src/index.js";
import { DAY, H, harness, job, live, llm, PROMPT_JOB, T0, at, type Harness } from "./jobs-harness.js";

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
    await expect(bad({ caps: { commandTimeoutMs: 0 } })).rejects.toThrow("cap commandTimeoutMs must be a positive number");
    await expect(bad({ notify: "never" })).rejects.toThrow("notify must be every_run, failures or summary");
    await expect(bad({ title: " " })).rejects.toThrow("title must be a non-empty string");
    await expect(bad({ template: { ...PROMPT_JOB.template, tools: "shell" } })).rejects.toThrow("tools must be none, files or web");
    expect(listJobs(h.s, { includeRemoved: true })).toEqual([]);
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

  it("run now expedites the pending occurrence (no second row); refused while one runs", async () => {
    const j = await job(h.s);
    const row = await runJobNow(h.s, j.jobId);
    expect(row).toMatchObject({ taskId: `${j.jobId}~1`, intensitySource: "expedited" });
    expect(h.store.list({ jobId: j.jobId })).toHaveLength(1);
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
