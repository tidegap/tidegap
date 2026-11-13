/**
 * schedule_task job repeats (U10, KTD16), check_queue_status's jobs block
 * and cancel_task series=true on a job's run, through the REAL handlers.
 * No test walks the real process tree: origin sources are injected.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { carbonBudgetConfigPath, getJob, mockGridFeed, type JobTemplate } from "@tidegap/core";
import { readCapture } from "@tidegap/cli/session";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEbbServer } from "../src/server.js";

type TextResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

const SESSION = "11111111-2222-4333-8444-555555555555";

let root: string;
let sessions: string;
const cleanups: Array<() => void> = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tidegap-mcp-jobs-"));
  sessions = join(root, "sessions");
  mkdirSync(sessions);
  // The hook's capture file of a Claude Code session in /work/app.
  writeFileSync(
    join(sessions, "claude-200.json"),
    JSON.stringify({
      v: 1,
      pid: 200,
      session_id: SESSION,
      project_dir: "/work/app",
      written_at: "2026-10-17T18:00:00Z",
      hook: { session_id: SESSION, cwd: "/work/app", source: "startup" },
    }),
  );
});
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
  rmSync(root, { recursive: true, force: true });
});

async function connect(opts: { dbPath?: string | null; outside?: boolean } = {}) {
  const built = createEbbServer({
    feed: mockGridFeed(),
    ...(opts.dbPath === null ? {} : { dbPath: opts.dbPath ?? join(root, "queue.db") }),
    origin: {
      env: { claudeCode: false },
      claudePid: () => (opts.outside ? undefined : 200),
      readCapture: (pid) => readCapture(pid, sessions),
      fallbackCwd: () => "/fallback",
    },
  });
  const client = new Client({ name: "jobs-test", version: "0.0.0" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([built.server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(() => {
    try {
      built.scheduler.shutdown();
    } catch {
      /* already closed */
    }
  });
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as TextResult;
  return { ...built, call };
}

const text = (r: TextResult) => r.content.map((c) => c.text).join("\n");
const jobIdOf = (r: TextResult) => /job_id: (job-[0-9a-f]{8})/.exec(text(r))?.[1];
const firstTaskOf = (r: TextResult) => /first_task_id: (\S+)/.exec(text(r))?.[1];

describe("schedule_task with a job repeat", () => {
  it("AE11: daily + window creates a job in the session's project directory", async () => {
    const { call, scheduler } = await connect();
    const r = await call("schedule_task", {
      prompt: "Summarize new issues in the tracker",
      repeat: "daily",
      window: "00:00-08:00",
      time_zone: "Europe/Berlin",
    });
    expect(r.isError).toBeFalsy();
    const out = text(r);
    const jobId = jobIdOf(r);
    expect(jobId).toBeDefined();
    expect(out).toContain(`Job ${jobId} created: runs every day between 00:00 and 08:00. First run planned `);
    expect(out).toContain("scheduled_for: ");
    expect(out).toContain("never a copy of this session");
    const job = getJob(scheduler, jobId!)!;
    expect(job.status).toBe("active");
    expect(job.originHost).toBe("mcp");
    expect(job.originCwd).toBe("/work/app");
    expect(job.window).toEqual({ start: "00:00", end: "08:00" });
    const template = job.template as Extract<JobTemplate, { runner: "prompt" }>;
    expect(template).toMatchObject({ runner: "prompt", provider: "claude-code", cwd: "/work/app", tools: "files" });
    // The first run is an ordinary task with the job id and no session fork (KD8).
    const first = scheduler.loadPersistedTask(firstTaskOf(r)!)!;
    expect(first.jobId).toBe(jobId);
    expect(first.originSessionId).toBeUndefined();
    expect(first.repeat).toBe("none");
  });

  it.each(["command", "cmd", "shell", "script"])(
    "AE12: a %s argument is rejected with the tidegap jobs add sentence",
    async (key) => {
      const { call, scheduler } = await connect();
      const r = await call("schedule_task", { prompt: "check logs", repeat: "daily", [key]: "ssh host tail log" });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain(`schedule_task cannot create command jobs (got "${key}")`);
      expect(text(r)).toContain("tidegap jobs add --command");
      expect(scheduler.ledger()!.listJobs()).toEqual([]);
    },
  );

  it("a command argument is rejected on a one-off call too", async () => {
    const { call, scheduler } = await connect();
    const r = await call("schedule_task", {
      prompt: "check logs",
      deadline: new Date(Date.now() + 6 * 3_600_000).toISOString(),
      command: "ssh host tail log",
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("schedule_task cannot create command jobs");
    expect(scheduler.ledger()!.listJobs()).toEqual([]);
  });

  it("every_n_hours needs every_hours of at least 2", async () => {
    const { call } = await connect();
    const missing = await call("schedule_task", { prompt: "poll", repeat: "every_n_hours" });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toContain("needs every_hours");
    const tooSmall = await call("schedule_task", { prompt: "poll", repeat: "every_n_hours", every_hours: 1 });
    expect(tooSmall.isError).toBe(true);
    const ok = await call("schedule_task", { prompt: "poll", repeat: "every_n_hours", every_hours: 6 });
    expect(ok.isError).toBeFalsy();
    expect(text(ok)).toContain("runs at least every 6 h, never sooner than 3 h after the last run");
  });

  it("weekly without days takes today's weekday; days need weekly", async () => {
    const { call, scheduler } = await connect();
    const r = await call("schedule_task", { prompt: "digest", repeat: "weekly", time_zone: "UTC" });
    expect(r.isError).toBeFalsy();
    const today = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][new Date().getUTCDay()];
    expect(getJob(scheduler, jobIdOf(r)!)!.cadence).toEqual({ kind: "weekly", days: [today] });
    const stray = await call("schedule_task", { prompt: "digest", repeat: "daily", days: ["mon"] });
    expect(stray.isError).toBe(true);
    expect(text(stray)).toContain(`days needs repeat "weekly"`);
  });

  it("job-only parameters without a job repeat are rejected", async () => {
    const { call } = await connect();
    const r = await call("schedule_task", {
      prompt: "once",
      deadline: new Date(Date.now() + 6 * 3_600_000).toISOString(),
      window: "00:00-08:00",
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("window need a job repeat");
  });

  it("until and count with a job repeat create a bounded job; the answer names the end", async () => {
    const { call, scheduler } = await connect();
    const r = await call("schedule_task", { prompt: "watch the deploy", repeat: "daily", time_zone: "Europe/Berlin", until: "2099-11-17", count: 5 });
    expect(r.isError).toBeFalsy();
    const out = text(r);
    expect(out).toContain("after the last run; ends after 2099-11-17 (Europe/Berlin); 5 runs left. First run");
    expect(out).toContain("ends: after 2099-11-17 (Europe/Berlin); 5 runs left\n");
    expect(getJob(scheduler, jobIdOf(r)!)).toMatchObject({ until: "2099-11-17", runsLeft: 5 });
  });

  it("until and count without a job repeat, or out of range, are refused", async () => {
    const { call } = await connect();
    const deadline = new Date(Date.now() + 6 * 3_600_000).toISOString();
    const once = await call("schedule_task", { prompt: "once", deadline, until: "2099-11-17", count: 2 });
    expect(once.isError).toBe(true);
    expect(text(once)).toContain("until, count need a job repeat");
    const past = await call("schedule_task", { prompt: "nightly", repeat: "daily", until: "2020-01-01" });
    expect(past.isError).toBe(true);
    expect(text(past)).toContain('until "2020-01-01" has passed');
    const many = await call("schedule_task", { prompt: "nightly", repeat: "daily", count: 1001 });
    expect(many.isError).toBe(true);
  });

  it("per-task options are rejected with a job repeat", async () => {
    const { call } = await connect();
    const r = await call("schedule_task", { prompt: "nightly", repeat: "daily", region: "GB", dry_run: true });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("region, dry_run cannot be used with a job repeat");
  });

  it("refuses region on a job with the same sentence as OpenClaw", async () => {
    const { call } = await connect();
    const r = await call("schedule_task", { prompt: "nightly", repeat: "daily", region: "GB" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("region cannot be used with a job repeat; omit it");
  });

  it.each<[string, unknown]>([
    ["region", "GB"],
    ["carbon_budget_g", 5],
    ["candidates", ["anthropic:claude-sonnet-4-5"]],
    ["route_weights", { carbon: 1 }],
    ["not_before", new Date(Date.now() + 3_600_000).toISOString()],
    ["after_limit_reset", true],
    ["dry_run", true],
    ["output_path", "/tmp/out.md"],
    ["redact_in_receipt", ["secret"]],
    ["quota_provider", "claude"],
    ["dispatch", false],
  ])("per-task option %s is rejected by name with a job repeat", async (key, value) => {
    const { call, scheduler } = await connect();
    const r = await call("schedule_task", { prompt: "nightly", repeat: "daily", [key]: value });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain(`${key} cannot be used with a job repeat`);
    expect(scheduler.ledger()!.listJobs()).toEqual([]);
  });

  it("dry_run false and after_limit_reset false still create a job", async () => {
    const { call, scheduler } = await connect();
    const r = await call("schedule_task", { prompt: "nightly", repeat: "daily", dry_run: false, after_limit_reset: false });
    expect(r.isError).toBeFalsy();
    expect(scheduler.ledger()!.listJobs()).toHaveLength(1);
  });

  it("a job needs a ledger", async () => {
    const { call } = await connect({ dbPath: null });
    const r = await call("schedule_task", { prompt: "nightly", repeat: "daily" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("jobs need a ledger");
  });

  it("with deadline_kind quota_reset a job-only repeat is refused (daily and weekly keep the series)", async () => {
    const { call, scheduler } = await connect();
    const r = await call("schedule_task", { prompt: "limits", deadline_kind: "quota_reset", repeat: "weekdays" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain(`repeat "weekdays" cannot follow a quota reset`);
    expect(scheduler.ledger()!.listJobs()).toEqual([]);
  });

  it("job-only parameters with daily + deadline_kind quota_reset name the quota_reset conflict", async () => {
    const { call, scheduler } = await connect();
    const r = await call("schedule_task", {
      prompt: "limits",
      deadline_kind: "quota_reset",
      repeat: "daily",
      window: "00:00-08:00",
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain(`window cannot be used with deadline_kind "quota_reset"`);
    expect(text(r)).not.toContain("need a job repeat");
    expect(scheduler.ledger()!.listJobs()).toEqual([]);
  });

  it("repeat none queues a one-off task and no job", async () => {
    const { call, scheduler } = await connect();
    const r = await call("schedule_task", {
      prompt: "once",
      deadline: new Date(Date.now() + 6 * 3_600_000).toISOString(),
      repeat: "none",
    });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain("Task persisted");
    expect(scheduler.ledger()!.listJobs()).toEqual([]);
  });
});

describe("schedule_task llm_timeout", () => {
  it("45m on a one-off is stored as 2 700 000 ms, and check_queue_status shows it from task", async () => {
    const { call, scheduler } = await connect();
    const r = await call("schedule_task", { prompt: "long review", deadline: new Date(Date.now() + 6 * 3_600_000).toISOString(), region: "FR", llm_timeout: "45m" });
    expect(r.isError).toBeFalsy();
    const id = /task_id: (\S+)/.exec(text(r))![1]!;
    const row = scheduler.loadPersistedTask(id)!;
    expect(JSON.parse(row.bodyJson!).caps).toEqual({ llmTimeoutMs: 2_700_000, capsVersion: 2 });
    const shown = text(await call("check_queue_status", { task_id: id }));
    expect(shown).toContain("time_limits: LLM 45m (task), if it ran now");
  });

  it("a task with no value shows the setting or the default with its source", async () => {
    const { call } = await connect();
    const r = await call("schedule_task", { prompt: "summary", deadline: new Date(Date.now() + 6 * 3_600_000).toISOString(), region: "FR" });
    const id = /task_id: (\S+)/.exec(text(r))![1]!;
    // From a Claude Code session the provider defaults to claude-code: 30 minutes.
    expect(text(await call("check_queue_status", { task_id: id }))).toContain("time_limits: LLM 30m (default), if it ran now");
  });

  it("reads ~/.tidegap/config at each call: a setting written after connect applies, and a change needs no restart", async () => {
    const { call } = await connect();
    const r = await call("schedule_task", { prompt: "summary", deadline: new Date(Date.now() + 6 * 3_600_000).toISOString(), region: "FR" });
    const id = /task_id: (\S+)/.exec(text(r))![1]!;
    const config = carbonBudgetConfigPath();
    mkdirSync(dirname(config), { recursive: true });
    try {
      writeFileSync(config, "TIDEGAP_LLM_TIMEOUT=20m\n");
      expect(text(await call("check_queue_status", { task_id: id }))).toContain("time_limits: LLM 20m (setting), if it ran now");
      writeFileSync(config, "TIDEGAP_LLM_TIMEOUT=20m\nTIDEGAP_LLM_TIMEOUT_CLAUDE_CODE=1h\n");
      expect(text(await call("check_queue_status", { task_id: id }))).toContain("time_limits: LLM 1h (setting:claude-code), if it ran now");
    } finally {
      rmSync(config, { force: true });
    }
  });

  it("'0' is rejected with the sentence that names none, and nothing is queued", async () => {
    const { call, scheduler } = await connect();
    const r = await call("schedule_task", { prompt: "x", deadline: new Date(Date.now() + 6 * 3_600_000).toISOString(), llm_timeout: "0" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("llm_timeout: 0 is not a time limit; use none for no time limit.");
    expect(scheduler.listPersistedTasks()).toEqual([]);
  });

  it("a job takes it for each run: none is stored on the job", async () => {
    const { call, scheduler } = await connect();
    const r = await call("schedule_task", { prompt: "nightly", repeat: "daily", window: "22:00-08:00", llm_timeout: "none" });
    expect(r.isError).toBeFalsy();
    expect(getJob(scheduler, jobIdOf(r)!)!.caps).toMatchObject({ llmTimeoutMs: "none", capsVersion: 2 });
  });
});

describe("schedule_task retries and retry_delay", () => {
  it("retries 0 and retry_delay 10m are stored on a one-off; check_queue_status shows the policy and each failed attempt", async () => {
    const { call, scheduler } = await connect();
    const r = await call("schedule_task", { prompt: "once", deadline: new Date(Date.now() + 6 * 3_600_000).toISOString(), region: "FR", retries: 0, retry_delay: "10m" });
    expect(r.isError).toBeFalsy();
    const id = /task_id: (\S+)/.exec(text(r))![1]!;
    expect(JSON.parse(scheduler.loadPersistedTask(id)!.bodyJson!).caps).toEqual({ retries: 0, retryDelayMs: 600_000, capsVersion: 2 });
    scheduler.ledger()!.recordEvent(id, {
      kind: "attempt_failed",
      actor: "tick",
      details: { attempt: 1, failure_class: "transient", error: "HTTP 503", retry_at: "2026-11-06T12:00:00.000Z" },
    });
    const shown = text(await call("check_queue_status", { task_id: id }));
    expect(shown).toContain("retries: 0, no automatic retry (task), if it ran now");
    expect(shown).toMatch(/^attempt_1: failed \S+ \(transient\): HTTP 503; next attempt from 2026-11-06T12:00:00.000Z$/m);
  });

  it("retry_delay '0' and retries 11 are rejected with their sentences, and nothing is queued", async () => {
    const { call, scheduler } = await connect();
    const deadline = new Date(Date.now() + 6 * 3_600_000).toISOString();
    const zero = await call("schedule_task", { prompt: "x", deadline, retry_delay: "0" });
    expect(zero.isError).toBe(true);
    expect(text(zero)).toContain("retry_delay: A retry delay must be a duration from 1s to 7d, such as 90s, 30m or 2h; 0 and none are refused.");
    const eleven = await call("schedule_task", { prompt: "x", deadline, retries: 11 });
    expect(eleven.isError).toBe(true);
    expect(scheduler.listPersistedTasks()).toEqual([]);
  });

  it("a job takes them for each slot", async () => {
    const { call, scheduler } = await connect();
    const r = await call("schedule_task", { prompt: "nightly", repeat: "daily", window: "22:00-08:00", retries: 2 });
    expect(getJob(scheduler, jobIdOf(r)!)!.caps).toMatchObject({ retries: 2, capsVersion: 2 });
  });

  it("llm_timeout on an API task over 24 h away notes that a Batch run applies no time limit", async () => {
    const { call } = await connect();
    const r = await call("schedule_task", { prompt: "x", provider: "anthropic", deadline: new Date(Date.now() + 48 * 3_600_000).toISOString(), region: "FR", llm_timeout: "45m" });
    expect(text(r)).toContain("llm_timeout: not applied if the task runs through the provider Batch API");
  });
});

describe("check_queue_status and cancel_task with jobs", () => {
  it("lists the job with its guarantee and next run, and job_id on its run", async () => {
    const { call } = await connect();
    const r = await call("schedule_task", { prompt: "nightly digest", repeat: "daily", window: "22:00-06:00" });
    const jobId = jobIdOf(r)!;
    const summary = text(await call("check_queue_status", {}));
    expect(summary).toContain("Jobs:");
    expect(summary).toMatch(new RegExp(`${jobId} \\| active \\| runs every day between 22:00 and 06:00 \\| next=\\d{4}-`));
    expect(summary).toContain(`job=${jobId}`);
    expect(summary).toContain(`| run=${firstTaskOf(r)!} |`);
    const detail = text(await call("check_queue_status", { task_id: firstTaskOf(r)! }));
    expect(detail).toContain(`job_id: ${jobId}`);
  });

  it("a plain cancel skips the run and the job stays active", async () => {
    const { call, scheduler } = await connect();
    const r = await call("schedule_task", { prompt: "nightly digest", repeat: "daily" });
    const jobId = jobIdOf(r)!;
    const c = await call("cancel_task", { task_id: firstTaskOf(r)! });
    expect(text(c)).toContain("status: cancelled");
    expect(text(c)).not.toContain("ended");
    expect(getJob(scheduler, jobId)!.status).toBe("active");
  });

  it("series=true on a run removes the job", async () => {
    const { call, scheduler } = await connect();
    const r = await call("schedule_task", { prompt: "nightly digest", repeat: "daily" });
    const jobId = jobIdOf(r)!;
    const c = await call("cancel_task", { task_id: firstTaskOf(r)!, series: true });
    expect(c.isError).toBeFalsy();
    expect(text(c)).toContain(`job ${jobId}: ended`);
    expect(getJob(scheduler, jobId)!.status).toBe("removed");
    expect(scheduler.loadPersistedTask(firstTaskOf(r)!)!.status).toBe("cancelled");
    // A second call changes nothing more.
    const again = await call("cancel_task", { task_id: firstTaskOf(r)!, series: true });
    expect(again.isError).toBeFalsy();
    expect(text(await call("check_queue_status", {}))).not.toContain("Jobs:");
  });
});

describe("schedule_task with a job repeat and a wake (KTD8)", () => {
  // A wake needs the default ledger: the sandbox HOME's.
  const home = () => join(homedir(), ".tidegap");
  const ledger = () => join(home(), "queue.db");
  const marker = () => join(home(), "sessions", "wake", SESSION);
  beforeEach(() => mkdirSync(home(), { recursive: true }));
  afterEach(() => rmSync(home(), { recursive: true, force: true }));

  it("repeat daily with wake_session true binds failures; with wake_match binds match; the marker is written", async () => {
    const { call, scheduler } = await connect({ dbPath: ledger() });
    const failures = await call("schedule_task", { prompt: "check the deploy", repeat: "daily", wake_session: true });
    expect(failures.isError).toBeFalsy();
    expect(text(failures)).toContain("wake: on a failure (wakes this session on a run that failed after its retries)");
    expect(getJob(scheduler, jobIdOf(failures)!)).toMatchObject({ wake: { on: "failures" }, originSessionId: SESSION });
    expect(existsSync(marker())).toBe(true);
    const match = await call("schedule_task", { prompt: "check the deploy", repeat: "daily", wake_match: "^ALERT" });
    expect(text(match)).toContain('wake: on a match (wakes this session on a run whose output matches "^ALERT"');
    const job = getJob(scheduler, jobIdOf(match)!)!;
    expect(job).toMatchObject({ wake: { on: "match", pattern: "^ALERT" }, originSessionId: SESSION });
    const run = scheduler.ledger()!.get(job.pendingTaskId!)!;
    expect(run.originSessionId).toBe(SESSION);
    expect(JSON.parse(run.bodyJson!).jobWake).toEqual({ on: "match", session: SESSION });
    expect(JSON.parse(run.bodyJson!).origin).toBeUndefined();
  });

  it("cancel_task of a wake task and cancel_task series=true of a bound job remove the marker; on another ledger nothing is removed", async () => {
    const { call, scheduler } = await connect({ dbPath: ledger() });
    const oneOff = await call("schedule_task", { prompt: "x", deadline: new Date(Date.now() + 3_600_000).toISOString(), wake_session: true });
    const taskId = /task_id: (\S+)/.exec(text(oneOff))![1]!;
    expect(existsSync(marker())).toBe(true);
    await call("cancel_task", { task_id: taskId });
    expect(existsSync(marker())).toBe(false);
    const job = await call("schedule_task", { prompt: "check", repeat: "daily", wake_match: "^ALERT" });
    expect(existsSync(marker())).toBe(true);
    // A plain cancel of a run is a skip: the bound job stays active and keeps the marker.
    await call("cancel_task", { task_id: firstTaskOf(job)! });
    expect(existsSync(marker())).toBe(true);
    const next = getJob(scheduler, jobIdOf(job)!)!.pendingTaskId!;
    const ended = await call("cancel_task", { task_id: next, series: true });
    expect(ended.isError).toBeFalsy();
    expect(text(ended)).toContain(`job ${jobIdOf(job)}: ended`);
    expect(existsSync(marker())).toBe(false);
    // Another ledger: its waiter and its markers are not the default ones.
    const other = await connect();
    const { writeWakeMarker, TaskStore } = await import("@tidegap/core");
    const st = new TaskStore({ dbPath: join(root, "queue.db") });
    st.upsert({
      taskId: "t-other",
      status: "scheduled",
      enqueuedAt: new Date().toISOString(),
      region: "FR",
      originSessionId: SESSION,
      bodyJson: JSON.stringify({ type: "provider_call", provider: "anthropic", model: "m", prompt: "p", origin: { agent: "claude-code" }, handoff: { wake: true } }),
    });
    st.close();
    writeWakeMarker(SESSION);
    await other.call("cancel_task", { task_id: "t-other" });
    expect(existsSync(marker())).toBe(true);
  });

  it("refuses wake_match with wake_session false, wake_match without a job repeat, outside a session, and on another ledger", async () => {
    const { call, scheduler } = await connect({ dbPath: ledger() });
    const off = await call("schedule_task", { prompt: "x", repeat: "daily", wake_session: false, wake_match: "^ALERT" });
    expect(off.isError).toBe(true);
    expect(text(off)).toContain("omit wake_session or set it to true");
    const oneOff = await call("schedule_task", { prompt: "x", deadline: new Date(Date.now() + 3_600_000).toISOString(), wake_match: "^ALERT" });
    expect(oneOff.isError).toBe(true);
    expect(text(oneOff)).toContain("wake_match need a job repeat");
    const outside = await connect({ dbPath: ledger(), outside: true });
    const r = await outside.call("schedule_task", { prompt: "x", repeat: "daily", wake_session: true });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("a wake needs a task queued from a Claude Code session");
    const other = await connect();
    const elsewhere = await other.call("schedule_task", { prompt: "x", repeat: "daily", wake_match: "^ALERT" });
    expect(text(elsewhere)).toContain("wake_match needs the default ledger (~/.tidegap/queue.db)");
    expect(scheduler.ledger()!.listJobs()).toEqual([]);
    expect(existsSync(marker())).toBe(false);
  });
});
