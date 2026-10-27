/**
 * schedule_task job repeats (U10, KTD16), check_queue_status's jobs block
 * and cancel_task series=true on a job's run, through the REAL handlers.
 * No test walks the real process tree: origin sources are injected.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { getJob, mockGridFeed, type JobTemplate } from "@tidegap/core";
import { readCapture } from "@tidegap/cli/session";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEbbServer } from "../src/server.js";

type TextResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

const SESSION = "d76db676-78da-4dca-b20e-1328074e7009";

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

async function connect(opts: { dbPath?: string | null } = {}) {
  const built = createEbbServer({
    feed: mockGridFeed(),
    ...(opts.dbPath === null ? {} : { dbPath: opts.dbPath ?? join(root, "queue.db") }),
    origin: {
      env: { claudeCode: false },
      claudePid: () => 200,
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
