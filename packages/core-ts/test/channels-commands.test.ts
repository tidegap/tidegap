import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  commandContextFor,
  encodeCallback,
  HELP_TEXT,
  mockGridFeed,
  parseCallback,
  parseCommand,
  QueueListing,
  removeJob,
  runCallback,
  runCommand,
  Scheduler,
  TELEGRAM_CALLBACK_MAX_BYTES,
  TaskStore,
  telegramCommands,
} from "../src/index.js";
import type { CommandContext, JobRecord } from "../src/index.js";
import { JOBS_GRAMMAR } from "../src/channels/format.js";
import { at, harness, job, llm, MIN, T0, type Harness } from "./jobs-harness.js";

const SPEC = { type: "provider_call" as const, provider: "anthropic" as const, model: "claude-sonnet-4-6", prompt: "Summarize the changelog" };
const H = 3_600_000;

describe("parseCommand", () => {
  it("parses the KTD15 grammar", () => {
    expect(parseCommand("/later 2 tonight")).toEqual({ kind: "later", ref: { n: 2 }, arg: { preset: "tonight" } });
    expect(parseCommand("/later t-abc tomorrow")).toEqual({ kind: "later", ref: { id: "t-abc" }, arg: { preset: "tomorrow_morning" } });
    expect(parseCommand("/later 1 1h")).toEqual({ kind: "later", ref: { n: 1 }, arg: { preset: "1h" } });
    expect(parseCommand("/later 1 reset")).toEqual({ kind: "later", ref: { n: 1 }, arg: { preset: "after_limit_reset" } });
    expect(parseCommand("/later 1 reset 14:05")).toEqual({ kind: "later", ref: { n: 1 }, arg: { preset: "after_limit_reset", resetClock: "14:05" } });
    expect(parseCommand("/later 1 23:30")).toEqual({ kind: "later", ref: { n: 1 }, arg: { clock: "23:30" } });
    expect(parseCommand("/cancel@tidegap_bot 3")).toEqual({ kind: "cancel", ref: { n: 3 } });
    expect(parseCommand("/start 123456")).toEqual({ kind: "pair", code: "123456" });
    expect(parseCommand("/pair 123456")).toEqual({ kind: "pair", code: "123456" });
    expect(parseCommand("/later 1 someday").kind).toBe("invalid");
    expect(parseCommand("hello").kind).toBe("unknown");
  });
});

describe("callback data", () => {
  it("l:<id>:n parses to later tonight", () => {
    expect(parseCallback("l:t-1:n")).toEqual({ action: "later", taskId: "t-1", preset: "tonight" });
    expect(parseCallback("l:t-1")).toEqual({ action: "later", taskId: "t-1" });
    expect(parseCallback("c:t-1")).toEqual({ action: "cancel", taskId: "t-1" });
    expect(parseCallback("c:t-1:n")).toBeNull();
    expect(parseCallback("q:t-1")).toBeNull();
  });

  it("the longest callback, for a series id, fits in 64 bytes", () => {
    const seriesId = "t-0f8fad5b-d9cb-469f-a165-70867728950e~999";
    for (const preset of ["1h", "tonight", "tomorrow_morning", "after_limit_reset"] as const) {
      const data = encodeCallback("later", seriesId, preset);
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(TELEGRAM_CALLBACK_MAX_BYTES);
      expect(parseCallback(data)).toEqual({ action: "later", taskId: seriesId, preset });
    }
  });
});

describe("runCommand and runCallback on a real scheduler", () => {
  let dir: string;
  let scheduler: Scheduler;
  let store: TaskStore;
  let ctx: CommandContext;
  let listing: QueueListing;
  let writes: string[];

  beforeEach(() => {
    // 10:00 local: every task below plans before tonight and tomorrow morning.
    const d = new Date();
    vi.useFakeTimers({ now: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 10, 0, 0), toFake: ["Date"] });
    dir = mkdtempSync(join(tmpdir(), "tidegap-channels-"));
    const dbPath = join(dir, "q.db");
    store = new TaskStore({ dbPath });
    scheduler = new Scheduler({ store, feed: mockGridFeed(), signing: false, eager: false, rng: () => 0 });
    const base = commandContextFor(scheduler, store);
    writes = [];
    ctx = {
      ...base,
      postpone: async (id, t) => (writes.push(`postpone ${id}`), base.postpone(id, t)),
      cancel: (id) => (writes.push(`cancel ${id}`), base.cancel(id)),
      runNow: (id) => (writes.push(`run ${id}`), base.runNow(id)),
    };
    listing = new QueueListing();
  });
  afterEach(() => {
    scheduler.shutdown();
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  async function enqueue(prompt: string, hoursAhead: number) {
    return scheduler.enqueueProviderCall({ ...SPEC, prompt }, { deadline: new Date(Date.now() + hoursAhead * H), region: "DE" });
  }

  it("/later 2 tonight with a listing postpones the second task", async () => {
    await enqueue("First task", 2);
    const second = await enqueue("Second task", 3);
    const [queue] = await runCommand(parseCommand("/queue"), ctx, listing);
    expect(queue!.text).toContain("2. Second task");
    const [reply] = await runCommand(parseCommand("/later 2 tonight"), ctx, listing);
    expect(writes).toEqual([`postpone ${second.taskId}`]);
    expect(reply!.text).toMatch(/^Moved: Second task\. Not before /);
  });

  it("/cancel abc with an unknown id answers no task abc", async () => {
    const [reply] = await runCommand(parseCommand("/cancel abc"), ctx, listing);
    expect(reply!.text).toBe("There is no task abc.");
    expect(writes).toEqual([]);
  });

  it("a number without a /queue asks for /queue and writes nothing", async () => {
    await enqueue("First task", 2);
    const [reply] = await runCommand(parseCommand("/cancel 1"), ctx, listing);
    expect(reply!.text).toMatch(/^Send \/queue first/);
    expect(writes).toEqual([]);
  });

  it("a listing expires after 10 minutes", async () => {
    const t = await enqueue("First task", 2);
    listing.set([t.taskId], new Date(Date.now() - 11 * 60_000));
    const [reply] = await runCommand(parseCommand("/run 1"), ctx, listing);
    expect(reply!.text).toMatch(/^Send \/queue first/);
  });

  it("a Cancel press on a completed task alerts, removes the buttons and writes nothing", async () => {
    const t = await enqueue("Done task", 2);
    store.upsert({ ...store.get(t.taskId)!, status: "completed", result: { text: "ok" } });
    const out = await runCallback(encodeCallback("cancel", t.taskId), ctx);
    expect(out.answer).toEqual({ text: "Done task is already completed.", showAlert: true });
    expect(out.removeButtons).toBe(true);
    expect(writes).toEqual([]);
  });

  it("a Cancel press on a pending task cancels it", async () => {
    const t = await enqueue("Pending task", 2);
    const out = await runCallback(encodeCallback("cancel", t.taskId), ctx);
    expect(store.get(t.taskId)!.status).toBe("cancelled");
    expect(out.removeButtons).toBe(true);
    expect(out.messages[0]!.text).toBe("Cancelled: Pending task.");
  });

  it("Later ▾ opens the preset menu; a preset press moves the task", async () => {
    const t = await enqueue("Movable task", 3);
    const menu = await runCallback(encodeCallback("later", t.taskId), ctx);
    const datas = menu.messages[0]!.buttons!.flat().map((b) => b.data);
    expect(datas).toContain(`l:${t.taskId}:m`);
    expect(writes).toEqual([]);
    const moved = await runCallback(`l:${t.taskId}:m`, ctx);
    expect(moved.answer.text).toBe("Moved");
    expect(writes).toEqual([`postpone ${t.taskId}`]);
  });

  it("/later reset without a known reset asks for the time", async () => {
    const t = await enqueue("Reset task", 3);
    const [reply] = await runCommand(parseCommand(`/later ${t.taskId} reset`), ctx, listing);
    expect(reply!.text).toBe(`needs the reset time: /later ${t.taskId} reset HH:MM (for example /later ${t.taskId} reset 14:05)`);
  });
});

describe("/jobs (U11)", () => {
  let h: Harness;
  let ctx: CommandContext;
  let listing: QueueListing;
  beforeEach(() => {
    h = harness();
    ctx = commandContextFor(h.s, h.store);
    listing = new QueueListing();
  });
  afterEach(() => h.done());

  /** Rewrite a job row as the sweep would have left it. */
  function patchJob(jobId: string, patch: Partial<JobRecord>) {
    const before = h.store.getJob(jobId)!;
    expect(h.store.updateJobIf({ ...before, ...patch, revision: before.revision + 1 }, before.revision)).toBe(true);
  }

  async function threeJobs() {
    // Created a second apart, so the ledger order is fixed; the paused one is created first and still lists last.
    const audit = await job(h.s, { title: "Weekly dependency audit", cadence: { kind: "weekly", days: ["mon"] } });
    at(T0 + 1000);
    const mail = await job(h.s, { title: "Mail triage", window: { start: "00:00", end: "08:00" } });
    at(T0 + 2000);
    const deploy = await job(h.s, { title: "Deploy logs", cadence: { kind: "hours", every: 24 } });
    patchJob(deploy.jobId, { lastOutcome: "failed", consecutiveFailures: 1, lastRunStartedAt: new Date(T0 - 2 * H).toISOString() });
    patchJob(audit.jobId, { status: "paused", pauseReason: "auto: ssh: connect timed out", consecutiveFailures: 3 });
    return { mail, deploy, audit };
  }

  it("parses /jobs, /jobs@bot and the pause, resume and run actions", () => {
    expect(parseCommand("/jobs")).toEqual({ kind: "jobs" });
    expect(parseCommand("/jobs@tidegap_bot")).toEqual({ kind: "jobs" });
    expect(parseCommand("/jobs pause 1")).toEqual({ kind: "job", action: "pause", ref: { n: 1 } });
    expect(parseCommand("/jobs@tidegap_bot resume job-0a1b2c3d")).toEqual({ kind: "job", action: "resume", ref: { id: "job-0a1b2c3d" } });
    expect(parseCommand("/jobs RUN 2")).toEqual({ kind: "job", action: "run", ref: { n: 2 } });
    for (const bad of ["/jobs pause", "/jobs stop 1", "/jobs pause 1 2", "/jobs 1"]) {
      expect(parseCommand(bad)).toEqual({ kind: "invalid", reply: `Usage: ${JOBS_GRAMMAR}` });
    }
  });

  it("lists two active and one paused job with counts, cadence, next run, last outcome and the pause reason", async () => {
    await threeJobs();
    const [msg] = await runCommand(parseCommand("/jobs"), ctx, listing);
    const lines = msg!.text.split("\n");
    expect(lines[0]).toBe("Jobs (2 active, 1 paused)");
    expect(lines[1]).toMatch(/^1\. Mail triage - every day 00:00-08:00 - next ~?Wed \d\d:\d\d$/);
    expect(lines[2]).toMatch(/^2\. Deploy logs - at least every 24 h - next ~?(Tue|Wed) \d\d:\d\d - last failed 10:00 \(1 of 3\)$/);
    expect(lines[3]).toBe("3. Weekly dependency audit - paused after 3 failures: ssh: connect timed out");
    expect(lines.slice(4)).toEqual(["", "Numbers stay valid for 10 minutes. Example: /jobs pause 1", "Edit jobs on the page: tidegap ui"]);
    expect(msg!.buttons).toBeUndefined();
  });

  it("shows the next run and the last time in the job's zone", async () => {
    const j = await job(h.s, { title: "Tokyo", timeZone: "Asia/Tokyo", window: { start: "03:00", end: "04:00" } });
    patchJob(j.jobId, { lastOutcome: "ok", lastRunStartedAt: new Date(T0 - 2 * H).toISOString() });
    const [msg] = await runCommand(parseCommand("/jobs"), ctx, listing);
    // T0 is Tue 21:00 in Tokyo; the last run was 19:00 there; the next window is Wed 03:00-04:00.
    expect(msg!.text.split("\n")[1]).toMatch(/^1\. Tokyo - every day 03:00-04:00 - next ~?Wed 03:\d\d - last ok 19:00$/);
  });

  it("12 jobs print 10 lines and 'and 2 more'", async () => {
    for (let i = 1; i <= 12; i++) {
      at(T0 + i * 1000);
      await job(h.s, { title: `Job ${i}` });
    }
    const [msg] = await runCommand(parseCommand("/jobs"), ctx, listing);
    const lines = msg!.text.split("\n");
    expect(lines[0]).toBe("Jobs (12 active)");
    expect(lines.slice(1, 11).map((l) => l.split(" - ")[0])).toEqual(Array.from({ length: 10 }, (_, i) => `${i + 1}. Job ${i + 1}`));
    expect(lines[11]).toBe("and 2 more");
  });

  it("no jobs points to the page", async () => {
    const [msg] = await runCommand(parseCommand("/jobs"), ctx, listing);
    expect(msg!.text).toBe("No jobs. Create one on the page: tidegap ui");
  });

  it("pause, resume and run by number act on the job from the last /jobs", async () => {
    const { mail } = await threeJobs();
    await runCommand(parseCommand("/jobs"), ctx, listing);
    const [paused] = await runCommand(parseCommand("/jobs pause 1"), ctx, listing);
    expect(paused!.text).toBe("Paused: Mail triage.");
    expect(h.store.getJob(mail.jobId)).toMatchObject({ status: "paused", pauseReason: "manual" });
    expect(h.store.get(mail.pendingTaskId!)!.status).toBe("cancelled");
    const [again] = await runCommand(parseCommand("/jobs pause 1"), ctx, listing);
    expect(again!.text).toBe("Mail triage is already paused.");
    const [refused] = await runCommand(parseCommand("/jobs run 1"), ctx, listing);
    expect(refused!.text).toBe("Mail triage is paused. Resume it first: /jobs resume 1");
    const [resumed] = await runCommand(parseCommand("/jobs resume 1"), ctx, listing);
    expect(resumed!.text).toMatch(/^Resumed: Mail triage\. Next ~?Wed \d\d:\d\d\.$/);
    expect(h.store.getJob(mail.jobId)!.status).toBe("active");
    const [run] = await runCommand(parseCommand("/jobs run 1"), ctx, listing);
    expect(run!.text).toBe("Runs at the next tick: Mail triage.");
    expect(h.store.get(h.store.getJob(mail.jobId)!.pendingTaskId!)).toMatchObject({ status: "scheduled", intensitySource: "expedited" });
    const [notPaused] = await runCommand(parseCommand(`/jobs resume ${mail.jobId}`), ctx, listing);
    expect(notPaused!.text).toBe("Mail triage is not paused.");
  });

  it("job numbers need a /jobs listing of their own; ids work without one", async () => {
    const { audit } = await threeJobs();
    const [none] = await runCommand(parseCommand("/jobs pause 1"), ctx, listing);
    expect(none!.text).toBe("Send /jobs first: job numbers come from the last /jobs and expire after 10 minutes.");
    await runCommand(parseCommand("/queue"), ctx, listing);
    const [stillNone] = await runCommand(parseCommand("/jobs pause 1"), ctx, listing);
    expect(stillNone!.text).toMatch(/^Send \/jobs first/);
    await runCommand(parseCommand("/jobs"), ctx, listing);
    const [missing] = await runCommand(parseCommand("/jobs pause 4"), ctx, listing);
    expect(missing!.text).toBe("The last /jobs has no job 4.");
    const [unknown] = await runCommand(parseCommand("/jobs pause job-ffffffff"), ctx, listing);
    expect(unknown!.text).toBe("There is no job job-ffffffff.");
    const [resumed] = await runCommand(parseCommand(`/jobs resume ${audit.jobId}`), ctx, listing);
    expect(resumed!.text).toMatch(/^Resumed: Weekly dependency audit\. Next /);
    expect(h.store.getJob(audit.jobId)).toMatchObject({ status: "active", consecutiveFailures: 0 });
  });

  it("a removed job is not listed and its id answers no job", async () => {
    const j = await job(h.s, { title: "Gone" });
    await removeJob(h.s, j.jobId);
    const [list] = await runCommand(parseCommand("/jobs"), ctx, listing);
    expect(list!.text).toBe("No jobs. Create one on the page: tidegap ui");
    const [reply] = await runCommand(parseCommand(`/jobs run ${j.jobId}`), ctx, listing);
    expect(reply!.text).toBe(`There is no job ${j.jobId}.`);
  });

  it("a paused job lists why: manual, a redacted and clipped error, or another reason", async () => {
    const key = `sk-ant-api03-${"a".repeat(24)}`;
    const reasons = ["manual", `auto: 401 invalid key ${key}`, `auto: ${"x".repeat(300)}`, "corrupt template"];
    for (const [i, pauseReason] of reasons.entries()) {
      at(T0 + i * 1000);
      const j = await job(h.s, { title: `Job ${i + 1}` });
      patchJob(j.jobId, { status: "paused", pauseReason, consecutiveFailures: 3 });
    }
    const [msg] = await runCommand(parseCommand("/jobs"), ctx, listing);
    const lines = msg!.text.split("\n");
    expect(lines[1]).toBe("1. Job 1 - paused");
    expect(lines[2]).toBe("2. Job 2 - paused after 3 failures: 401 invalid key [REDACTED]");
    expect(lines[3]).toBe(`3. Job 3 - paused after 3 failures: ${"x".repeat(120)}\u2026`);
    expect(lines[4]).toBe("4. Job 4 - paused: corrupt template");
    expect(msg!.text).not.toContain(key);
  });

  it("a /jobs listing expires after 10 minutes", async () => {
    await threeJobs();
    await runCommand(parseCommand("/jobs"), ctx, listing);
    at(T0 + 2000 + 11 * MIN);
    const [reply] = await runCommand(parseCommand("/jobs pause 1"), ctx, listing);
    expect(reply!.text).toMatch(/^Send \/jobs first/);
  });

  it("while an occurrence runs, run is refused and pause then resume says a run is in progress", async () => {
    const j = await job(h.s, { title: "Mail triage" });
    let release!: () => void;
    h.s.runNow(`${j.jobId}~1`);
    const tick = h.s.tick({ anthropic: llm({ gate: new Promise<void>((r) => (release = r)) }) });
    await new Promise((r) => setTimeout(r, 10));
    await runCommand(parseCommand("/jobs"), ctx, listing);
    const [refused] = await runCommand(parseCommand("/jobs run 1"), ctx, listing);
    expect(refused!.text).toBe("Not started: Mail triage: an occurrence is already running");
    await runCommand(parseCommand("/jobs pause 1"), ctx, listing);
    const [resumed] = await runCommand(parseCommand("/jobs resume 1"), ctx, listing);
    expect(resumed!.text).toBe("Resumed: Mail triage. A run is in progress.");
    const [list] = await runCommand(parseCommand("/jobs"), ctx, listing);
    expect(list!.text.split("\n")[1]).toBe("1. Mail triage - every day - running now");
    release();
    await tick;
  });

  it("an error other than a job action refusal is not quoted", async () => {
    const j = await job(h.s, { title: "Mail triage" });
    const failing: CommandContext = { ...ctx, pauseJob: async () => { throw new Error("SQLITE_IOERR: /private/q.db"); } };
    const [reply] = await runCommand(parseCommand(`/jobs pause ${j.jobId}`), failing, listing);
    expect(reply!.text).toBe("Not paused: Mail triage: unexpected error. Check the job on the page: tidegap ui");
  });

  it("/help and the command menu include /jobs once", () => {
    expect(HELP_TEXT).toContain(`${JOBS_GRAMMAR} - `);
    expect(telegramCommands().filter((c) => c.command === "jobs")).toHaveLength(1);
  });
});
