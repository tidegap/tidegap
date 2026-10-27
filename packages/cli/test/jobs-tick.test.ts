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
  TaskStore,
  type JobInput,
} from "@tidegap/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { tryFileLock } from "../src/atomic-file.js";
import { runTickOnce, TICK_BUSY_MESSAGE, type TickCommandOptions } from "../src/commands/tick.js";
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
      loginShell: () => undefined,
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

  it("covers AE6: the summarize step runs claude with --tools \"\" and no --allowedTools; receipt tools []", async () => {
    const { taskId } = await dueJob({
      template: { runner: "command", command: "echo disk 42%", cwd: root, secrets: [], summarize: { prompt: "anything odd?", provider: "claude-code" } },
    });
    const r = await runTickOnce(tickOpts());
    expect(r.message).toContain("1 dispatched, 0 failed");
    const args = argv();
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args).not.toContain("--allowedTools");
    expect(args).not.toContain("--resume");
    expect(readFileSync(join(log, "stdin"), "utf8")).toBe("anything odd?\n\nCommand output:\n```\ndisk 42%\n\n```");
    const done = ledger((s) => s.get(taskId)!);
    expect(done.status).toBe("completed");
    expect(done.receipt).toMatchObject({ provider: "claude-code", tools: [] });
    expect((done.result as { text: string }).text).toBe("OK");
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
