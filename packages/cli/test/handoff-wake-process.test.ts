/**
 * The wake waiter with real processes and real signals: a fake `claude` (a
 * link to the Node binary named `claude`, running
 * `fixtures/fake-claude-session.mjs`) starts the plugin's
 * `hooks/session-wake.sh`, whose `tidegap` is the built CLI. Everything runs
 * in a temp HOME. Signals go only to processes this file started, and each
 * test kills what is left of them. The waiter polls every 5 s (no test
 * knob), so a "gone" bound is 12 s.
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SESSION_NOTICES_SINCE_META_KEY, TaskStore, writeWakeMarker } from "@tidegap/core";
import type { TaskRecord, TaskStatus } from "@tidegap/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "dist", "index.js");
const HOOK = join(here, "..", "..", "claude-code-plugin", "hooks", "session-wake.sh");
const FIXTURE = join(here, "fixtures", "fake-claude-session.mjs");
const S = "5e55a0b1-2222-4333-8444-955566667777";
/** Above the 5 s poll plus a slow `ps` and a slow start of the CLI. */
const GONE_MS = 12_000;

let root: string;
let home: string;
let out: string;
let claudeBin: string;
let started: ChildProcess[] = [];
/**
 * Every pid this test started or read from its own fixtures, with what `ps`
 * showed for it then: killed after the test only while `ps` still shows the
 * same process, so a pid reused by another program is never signalled.
 */
let pids: { pid: number; seen: string }[] = [];
const open: TaskStore[] = [];

beforeEach(() => {
  if (!existsSync(CLI)) throw new Error(`build the CLI first: ${CLI} is missing`);
  // Under the run's temp root, so a crashed worker's folder goes at teardown.
  root = realpathSync(mkdtempSync(join(process.env.TIDEGAP_TEST_TMP_ROOT || tmpdir(), "tidegap-wake-proc-")));
  home = join(root, "home");
  out = join(root, "out");
  const bin = join(root, "bin");
  for (const d of [home, out, bin, join(root, "claude-bin")]) mkdirSync(d, { recursive: true });
  // The hook's `tidegap` is the built CLI, as installed.
  writeFileSync(join(bin, "tidegap"), `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`);
  chmodSync(join(bin, "tidegap"), 0o755);
  claudeBin = join(root, "claude-bin", "claude");
  symlinkSync(process.execPath, claudeBin);
});

afterEach(async () => {
  for (const s of open.splice(0)) s.close();
  for (const { pid, seen } of pids) {
    if (isAlive(pid) && psLook(pid) === seen) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // gone already
      }
    }
  }
  for (const { pid, seen } of pids) if (psLook(pid) === seen) await goneWithin(pid, 5_000);
  for (const c of started) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
  started = [];
  pids = [];
  rmSync(root, { recursive: true, force: true });
}, 30_000);

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** `ps -o lstart=,comm=` for one pid, "" when it does not run (or `ps` failed). */
function psLook(pid: number): string {
  try {
    return execFileSync("ps", ["-o", "lstart=,comm=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

/** Record a pid this test started, with its `ps` look, for `afterEach`. */
function track(pid: number | undefined): void {
  if (pid === undefined || pid <= 1) return;
  const seen = psLook(pid);
  if (seen) pids.push({ pid, seen });
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll every 50 ms, up to `ms`, until `pid` is gone; never one check alone. */
async function goneWithin(pid: number, ms = GONE_MS): Promise<boolean> {
  for (let i = 0; i < ms / 50; i++) {
    if (!isAlive(pid)) return true;
    await pause(50);
  }
  return !isAlive(pid);
}

/** Poll every 50 ms, up to `ms`, until `path` holds one complete pid line; 0 after the bound. */
async function pidWithin(path: string, ms = 10_000): Promise<number> {
  const complete = () => (existsSync(path) ? Number(/^(\d+)\n$/.exec(readFileSync(path, "utf8"))?.[1] ?? 0) : 0);
  for (let i = 0; i < ms / 50 && !complete(); i++) await pause(50);
  return complete();
}

/** Poll every 50 ms, up to `ms`, for the fake session's record of the hook's exit. */
async function hookExitWithin(ms = GONE_MS): Promise<{ code: number | null; signal: string | null; stderr: string } | undefined> {
  const path = join(out, "hook.exit");
  for (let i = 0; i < ms / 50 && !existsSync(path); i++) await pause(50);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
}

const tidegapDir = () => join(home, ".tidegap");
const dbPath = () => join(tidegapDir(), "queue.db");
const marker = () => join(tidegapDir(), "sessions", "wake", S);
const waiterPidFile = () => join(tidegapDir(), "sessions", "waiters", `${S}.pid`);

function store(): TaskStore {
  const s = new TaskStore({ dbPath: dbPath() });
  open.push(s);
  return s;
}

function task(taskId: string, status: TaskStatus): TaskRecord<unknown> {
  const done = status === "completed";
  return {
    taskId,
    status,
    enqueuedAt: new Date(Date.now() - 600_000).toISOString(),
    region: "FR",
    title: `title ${taskId}`,
    originSessionId: S,
    bodyJson: JSON.stringify({
      type: "provider_call",
      provider: "command",
      model: "none",
      prompt: "",
      command: { run: "sleep 30", cwd: "/tmp", secrets: [], origin: "cli" },
      origin: { agent: "claude-code", via: "hook" },
      handoff: { wake: true },
    }),
    ...(done ? { completedAt: new Date().toISOString(), result: { text: "secret output" } } : {}),
  } as TaskRecord<unknown>;
}

/** The default ledger of the temp HOME with one pending wake task, and the session's wake marker. */
function seedWake(taskId = "t-wake"): TaskStore {
  mkdirSync(tidegapDir(), { recursive: true });
  const s = store();
  s.setMeta(SESSION_NOTICES_SINCE_META_KEY, "2026-01-01T00:00:00.000Z");
  s.upsert(task(taskId, "scheduled"), { kind: "created", actor: "cli" });
  writeWakeMarker(S, join(tidegapDir(), "sessions", "wake"));
  return s;
}

/** Start the fake `claude` with the Stop hook; resolves once the hook shell and the waiter run. */
async function startSession(opts: { wrap?: boolean } = {}): Promise<{ claude: ChildProcess; hook: number; waiter: number }> {
  const claude = spawn(claudeBin, [FIXTURE, out, HOOK, ...(opts.wrap ? ["--wrap"] : [])], {
    stdio: ["pipe", "ignore", "ignore"],
    env: { HOME: home, PATH: `${join(root, "bin")}:/usr/bin:/bin`, LC_ALL: "C" },
  });
  started.push(claude);
  claude.stdin!.end(JSON.stringify({ session_id: S, hook_event_name: "Stop", stop_hook_active: false }));
  track(claude.pid);
  const hook = await pidWithin(join(out, "hook.pid"));
  track(hook);
  const waiter = await pidWithin(waiterPidFile());
  track(waiter);
  expect(claude.pid).toBeGreaterThan(1);
  expect(hook).toBeGreaterThan(1);
  // When the waiter never started, say what `ps` saw as its ancestor and how the hook ended.
  const why = () => `claude ${JSON.stringify(psLook(claude.pid ?? 0))}, hook exit ${existsSync(join(out, "hook.exit")) ? readFileSync(join(out, "hook.exit"), "utf8") : "none"}`;
  expect(waiter, waiter > 1 ? "" : why()).toBeGreaterThan(1);
  return { claude, hook, waiter };
}

const notified = (s: TaskStore, taskId: string) => s.listTaskEvents(taskId).filter((e) => e.kind === "notified");

describe("the wake waiter with real processes and real signals", () => {
  it("SIGKILL to the hook shell: the waiter is gone within 12 s, claims nothing and leaves the wake marker", async () => {
    const s = seedWake();
    const { hook, waiter } = await startSession();
    process.kill(hook, "SIGKILL");
    expect(await goneWithin(waiter)).toBe(true);
    expect(notified(s, "t-wake")).toEqual([]);
    expect(existsSync(marker())).toBe(true);
  }, 40_000);

  it("SIGTERM to the claude process: the waiter is gone within 12 s, the ledger is unchanged and the marker remains", async () => {
    const s = seedWake();
    const before = s.listTaskEvents("t-wake").length;
    const { claude, waiter } = await startSession();
    process.kill(claude.pid!, "SIGTERM");
    expect(await goneWithin(waiter)).toBe(true);
    expect(s.listTaskEvents("t-wake")).toHaveLength(before);
    expect(s.get("t-wake")).toMatchObject({ status: "scheduled" });
    expect(existsSync(marker())).toBe(true);
  }, 40_000);

  it("a hook started under a wrapper shell that stays alive keeps its waiter: still alive after 12 s", async () => {
    seedWake();
    const { hook, waiter } = await startSession({ wrap: true });
    // Every 50 ms for 12 s: the wrapper and the waiter both still run.
    for (let i = 0; i < GONE_MS / 50; i++) {
      expect(isAlive(hook)).toBe(true);
      expect(isAlive(waiter)).toBe(true);
      await pause(50);
    }
    expect(readFileSync(waiterPidFile(), "utf8")).toBe(`${waiter}\n`);
  }, 40_000);

  it("SIGTERM to the waiter: it exits within 2 s and the hook shell exits 0 with nothing on stderr", async () => {
    const s = seedWake();
    const { waiter } = await startSession();
    process.kill(waiter, "SIGTERM");
    expect(await goneWithin(waiter, 2_000)).toBe(true);
    expect(await hookExitWithin()).toEqual({ code: 0, signal: null, stderr: "" });
    expect(notified(s, "t-wake")).toEqual([]);
    expect(existsSync(waiterPidFile())).toBe(false);
  }, 40_000);

  it("a wake task completed by another connection: the hook shell exits 2 with the notice on stderr, claimed via rewake", async () => {
    const s = seedWake();
    const { waiter } = await startSession();
    const other = new TaskStore({ dbPath: dbPath() });
    try {
      other.upsert(task("t-wake", "completed"), { kind: "completed", actor: "tick" });
    } finally {
      other.close();
    }
    const exit = await hookExitWithin();
    expect(exit).toMatchObject({ code: 2, signal: null });
    expect(exit!.stderr.startsWith("Tidegap: ")).toBe(true);
    expect(exit!.stderr).toContain("t-wake");
    expect(exit!.stderr).not.toContain("secret output");
    expect(await goneWithin(waiter)).toBe(true);
    expect(notified(s, "t-wake").map((e) => e.details)).toEqual([expect.objectContaining({ via: "rewake" })]);
  }, 60_000);
});
