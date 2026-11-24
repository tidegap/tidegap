/**
 * End to end: `tidegap tick` runs job occurrences (jobs U6, KTD2, KTD6,
 * KTD8). A command job through the `command` adapter, its summarize step
 * through a fake `claude`, a prompt job fresh in its directory, the
 * successor in the same tick, secrets kept out of the ledger, a busy tick
 * that keeps readiness recent, and the sleep counter on the dispatch.
 * Hermetic HOME (test setup), temp ledger, no network.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assessReadiness,
  createJob,
  JOB_INTERRUPTED_ERROR,
  LAST_TICK_META_KEY,
  mockGridFeed,
  readTickSleep,
  Scheduler,
  taskResultText,
  TaskStore,
  taskSummaryError,
  taskSummaryText,
  type JobInput,
} from "@tidegap/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { tryFileLock } from "../src/atomic-file.js";
import { runJobsAction, runJobsEdit, runJobsHistory, runJobsShow } from "../src/commands/jobs.js";
import { runTick, runTickOnce, TICK_BUSY_MESSAGE, type TickCommandOptions } from "../src/commands/tick.js";
import { setJobSecret } from "../src/jobs/secrets.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(HERE, "fixtures", "fake-claude");
const JOB = join(HERE, "fixtures", "fake-job", "job.sh");
const SECRET = "imap-fixture-Q7f3kLm9";
const VARS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "OLLAMA_HOST",
  "TIDEGAP_CLAUDE_BIN",
  "TIDEGAP_CLAUDE_CODE",
  "FAKE_CLAUDE_MODE",
  "FAKE_CLAUDE_LOG",
] as const;

let root: string;
let dbPath: string;
let log: string;
let secretsFile: string;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const k of VARS) {
    saved.set(k, process.env[k]);
    delete process.env[k];
  }
  root = realpathSync(mkdtempSync(join(tmpdir(), "tidegap-jobs-tick-")));
  dbPath = join(root, "queue.db");
  log = join(root, "log");
  secretsFile = join(root, "cfg", "job-secrets.json");
  cpSync(FAKE_CLAUDE, join(root, "bin"), { recursive: true });
  process.env.FAKE_CLAUDE_LOG = log;
});

afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  saved.clear();
  rmSync(root, { recursive: true, force: true });
});

function tickOpts(extra: Partial<TickCommandOptions> = {}): TickCommandOptions {
  return {
    db: dbPath,
    envFile: join(root, "no-env"),
    notify: false,
    jobSecretsFile: secretsFile,
    sleepNow: null,
    claudeLookup: {
      path: join(root, "bin"),
      home: join(root, "home"),
      platform: "linux",
      isExecutable: (p) => p.startsWith(root) && existsSync(p),
      loginShell: async () => undefined,
    },
    ...extra,
  };
}

/** Create a job and expedite its first occurrence; returns the job id and that occurrence's id. */
async function dueJob(input: Partial<JobInput> & Pick<JobInput, "template">): Promise<{ jobId: string; taskId: string }> {
  const s = new Scheduler({ dbPath, feed: mockGridFeed(), signing: false });
  try {
    const job = await createJob(s, { title: "Test job", cadence: { kind: "daily" }, timeZone: "UTC", ...input }, { actor: "cli" });
    const taskId = s.ledger()!.getJob(job.jobId)!.pendingTaskId!;
    s.runNow(taskId);
    return { jobId: job.jobId, taskId };
  } finally {
    s.shutdown();
  }
}

function ledger<T>(fn: (store: TaskStore) => T): T {
  const store = new TaskStore({ dbPath });
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

const argv = (): string[] => readFileSync(join(log, "argv"), "utf8").split("\n").slice(0, -1);

describe("tidegap jobs run and the last run, through the tick (fake time)", () => {
  // A Friday 08:07:30 UTC, off any quarter hour; the planned run is in today's 10:00-11:00 UTC window.
  const NOW = Date.parse("2026-11-20T08:07:30.000Z");
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  const jobsOpts = () => ({ db: dbPath, feed: mockGridFeed() });

  /** A daily command job with a 10:00-11:00 UTC window; returns its id. */
  async function windowJob(extra: Partial<JobInput> = {}): Promise<string> {
    const s = new Scheduler({ dbPath, feed: mockGridFeed(), signing: false });
    try {
      const template = { runner: "command" as const, command: "echo ok", cwd: root, secrets: [] };
      const input: JobInput = { title: "Daily report", cadence: { kind: "daily" }, window: { start: "10:00", end: "11:00" }, timeZone: "UTC", template, ...extra };
      return (await createJob(s, input, { actor: "cli" })).jobId;
    } finally {
      s.shutdown();
    }
  }

  it("jobs run leaves the planned occurrence: the tick runs only the extra run, the planned row keeps its slot, show and history mark the run", async () => {
    const jobId = await windowJob();
    const planned = ledger((s) => s.get(`${jobId}~1`)!);
    expect(await runJobsAction("run", jobId, jobsOpts())).toBe(
      `${jobId}: extra run ${jobId}~2x runs on the next tick; the planned run ${jobId}~1 keeps its time (${planned.scheduledFor})`,
    );
    const r = await runTickOnce(tickOpts());
    expect(r.message).toContain("1 dispatched, 0 failed");
    expect(ledger((s) => s.get(`${jobId}~2x`)!.status)).toBe("completed");
    expect(ledger((s) => s.get(`${jobId}~1`))).toMatchObject({
      status: "scheduled",
      notBefore: planned.notBefore,
      scheduledFor: planned.scheduledFor,
      deadline: planned.deadline,
    });
    expect(ledger((s) => s.getJob(jobId))).toMatchObject({
      pendingTaskId: `${jobId}~1`,
      extraTaskId: undefined,
      lastTaskId: `${jobId}~2x`,
      lastOutcome: "ok",
      lastRunStartedAt: undefined,
      nextSeq: 3,
    });
    expect(ledger((s) => s.list({ jobId }).map((t) => t.taskId))).toEqual([`${jobId}~1`, `${jobId}~2x`]);
    const shown = await runJobsShow(jobId, jobsOpts());
    expect(shown).toContain(`\nnext run: planned ${planned.scheduledFor}, deadline ${planned.deadline} (${jobId}~1)\n`);
    expect(shown).toMatch(new RegExp(`\\nlast run: ok \\S+.* \\(${jobId}~2x, run now\\)`));
    const history = (await runJobsHistory(jobId, jobsOpts())).split("\n");
    expect(history.find((l) => l.startsWith(`${jobId}~2x `))).toMatch(/ completed .+ run now$/);
    expect(history.find((l) => l.startsWith(`${jobId}~1 `))).not.toMatch(/run now$/);
  });

  it("an extra run does not count toward --count: a job with one run left stays active with its planned run", async () => {
    const jobId = await windowJob({ count: 1 });
    await runJobsAction("run", jobId, jobsOpts());
    await runTickOnce(tickOpts());
    expect(ledger((s) => s.get(`${jobId}~2x`)!.status)).toBe("completed");
    expect(ledger((s) => s.getJob(jobId))).toMatchObject({ status: "active", runsLeft: 1, pendingTaskId: `${jobId}~1`, lastTaskId: `${jobId}~2x` });
    expect(ledger((s) => s.get(`${jobId}~1`)!.status)).toBe("scheduled");
  });

  it("last run after an edit's cancel names the run that ran, with its own times; history still lists the cancelled one", async () => {
    const jobId = await windowJob();
    const s = new Scheduler({ dbPath, feed: mockGridFeed(), signing: false });
    try {
      s.runNow(`${jobId}~1`);
    } finally {
      s.shutdown();
    }
    vi.setSystemTime(NOW + 60_000);
    await runTickOnce(tickOpts());
    const ran = ledger((st) => st.get(`${jobId}~1`)!);
    expect(ran.status).toBe("completed");
    expect(ledger((st) => st.getJob(jobId)!.pendingTaskId)).toBe(`${jobId}~2`);
    vi.setSystemTime(NOW + 2 * 60_000);
    await runJobsEdit(jobId, { ...jobsOpts(), title: "Renamed" });
    expect(ledger((st) => st.get(`${jobId}~2`)!.status)).toBe("cancelled");
    const view = JSON.parse(await runJobsShow(jobId, { ...jobsOpts(), json: true })) as { last_run: Record<string, unknown> };
    expect(view.last_run).toMatchObject({
      task_id: `${jobId}~1`,
      outcome: "ok",
      started_at: new Date(NOW + 60_000).toISOString(),
      completed_at: ran.completedAt,
    });
    expect((await runJobsShow(jobId, jobsOpts())).split("\n")).toContain(`last run: ok ${ran.completedAt}, "ok" (${jobId}~1)`);
    expect((await runJobsHistory(jobId, jobsOpts())).split("\n").find((l) => l.startsWith(`${jobId}~2 `))).toMatch(/ cancelled /);
    // A job row an older version wrote: the outcome of the run before, the id of the cancelled occurrence.
    ledger((st) => {
      const job = st.getJob(jobId)!;
      expect(st.updateJobIf({ ...job, lastTaskId: `${jobId}~2`, revision: job.revision + 1 }, job.revision)).toBe(true);
    });
    const legacy = JSON.parse(await runJobsShow(jobId, { ...jobsOpts(), json: true })) as { last_run: Record<string, unknown> };
    expect(legacy.last_run).toMatchObject({ task_id: `${jobId}~1`, outcome: "ok", completed_at: ran.completedAt });
  });
});

describe("tidegap tick with jobs", () => {
  it("runs a command job: result, provider command receipt with zero tokens, and the successor in the same tick", async () => {
    const { jobId, taskId } = await dueJob({ template: { runner: "command", command: "echo ok", cwd: root, secrets: [] } });
    const r = await runTickOnce(tickOpts());
    expect(r.message).toContain("1 dispatched, 0 failed");
    const done = ledger((s) => s.get(taskId)!);
    expect(done.status).toBe("completed");
    expect((done.result as { text: string }).text).toBe("ok");
    expect(done.receipt).toMatchObject({ provider: "command", model: "none", totalTokens: 0 });
    expect(r.message).toContain(`materialized job occurrence ${jobId}~2`);
    expect(ledger((s) => s.getJob(jobId))).toMatchObject({ pendingTaskId: `${jobId}~2`, lastOutcome: "ok" });
    const completed = ledger((s) => s.listTaskEvents(taskId)).find((e) => e.kind === "completed")!;
    expect(completed.details).toMatchObject({ steps: ["command"] });
  });

  it("covers AE1: a job's last run ends it; the tick sends one job-ended toast in place of the run's own", async () => {
    const { jobId, taskId } = await dueJob({ template: { runner: "command", command: "echo ok", cwd: root, secrets: [] }, count: 1 });
    const toasts: string[][] = [];
    const r = await runTickOnce(tickOpts({ notify: true, platform: "linux", spawnNotify: (_cmd, args) => void toasts.push([...args]) }));
    expect(r.message).toContain(`ended job ${jobId}`);
    expect(ledger((s) => s.getJob(jobId))).toMatchObject({ status: "ended", endReason: "count", pendingTaskId: undefined });
    expect(ledger((s) => s.getJob(jobId))!.endNotifiedAt).toBeDefined();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toContain("🏁 Tidegap: job ended");
    expect(toasts[0]!.join("\n")).toContain(`"Test job" ended: its runs are done.\nLast run: ${taskId} ok: ok`);
    // A second tick sends nothing more.
    await runTickOnce(tickOpts({ notify: true, platform: "linux", spawnNotify: (_cmd, args) => void toasts.push([...args]) }));
    expect(toasts).toHaveLength(1);
  });

  it("a job run's toast: the status emoji and the job title, then the verdict and the grams line", async () => {
    process.env.FAKE_CLAUDE_MODE = "notice";
    const { taskId } = await dueJob({
      title: "Signup funnel monitor",
      template: { runner: "command", command: "echo visits ok", cwd: root, secrets: [], summarize: { prompt: "anything odd?", provider: "claude-code" } },
    });
    const toasts: string[][] = [];
    await runTickOnce(tickOpts({ notify: true, platform: "linux", spawnNotify: (_cmd, args) => void toasts.push([...args]) }));
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toContain("⚠️ Signup funnel monitor");
    const body = toasts[0]!.find((a) => a.startsWith("Referral share dropped"));
    expect(body?.split("\n")).toEqual(["Referral share dropped; the rest is normal.", expect.stringMatching(new RegExp(`gCO2e · tidegap queue show ${taskId}$`))]);
  });

  it("covers AE6: the summarize step runs claude with --tools \"\" and no --allowedTools; receipt tools []; the text stays raw", async () => {
    const { taskId } = await dueJob({
      template: { runner: "command", command: "echo disk 42%", cwd: root, secrets: [], summarize: { prompt: "anything odd?", provider: "claude-code" } },
    });
    const r = await runTickOnce(tickOpts());
    expect(r.message).toContain("1 dispatched, 0 failed");
    const args = argv();
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args).not.toContain("--allowedTools");
    expect(args).not.toContain("--resume");
    expect(readFileSync(join(log, "stdin"), "utf8")).toBe("anything odd?\n\nJob title: Test job\n\nCommand output:\n```\ndisk 42%\n\n```");
    const done = ledger((s) => s.get(taskId)!);
    expect(done.status).toBe("completed");
    expect(done.receipt).toMatchObject({ provider: "claude-code", tools: [] });
    expect(done.receipt!.model).not.toBe("none");
    expect(done.receipt!.totalTokens).toBeGreaterThan(0);
    expect(taskResultText(done)).toBe("disk 42%");
    expect(taskSummaryText(done)).toBe("OK");
    expect(taskSummaryError(done)).toBeUndefined();
  });

  it("a summarize step over its budget: the run completes once with the raw text, a summaryError and a command-only receipt", async () => {
    const counter = join(root, "runs");
    const { taskId } = await dueJob({
      template: { runner: "command", command: `echo run >> ${counter}; echo disk 42%`, cwd: root, secrets: [], summarize: { prompt: "anything odd?", provider: "claude-code" } },
    });
    process.env.FAKE_CLAUDE_MODE = "budget";
    const r = await runTickOnce(tickOpts());
    expect(r.message).toContain("1 dispatched, 0 failed");
    const done = ledger((s) => s.get(taskId)!);
    expect(done.status).toBe("completed");
    expect(taskResultText(done)).toBe("disk 42%");
    expect(taskSummaryText(done)).toBeUndefined();
    expect(taskSummaryError(done)).toMatch(/^summarize: /);
    expect(done.receipt).toMatchObject({ provider: "command", model: "none", totalTokens: 0 });
    expect(readFileSync(counter, "utf8")).toBe("run\n");
  });

  it("covers AE7: the secret reaches the command; the ledger stores [redacted] and never the value", async () => {
    setJobSecret("IMAP_PASSWORD", SECRET, secretsFile);
    const ok = await dueJob({ template: { runner: "command", command: `${JOB} --env IMAP_PASSWORD`, cwd: root, secrets: ["IMAP_PASSWORD"] } });
    const bad = await dueJob({
      title: "Failing job",
      template: { runner: "command", command: `${JOB} --stderr "auth failed: $IMAP_PASSWORD" --exit 1`, cwd: root, secrets: ["IMAP_PASSWORD"] },
    });
    const r = await runTickOnce(tickOpts());
    expect(r.message).not.toContain(SECRET);
    expect((ledger((s) => s.get(ok.taskId)!).result as { text: string }).text).toBe("IMAP_PASSWORD=[redacted]");
    expect(ledger((s) => s.get(bad.taskId)!)).toMatchObject({ status: "failed", error: "command exited with code 1; stderr: auth failed: [redacted]" });
    // Every file the tick left under the sandbox (ledger, WAL, logs), except the secrets file itself.
    const files = readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => join(e.parentPath, e.name))
      .filter((f) => f !== secretsFile);
    expect(files).toContain(dbPath);
    for (const file of files) expect(readFileSync(file).includes(SECRET), file).toBe(false);
  });

  it("a prompt job with files runs fresh in its directory: no --resume, no --fork-session, Read scoped to it", async () => {
    const notes = join(root, "notes");
    mkdirSync(notes);
    writeFileSync(join(notes, "todo.md"), "buy milk\n");
    const { taskId } = await dueJob({ template: { runner: "prompt", prompt: "summarize todo.md", provider: "claude-code", cwd: notes, tools: "files" } });
    const r = await runTickOnce(tickOpts());
    expect(r.message).toContain("1 dispatched, 0 failed");
    expect(readFileSync(join(log, "cwd"), "utf8").trim()).toBe(notes);
    const args = argv();
    expect(args).not.toContain("--resume");
    expect(args).not.toContain("--fork-session");
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Grep,Glob");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe(`Read(/${notes}/**)`);
    expect(ledger((s) => s.get(taskId)!).status).toBe("completed");
  });

  it("the dispatched event stores the tick's sleep counter, for the awake-time age", async () => {
    const { taskId } = await dueJob({ template: { runner: "command", command: "true", cwd: root, secrets: [] } });
    await runTickOnce(tickOpts({ sleepNow: { boot_at: 1_000, slept_ms: 42 } }));
    const dispatched = ledger((s) => s.listTaskEvents(taskId)).find((e) => e.kind === "dispatched")!;
    expect(dispatched.details.sleep).toEqual({ boot_at: 1_000, slept_ms: 42 });
  });

  it("a busy tick (a long job run holds the lock) keeps readiness recent", async () => {
    ledger((s) => s.setMeta(LAST_TICK_META_KEY, new Date(Date.now() - 15 * 60_000).toISOString()));
    const lock = tryFileLock(`${dbPath}.tick`, 60_000)!;
    try {
      expect((await runTickOnce(tickOpts({ sleepNow: { boot_at: 1_000, slept_ms: 42 } }))).message).toBe(TICK_BUSY_MESSAGE);
    } finally {
      lock.release();
    }
    const lastTickAt = ledger((s) => s.getMeta(LAST_TICK_META_KEY));
    // The sleep reading moves with last_tick_at, so readiness can still pair them.
    expect(ledger((s) => readTickSleep(s))).toEqual({ boot_at: 1_000, slept_ms: 42, at: Date.parse(lastTickAt!) });
    const readiness = assessReadiness({ daemon: "loaded", lastTickAt, runners: null, pendingByProvider: {}, tickIntervalS: 60 });
    expect(readiness.ticker.recent).toBe(true);
  });

  it("with no LLM adapter, the sweep still frees a command run left running by a dead tick", async () => {
    const { taskId } = await dueJob({ template: { runner: "command", command: "echo ok", cwd: root, secrets: [] } });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() - 60 * 60_000);
      ledger((s) => {
        expect(s.claimScheduled(taskId)).toBe(true);
        s.recordEvent(taskId, { kind: "dispatched", actor: "tick" });
      });
    } finally {
      vi.useRealTimers();
    }
    const base = tickOpts();
    await runTickOnce({ ...base, claudeLookup: { ...base.claudeLookup!, isExecutable: () => false } });
    expect(ledger((s) => s.get(taskId))).toMatchObject({ status: "failed", error: JOB_INTERRUPTED_ERROR });
    expect(ledger((s) => s.get(`${taskId}r`))).toBeDefined();
  });

  it("with no LLM adapter, a due anthropic row stays scheduled with no failed event; the command occurrence still runs", async () => {
    const cmd = await dueJob({ template: { runner: "command", command: "echo ok", cwd: root, secrets: [] } });
    const prompt = await dueJob({ title: "Mail", template: { runner: "prompt", prompt: "check my mail", provider: "anthropic", tools: "none" } });
    const base = tickOpts();
    const r = await runTickOnce({ ...base, claudeLookup: { ...base.claudeLookup!, isExecutable: () => false } });
    expect(r.message).toContain("1 dispatched, 0 failed");
    expect(ledger((s) => s.get(cmd.taskId)!.status)).toBe("completed");
    expect(ledger((s) => s.get(prompt.taskId)!.status)).toBe("scheduled");
    expect(ledger((s) => s.listTaskEvents(prompt.taskId)).map((e) => e.kind)).not.toContain("failed");
  });

  it("with an Anthropic key, a due openai row still fails with the no-adapter message", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const prompt = await dueJob({ title: "Mail", template: { runner: "prompt", prompt: "check my mail", provider: "openai", tools: "none" } });
    const base = tickOpts();
    const r = await runTickOnce({ ...base, claudeLookup: { ...base.claudeLookup!, isExecutable: () => false } });
    expect(r.message).toContain("0 dispatched, 1 failed");
    expect(ledger((s) => s.get(prompt.taskId))).toMatchObject({
      status: "failed",
      error: expect.stringContaining("no adapter configured for provider openai"),
    });
  });
});

describe("tidegap tick --daemon and a stop signal", () => {
  /**
   * Polls `check` every 50 ms until it holds. The test's own timeout bounds
   * the wait, so a slow machine waits longer instead of failing; the timer
   * is unref'd, so a poll a timed-out test left behind holds no worker open.
   */
  async function until(check: () => boolean): Promise<void> {
    while (!check()) await new Promise((r) => setTimeout(r, 50).unref());
  }

  /**
   * Starts the daemon with a one-hour interval. `stop(signal)` calls the
   * listeners for that signal added since the start (the daemon's, and the
   * runner's while a command runs), as a real signal would, without
   * signalling the test worker. The daemon gets a fake exit, which records
   * its code: a forced exit must never end the test worker.
   */
  function startDaemon(tick: typeof runTick = runTick) {
    const before = new Map((["SIGTERM", "SIGINT"] as const).map((s) => [s, new Set(process.listeners(s))]));
    const logged: string[] = [];
    const errors: string[] = [];
    const exits: number[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => void logged.push(String(line)));
    const errSpy = vi.spyOn(console, "error").mockImplementation((line: unknown) => void errors.push(String(line)));
    const exit = tick({ ...tickOpts(), daemon: true, interval: 3600, exit: (code) => void exits.push(code) });
    const stop = (signal: "SIGTERM" | "SIGINT" = "SIGTERM") => {
      for (const l of process.listeners(signal)) if (!before.get(signal)!.has(l)) (l as (s: NodeJS.Signals) => void)(signal);
    };
    /** The daemon's exit code, once it exits; a daemon that never exits fails the test by its timeout. */
    const exited = () =>
      exit.finally(() => {
        spy.mockRestore();
        errSpy.mockRestore();
      });
    current = { stop, exited };
    return { logged, errors, exits, stop, exited };
  }

  let current: { stop: () => void; exited: () => Promise<number> } | undefined;
  // A failed assertion must not leave the daemon asleep for an hour with its listeners on.
  // The hook waits for the exit, so it gets more than vitest's 10 s hook default.
  afterEach(async () => {
    current?.stop();
    await current?.exited();
    current = undefined;
  }, 30_000);

  it("the interval sleep wakes on the signal: the daemon exits at once, not after the interval", async () => {
    const daemon = startDaemon();
    await until(() => daemon.logged.some((l) => l.startsWith("tick:")));
    daemon.stop();
    expect(await daemon.exited()).toBe(0);
    expect(daemon.logged.filter((l) => l.startsWith("tick:"))).toHaveLength(1);
    expect(daemon.exits).toEqual([]);
  }, 15_000);

  it("covers AE2: a command the stop ended fails as interrupted with class interrupted, and the next sweep makes its retry row", async () => {
    const started = join(root, "started");
    const { taskId } = await dueJob({ template: { runner: "command", command: `echo $$ >> ${started}; sleep 30`, cwd: root, secrets: [] } });
    // The runner keeps a stop for its module's lifetime: this one gets a module of its own, so other tests' stops cannot reach it.
    vi.resetModules();
    const fresh = await import("../src/commands/tick.js");
    const daemon = startDaemon(fresh.runTick);
    await until(() => existsSync(started));
    daemon.stop();
    expect(await daemon.exited()).toBe(0);
    expect(ledger((s) => s.get(taskId))).toMatchObject({ status: "failed", error: JOB_INTERRUPTED_ERROR });
    const failed = ledger((s) => s.listTaskEvents(taskId)).find((e) => e.kind === "failed")!;
    expect(failed.details).toMatchObject({ failure_class: "interrupted" });
    await runTickOnce(tickOpts());
    expect(ledger((s) => s.get(`${taskId}r`))).toBeDefined();
  }, 15_000);

  it("after the signal the tick dispatches no further due job; the running one is stopped", async () => {
    const started = join(root, "started");
    const template = { runner: "command" as const, command: `echo $$ >> ${started}; sleep 30`, cwd: root, secrets: [] };
    const a = await dueJob({ template });
    const b = await dueJob({ title: "Second job", template });
    const daemon = startDaemon();
    await until(() => existsSync(started));
    daemon.stop();
    expect(await daemon.exited()).toBe(0);
    expect(readFileSync(started, "utf8").trim().split("\n")).toHaveLength(1);
    const statuses = [a.taskId, b.taskId].map((id) => ledger((s) => s.get(id)!.status));
    expect(statuses).toContain("scheduled");
    expect(statuses).not.toContain("completed");
  }, 15_000);

  describe("a second stop signal while a claude -p run is in flight (KD1, R9)", () => {
    const lockFile = () => `${dbPath}.tick.lock`;

    /** The fake's pid, which is its group id; 0 while its pid file is missing or half-written. */
    function fakePid(): number {
      try {
        const pid = Number(readFileSync(join(log, "pid"), "utf8").trim());
        return pid > 1 ? pid : 0;
      } catch {
        return 0;
      }
    }

    /** Polls every 50 ms, up to `ms`, until the fake has written its pid; returns it, or 0. */
    async function fakePidWithin(ms: number): Promise<number> {
      for (let i = 0; i < ms / 50 && fakePid() === 0; i++) await new Promise((r) => setTimeout(r, 50));
      return fakePid();
    }

    /** Starts the daemon on a due prompt job whose fake `claude` sleeps; resolves once the fake runs, with its row and group id. */
    async function stalledRun() {
      process.env.FAKE_CLAUDE_MODE = "sleep";
      const { taskId } = await dueJob({ template: { runner: "prompt", prompt: "hi", provider: "claude-code", tools: "none" } });
      const daemon = startDaemon();
      // Under a full parallel test run the daemon can take more than 5 s to reach the spawn.
      return { daemon, taskId, group: await fakePidWithin(10_000) };
    }

    /**
     * SIGKILL to the fake's group: the fake exit left the daemon running, so
     * the test ends the dispatch. A fake that started after the start check
     * gave up is still found and killed, so it cannot outlive the test.
     */
    async function killGroup(pgid: number): Promise<void> {
      if (pgid <= 1) pgid = await fakePidWithin(5_000);
      if (pgid <= 1) return; // never kill(0) or kill(-1)
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }

    it.each([
      ["SIGTERM", 143],
      ["SIGINT", 130],
    ] as const)("a second %s a second after the first exits with %i: the row fails as interrupted and the lock is gone", async (signal, code) => {
      const { daemon, taskId, group } = await stalledRun();
      try {
        expect(group).toBeGreaterThan(1);
        daemon.stop(signal);
        expect(daemon.exits).toEqual([]);
        vi.useFakeTimers({ toFake: ["Date"] });
        try {
          vi.setSystemTime(Date.now() + 1_500);
          daemon.stop(signal);
        } finally {
          vi.useRealTimers();
        }
        expect(daemon.exits).toEqual([code]);
        expect(daemon.errors).toEqual([expect.stringContaining(`second ${signal}`)]);
        expect(ledger((s) => s.get(taskId))).toMatchObject({ status: "failed", error: JOB_INTERRUPTED_ERROR });
        expect(existsSync(lockFile())).toBe(false);
      } finally {
        await killGroup(group);
      }
      expect(await daemon.exited()).toBe(0);
      expect(daemon.exits).toHaveLength(1);
    }, 25_000);

    it("two SIGINTs back to back (a forwarded copy) leave the daemon running and call no exit", async () => {
      const { daemon, taskId, group } = await stalledRun();
      try {
        expect(group).toBeGreaterThan(1);
        daemon.stop("SIGINT");
        daemon.stop("SIGINT");
        expect(daemon.exits).toEqual([]);
        expect(ledger((s) => s.get(taskId)!.status)).toBe("running");
        expect(existsSync(lockFile())).toBe(true);
      } finally {
        await killGroup(group);
      }
      expect(await daemon.exited()).toBe(0);
      expect(daemon.exits).toEqual([]);
    }, 25_000);
  });
});
