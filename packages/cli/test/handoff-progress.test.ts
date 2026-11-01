/**
 * Progress lines of a command run: the runner's line callback (the newest
 * whole line of each output chunk, never one the output cap cut), the
 * command adapter's scrub before the callback, and a command job's progress
 * events through `tidegap tick`.
 */

import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createJob, DEFAULT_JOB_CAPS, mockGridFeed, Scheduler, TaskStore, type ProviderAdapter } from "@tidegap/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runTickOnce, type TickCommandOptions } from "../src/commands/tick.js";
import { childEnv, runShell } from "../src/jobs/run-shell.js";
import { setJobSecret } from "../src/jobs/secrets.js";
import { CommandAdapter } from "../src/providers/command.js";

const SECRET = "imap-fixture-Q7f3kLm9";
const KEY = "sk-ant-FIXTURE-not-a-real-key-0000000000";

let root: string;
const realSleep = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

/** Polls `check` on the real clock every 20 ms, up to 10 s. */
async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (check()) return;
    await realSleep(20);
  }
  throw new Error(`timed out waiting for ${what}`);
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "tidegap-progress-")));
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

/** Runs `command` in `root` and returns the lines the callback got. */
async function lines(command: string, outputCapBytes = 1024 * 1024): Promise<{ got: string[]; stdout: string }> {
  const got: string[] = [];
  const run = await runShell({
    command,
    cwd: root,
    env: childEnv(process.env, {}),
    timeoutMs: 10_000,
    outputCapBytes,
    onLine: (l) => got.push(l),
  });
  return { got, stdout: run.stdout };
}

describe("runShell onLine", () => {
  it("passes whole lines only: a line split across chunks arrives once, joined", async () => {
    const { got, stdout } = await lines("printf 'hel'; sleep 0.3; printf 'lo\\nwor'; sleep 0.3; printf 'ld\\n'");
    expect(stdout).toBe("hello\nworld\n");
    expect(got).toEqual(["hello", "world"]);
  });

  it("a line the output cap cuts is never passed; whole lines before the cut are", async () => {
    expect((await lines("printf 'abc\\n0123456789\\nxyz\\n'", 8)).got).toEqual(["abc"]);
    expect((await lines("printf '0123456789ABC\\nxyz\\n'", 10)).got).toEqual([]);
    // A line that ends exactly at the cap is whole.
    expect((await lines("printf 'abcdefg\\nrest\\n'", 8)).got).toEqual(["abcdefg"]);
  });

  it("an open last line without a newline is not passed, and a throwing callback does not break the run", async () => {
    const got: string[] = [];
    const run = await runShell({
      command: "printf 'one\\n'; sleep 0.2; printf 'tail'",
      cwd: root,
      env: childEnv(process.env, {}),
      timeoutMs: 10_000,
      outputCapBytes: 1024,
      onLine: (l) => {
        got.push(l);
        throw new Error("callback failed");
      },
    });
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("one\ntail");
    expect(got).toEqual(["one"]);
  });

  it("a blank line, or one of terminal codes only, never hides the line before it", async () => {
    const { got } = await lines("for i in 1 2 3; do printf 'step %s\\n\\n   \\n' $i; sleep 0.2; done; printf 'build ok\\n\\033[0m\\n'");
    expect(got.length).toBeGreaterThan(0);
    for (const l of got) expect(l).toMatch(/^(step [123]|build ok)$/);
    expect(got.at(-1)).toBe("build ok");
  });
});

describe("command adapter progress", () => {
  it("a progress line holding a job secret value or a vendor key shape is scrubbed", async () => {
    const adapter = new CommandAdapter({
      adapters: {},
      jobRunner: (id) => (id === "job-1" ? "command" : undefined),
      readSecrets: () => ({ values: { QA_SECRET: SECRET }, missing: [] }),
      home: root,
    });
    const got: string[] = [];
    const res = await adapter.dispatch("none", "", {
      jobId: "job-1",
      command: { run: `echo "login with $QA_SECRET and ${KEY}"`, cwd: root, secrets: ["QA_SECRET"] },
      caps: { ...DEFAULT_JOB_CAPS },
      onProgress: (l) => got.push(l),
    });
    expect(got).toHaveLength(1);
    expect(got[0]).not.toContain(SECRET);
    expect(got[0]).not.toContain(KEY);
    expect(got[0]).toBe("login with [redacted] and [REDACTED]");
    // The outcome is scrubbed as before.
    expect(res.text).toBe(got[0]);
  });

  it("a control character inside a secret is removed before the scrub, so it cannot join the secret afterwards", async () => {
    const adapter = new CommandAdapter({
      adapters: {},
      jobRunner: (id) => (id === "job-1" ? "command" : undefined),
      readSecrets: () => ({ values: { QA_SECRET: SECRET }, missing: [] }),
      home: root,
    });
    const split = (v: string) => `${v.slice(0, 8)}\\001${v.slice(8)}`;
    const got: string[] = [];
    await adapter.dispatch("none", "", {
      jobId: "job-1",
      command: { run: `printf 'login with ${split(SECRET)} and ${split(KEY)}\\n'`, cwd: root, secrets: ["QA_SECRET"] },
      caps: { ...DEFAULT_JOB_CAPS },
      onProgress: (l) => got.push(l),
    });
    expect(got).toEqual(["login with [redacted] and [REDACTED]"]);
  });

  it("progress ends with the shell step: a summarize step after it reports nothing", async () => {
    const order: string[] = [];
    const llm: ProviderAdapter = {
      provider: "anthropic",
      ready: true,
      async dispatch() {
        order.push("summarize");
        return { text: "fine", model: "m", provider: "anthropic", raw: null };
      },
    };
    const adapter = new CommandAdapter({
      adapters: { anthropic: llm },
      jobRunner: (id) => (id === "job-1" ? "command" : undefined),
      readSecrets: () => ({ values: {}, missing: [] }),
      home: root,
    });
    await adapter.dispatch("m", "anything odd?", {
      jobId: "job-1",
      command: { run: "echo quick", cwd: root, secrets: [] },
      summarize: { provider: "anthropic", model: "m" },
      caps: { ...DEFAULT_JOB_CAPS },
      onProgress: (l) => order.push(`line ${l}`),
      onProgressEnd: () => order.push("end"),
    });
    expect(order).toEqual(["line quick", "end", "summarize"]);
  });
});

describe("command job progress through tidegap tick", () => {
  it("a command job run reports progress too, and its outcome is recorded as before", async () => {
    const dbPath = join(root, "queue.db");
    const secretsFile = join(root, "cfg", "job-secrets.json");
    setJobSecret("QA_SECRET", SECRET, secretsFile);
    const started = join(root, "started");
    const go = join(root, "go");
    const go2 = join(root, "go2");
    // The shell waits for files the test writes, so the order of events does not depend on load.
    const command = [
      `echo started > ${started}`,
      `while [ ! -f ${go} ]; do sleep 0.02; done`,
      `echo "copying 1 of 2 with $QA_SECRET"`,
      `while [ ! -f ${go2} ]; do sleep 0.02; done`,
      "echo done",
    ].join("; ");
    const s = new Scheduler({ dbPath, feed: mockGridFeed(), signing: false });
    let taskId: string;
    try {
      const job = await createJob(
        s,
        { title: "Progress job", cadence: { kind: "daily" }, timeZone: "UTC", template: { runner: "command", command, cwd: root, secrets: ["QA_SECRET"] } },
        { actor: "cli" },
      );
      taskId = s.ledger()!.getJob(job.jobId)!.pendingTaskId!;
      s.runNow(taskId);
    } finally {
      s.shutdown();
    }
    const progress = () => {
      const store = new TaskStore({ dbPath });
      try {
        return store.listTaskEvents(taskId).filter((e) => e.kind === "progress");
      } finally {
        store.close();
      }
    };
    // Only the clock the caps read stands still and moves when the test says; timers stay real.
    const t0 = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(t0);
    const opts: TickCommandOptions = { db: dbPath, envFile: join(root, "no-env"), notify: false, jobSecretsFile: secretsFile, sleepNow: null };
    const tick = runTickOnce(opts);
    await until(() => existsSync(started) && readFileSync(started, "utf8") === "started\n", "the command to start");
    vi.setSystemTime(t0 + 6_000);
    writeFileSync(go, "");
    await until(() => progress().length === 1, "the progress event");
    vi.setSystemTime(t0 + 7_000);
    writeFileSync(go2, "");
    const r = await tick;
    expect(r.message).toContain("1 dispatched, 0 failed");
    const events = (() => {
      const store = new TaskStore({ dbPath });
      try {
        return { done: store.get(taskId)!, list: store.listTaskEvents(taskId) };
      } finally {
        store.close();
      }
    })();
    // "done" came 1 s after the first event, inside its 15 s gap: no second event.
    expect(events.list.filter((e) => e.kind === "progress").map((e) => ({ actor: e.actor, details: e.details }))).toEqual([
      { actor: "tick", details: { line: "copying 1 of 2 with [redacted]", seq: 1 } },
    ]);
    expect(events.done.status).toBe("completed");
    expect((events.done.result as { text: string }).text).toBe("copying 1 of 2 with [redacted]\ndone");
    expect(events.list.find((e) => e.kind === "completed")!.details).toMatchObject({ steps: ["command"] });
    expect(events.list.map((e) => e.kind).filter((k) => k !== "progress")).toEqual(["created", "expedited", "dispatched", "completed"]);
  });
});
