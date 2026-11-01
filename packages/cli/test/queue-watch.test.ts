/**
 * The watch commands of a handed-off task: `queue list --session`,
 * `queue events` and `queue wait`, and the session resolver behind
 * `--session current`.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LAST_TICK_META_KEY, TaskStore } from "@tidegap/core";
import type { TaskRecord, TaskStatus, TaskStoreOptions } from "@tidegap/core";

type SqliteDatabase = NonNullable<TaskStoreOptions["db"]>;

import { runQueueEvents, runQueueWait, WAIT_EXIT } from "../src/commands/queue-watch.js";
import { runQueueList } from "../src/commands/queue.js";
import { currentSession, UsageError, type SessionSources } from "../src/handoff/session.js";
import type { CapturedSession } from "../src/session/capture.js";

const S1 = "sess-aaaa1111";
const S2 = "sess-bbbb2222";

function task(taskId: string, status: TaskStatus, opts: { session?: string; result?: string; error?: string } = {}): TaskRecord<unknown> {
  return {
    taskId,
    status,
    enqueuedAt: new Date(Date.now() - 60_000).toISOString(),
    scheduledFor: "2026-11-01T03:00:00.000Z",
    deadline: "2026-11-01T06:00:00.000Z",
    region: "FR",
    title: `title ${taskId}`,
    bodyJson: JSON.stringify({ type: "provider_call", provider: "anthropic", model: "m", prompt: "p", origin: { agent: "claude-code", via: "hook" } }),
    originSessionId: opts.session ?? S1,
    ...(opts.result !== undefined ? { result: { text: opts.result } } : {}),
    ...(opts.error !== undefined ? { error: opts.error } : {}),
    ...(status === "completed" || status === "failed" || status === "cancelled" ? { completedAt: new Date().toISOString() } : {}),
  } as TaskRecord<unknown>;
}

/** Session sources with no `ps` walk: an optional capture for pid 42 and an optional env id. */
function sources(opts: { capture?: string; env?: string } = {}): SessionSources {
  return {
    claudePid: () => (opts.capture ? 42 : undefined),
    readCapture: (pid): CapturedSession | undefined => (pid === 42 && opts.capture ? { sessionId: opts.capture, pid } : undefined),
    envSessionId: () => opts.env,
  };
}

/** A read-only handle on the ledger, with TaskStore's backend order. */
function openReadOnly(path: string): SqliteDatabase {
  const req = createRequire(import.meta.url);
  try {
    const { DatabaseSync } = req("node:sqlite") as { DatabaseSync: new (p: string, o: object) => SqliteDatabase };
    return new DatabaseSync(path, { readOnly: true });
  } catch {
    const Database = req("better-sqlite3") as new (p: string, o: object) => SqliteDatabase;
    return new Database(path, { readonly: true });
  }
}

let dir: string;
let db: string;
const open: TaskStore[] = [];

function store(): TaskStore {
  const s = new TaskStore({ dbPath: db });
  open.push(s);
  return s;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tidegap-queue-watch-"));
  db = join(dir, "queue.db");
});

afterEach(() => {
  for (const s of open.splice(0)) s.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("queue list --session", () => {
  it("queue list --json --session <id> lists only that session's tasks and names session_id", async () => {
    const s = store();
    s.upsert(task("t-a1", "scheduled"));
    s.upsert(task("t-b1", "scheduled", { session: S2 }));
    s.upsert(task("t-a2", "completed", { result: "ok" }));
    const res = await runQueueList({ db, json: true, session: S1, sessionSources: sources() });
    const json = JSON.parse(res.rendered) as { session_id: string; tasks: Array<{ task_id: string; status: string; scheduled_for: string }> };
    expect(json.session_id).toBe(S1);
    expect(json.tasks.map((t) => t.task_id)).toEqual(["t-a1", "t-a2"]);
    expect(json.tasks.map((t) => t.status)).toEqual(["scheduled", "completed"]);
    expect(json.tasks[0]!.scheduled_for).toBe("2026-11-01T03:00:00.000Z");
    // Without --session the envelope names no session.
    expect(JSON.parse((await runQueueList({ db, json: true })).rendered)).not.toHaveProperty("session_id");
  });

  it("--session current resolves through the ancestor capture file, then CLAUDE_CODE_SESSION_ID", async () => {
    expect(currentSession(sources({ capture: S1, env: S2 }))).toEqual({ sessionId: S1, origin: { agent: "claude-code", via: "hook" } });
    expect(currentSession(sources({ env: S2 }))).toEqual({ sessionId: S2, origin: { agent: "claude-code", via: "env" } });
    expect(currentSession(sources({ env: "bad id" }))).toBeUndefined();
    const s = store();
    s.upsert(task("t-a1", "scheduled"));
    s.upsert(task("t-b1", "scheduled", { session: S2 }));
    const viaHook = JSON.parse((await runQueueList({ db, json: true, session: "current", sessionSources: sources({ capture: S1, env: S2 }) })).rendered);
    expect(viaHook.session_id).toBe(S1);
    expect(viaHook.tasks.map((t: { task_id: string }) => t.task_id)).toEqual(["t-a1"]);
    const viaEnv = JSON.parse((await runQueueList({ db, json: true, session: "current", sessionSources: sources({ env: S2 }) })).rendered);
    expect(viaEnv.session_id).toBe(S2);
    expect(viaEnv.tasks.map((t: { task_id: string }) => t.task_id)).toEqual(["t-b1"]);
  });

  it("--session current outside a Claude Code session exits 2 and names --session <id>", async () => {
    const err = await runQueueList({ db, json: true, session: "current", sessionSources: sources() }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UsageError);
    expect((err as UsageError).exitCode).toBe(2);
    expect((err as Error).message).toMatch(/--session <id>/);
    const bad = await runQueueList({ db, session: "../x", sessionSources: sources() }).catch((e: unknown) => e);
    expect((bad as UsageError).exitCode).toBe(2);
  });

  it("queue list --session and queue events accept the id of another session", async () => {
    const s = store();
    s.upsert(task("t-b1", "scheduled", { session: S2 }), { kind: "created", actor: "cli" });
    const mine = sources({ capture: S1 });
    const json = JSON.parse((await runQueueList({ db, json: true, session: S2, sessionSources: mine })).rendered);
    expect(json.tasks.map((t: { task_id: string }) => t.task_id)).toEqual(["t-b1"]);
    expect(JSON.parse(await runQueueEvents("t-b1", { db, json: true })).events.map((e: { kind: string }) => e.kind)).toEqual(["created"]);
  });
});

describe("queue events", () => {
  it("queue events --json prints the envelope with scheduled_for and events oldest first", async () => {
    const s = store();
    s.upsert(task("t-ev", "scheduled"), { kind: "created", actor: "agent:claude-code" });
    s.recordEvent("t-ev", { kind: "postponed", actor: "page", details: { preset: "1h" } });
    s.recordEvent("t-ev", { kind: "expedited", actor: "cli" });
    const json = JSON.parse(await runQueueEvents("t-ev", { db, json: true }));
    expect(json).toMatchObject({
      task_id: "t-ev",
      status: "scheduled",
      scheduled_for: "2026-11-01T03:00:00.000Z",
      deadline: "2026-11-01T06:00:00.000Z",
      completed_at: null,
      result_path: null,
    });
    expect(json.events.map((e: { kind: string }) => e.kind)).toEqual(["created", "postponed", "expedited"]);
    expect(json.events[1]).toMatchObject({ actor: "page", details: { preset: "1h" } });
    const ids = json.events.map((e: { id: number }) => e.id);
    expect([...ids].sort((a: number, b: number) => a - b)).toEqual(ids);
    // The text form: one line per event, led by its id.
    const lines = (await runQueueEvents("t-ev", { db })).split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(new RegExp(`^${ids[0]} \\S+ created by agent:claude-code`));
  });

  it("queue events --after <id> prints only newer events", async () => {
    const s = store();
    s.upsert(task("t-ev", "scheduled"), { kind: "created", actor: "cli" });
    s.recordEvent("t-ev", { kind: "postponed", actor: "page" });
    s.recordEvent("t-ev", { kind: "expedited", actor: "cli" });
    const all = JSON.parse(await runQueueEvents("t-ev", { db, json: true })).events as Array<{ id: number; kind: string }>;
    const after = JSON.parse(await runQueueEvents("t-ev", { db, json: true, after: String(all[0]!.id) })).events;
    expect(after.map((e: { kind: string }) => e.kind)).toEqual(["postponed", "expedited"]);
    expect(await runQueueEvents("t-ev", { db, after: String(all[2]!.id) })).toBe("");
    const bad = await runQueueEvents("t-ev", { db, after: "x" }).catch((e: unknown) => e);
    expect((bad as UsageError).exitCode).toBe(2);
  });

  it("queue events on an unknown id exits 2", async () => {
    store().upsert(task("t-known", "scheduled"));
    const err = await runQueueEvents("t-missing", { db }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UsageError);
    expect((err as UsageError).exitCode).toBe(2);
  });

  it("queue events and queue wait on a missing ledger exit 2 and create no ledger", async () => {
    const absent = join(dir, "absent.db");
    const events = await runQueueEvents("t-any", { db: absent }).catch((e: unknown) => e);
    expect((events as UsageError).exitCode).toBe(2);
    const wait = await runQueueWait("t-any", { db: absent, stderr: () => {} }).catch((e: unknown) => e);
    expect((wait as UsageError).exitCode).toBe(2);
    expect(existsSync(absent)).toBe(false);
  });
});

describe("queue wait", () => {
  /** A fake clock whose sleep advances time and runs `onSleep(n)` after the n-th sleep. */
  function fakeTime(onSleep: (n: number) => void = () => {}) {
    let t = Date.parse("2026-10-31T10:00:00.000Z");
    let n = 0;
    return {
      now: () => new Date(t),
      sleep: async (ms: number) => {
        t += ms;
        onSleep(++n);
      },
      sleeps: () => n,
    };
  }

  function seeded(status: TaskStatus = "scheduled"): TaskStore {
    const s = store();
    s.setMeta(LAST_TICK_META_KEY, new Date().toISOString());
    s.upsert(task("t-wait", status), { kind: "created", actor: "cli" });
    return s;
  }

  /** Finish `t-wait` from another connection, as the tick does. */
  function finish(status: TaskStatus, extra: { result?: string; error?: string } = {}): void {
    const other = store();
    other.upsert(task("t-wait", status, extra), { kind: status === "cancelled" ? "cancelled" : status === "failed" ? "failed" : "completed", actor: "tick" });
  }

  it("queue wait returns 0 and prints the result once the task completes", async () => {
    seeded();
    const time = fakeTime((n) => n === 3 && finish("completed", { result: "hello\nworld\u001b[31m" }));
    const errs: string[] = [];
    const res = await runQueueWait("t-wait", { db, timeout: "9m", ...time, stderr: (l) => errs.push(l) });
    expect(res.exitCode).toBe(WAIT_EXIT.completed);
    expect(res.rendered).toBe("hello\nworld[31m");
    expect(time.sleeps()).toBe(3);
    expect(errs).toEqual([]);
    const json = await runQueueWait("t-wait", { db, json: true, ...fakeTime(), stderr: () => {} });
    expect(JSON.parse(json.rendered)).toMatchObject({ task_id: "t-wait", status: "completed", result: "hello\nworld\u001b[31m", error: null, result_path: null });
  });

  it("queue wait returns 1 for failed and for cancelled", async () => {
    seeded();
    finish("failed", { error: "boom\nstack" });
    const failed = await runQueueWait("t-wait", { db, ...fakeTime(), stderr: () => {} });
    expect(failed.exitCode).toBe(WAIT_EXIT.failed);
    expect(failed.rendered).toBe("error: boom\nstack");
    finish("cancelled");
    const cancelled = await runQueueWait("t-wait", { db, ...fakeTime(), stderr: () => {} });
    expect(cancelled.exitCode).toBe(WAIT_EXIT.failed);
    expect(cancelled.rendered).toBe("cancelled");
  });

  it("queue wait returns 3 at --timeout and leaves the task unchanged", async () => {
    const s = seeded();
    const before = s.get("t-wait");
    const errs: string[] = [];
    const time = fakeTime();
    const res = await runQueueWait("t-wait", { db, timeout: "1m", ...time, stderr: (l) => errs.push(l) });
    expect(res.exitCode).toBe(WAIT_EXIT.timeout);
    expect(res.rendered).toBe("");
    expect(errs).toEqual(["queue wait: timed out; t-wait is still scheduled"]);
    // 60 s at a 2 s poll.
    expect(time.sleeps()).toBe(30);
    expect(s.get("t-wait")).toEqual(before);
    expect(s.listTaskEvents("t-wait").map((e) => e.kind)).toEqual(["created"]);
    const bad = await runQueueWait("t-wait", { db, timeout: "soon", ...fakeTime() }).catch((e: unknown) => e);
    expect((bad as UsageError).exitCode).toBe(2);
    const missing = await runQueueWait("t-none", { db, ...fakeTime() }).catch((e: unknown) => e);
    expect((missing as UsageError).exitCode).toBe(2);
  });

  it("queue wait claims the notice via wait and marks the task read; --no-mark-read does neither", async () => {
    const s = seeded();
    finish("completed", { result: "ok" });
    const peek = await runQueueWait("t-wait", { db, markRead: false, ...fakeTime(), stderr: () => {} });
    expect(peek.exitCode).toBe(0);
    expect(s.get("t-wait")?.readAt).toBeUndefined();
    expect(s.listTaskEvents("t-wait").some((e) => e.kind === "notified")).toBe(false);
    await runQueueWait("t-wait", { db, ...fakeTime(), stderr: () => {} });
    expect(s.get("t-wait")?.readAt).toBeTruthy();
    const notified = s.listTaskEvents("t-wait").filter((e) => e.kind === "notified");
    expect(notified).toHaveLength(1);
    expect(notified[0]).toMatchObject({ actor: "cli", details: { via: "wait", session_id: S1 } });
    // A second wait prints again and claims nothing new.
    await runQueueWait("t-wait", { db, ...fakeTime(), stderr: () => {} });
    expect(s.listTaskEvents("t-wait").filter((e) => e.kind === "notified")).toHaveLength(1);
  });

  it("queue wait keeps its exit code when the claim fails", async () => {
    seeded();
    finish("completed", { result: "ok" });
    const errs: string[] = [];
    const res = await runQueueWait("t-wait", {
      db,
      ...fakeTime(),
      stderr: (l) => errs.push(l),
      openStore: (path) => new TaskStore({ dbPath: path, db: openReadOnly(path) }),
    });
    expect(res.exitCode).toBe(0);
    expect(res.rendered).toBe("ok");
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/^queue wait: could not record that the outcome was read: /);
    expect(store().listTaskEvents("t-wait").some((e) => e.kind === "notified")).toBe(false);
  });

  it("queue wait --events prints each new event to stderr once", async () => {
    const s = seeded();
    s.recordEvent("t-wait", { kind: "postponed", actor: "page" });
    const other = store();
    const time = fakeTime((n) => {
      if (n === 1) other.recordEvent("t-wait", { kind: "expedited", actor: "cli" });
      if (n === 2) other.upsert({ ...task("t-wait", "running") }, { kind: "dispatched", actor: "tick" });
      if (n === 4) finish("completed", { result: "done" });
    });
    const errs: string[] = [];
    const res = await runQueueWait("t-wait", { db, events: true, ...time, stderr: (l) => errs.push(l) });
    expect(res.exitCode).toBe(0);
    // Only events written after the wait started, each once.
    expect(errs.map((l) => l.split(" ")[2])).toEqual(["expedited", "dispatched", "completed"]);
    expect(errs.every((l) => /^\d+ \S+ \w+ by /.test(l))).toBe(true);
  });

  it("queue wait prints the readiness line when no tick was ever recorded", async () => {
    const s = store();
    s.upsert(task("t-wait", "completed", { result: "ok" }));
    const errs: string[] = [];
    await runQueueWait("t-wait", { db, ...fakeTime(), stderr: (l) => errs.push(l) });
    expect(errs).toEqual(["Tasks will not run: no tick daemon. Run `tidegap install`."]);
    s.setMeta(LAST_TICK_META_KEY, new Date().toISOString());
    const quiet: string[] = [];
    await runQueueWait("t-wait", { db, ...fakeTime(), stderr: (l) => quiet.push(l) });
    expect(quiet).toEqual([]);
  });

  it("queue wait reads no rows while data_version is unchanged", async () => {
    seeded();
    let gets = 0;
    const counting = (path: string): TaskStore => {
      const s = new TaskStore({ dbPath: path });
      const get = s.get.bind(s);
      s.get = (id: string) => {
        gets++;
        return get(id);
      };
      return s;
    };
    const time = fakeTime((n) => n === 10 && finish("completed", { result: "ok" }));
    const res = await runQueueWait("t-wait", { db, ...time, stderr: () => {}, openStore: counting });
    expect(res.exitCode).toBe(0);
    expect(time.sleeps()).toBe(10);
    // The first read, then one read after the other connection's commit.
    expect(gets).toBe(2);
  });
});

describe("queue wait through the built CLI", () => {
  const entry = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
  /** The built CLI with stdout and stderr on pipes, as a Bash tool runs it, in this test's HOME. */
  function cli(args: string[]) {
    if (!existsSync(entry)) throw new Error(`build the CLI first: ${entry} is missing`);
    return spawnSync(process.execPath, [entry, ...args], {
      encoding: "utf8",
      env: { ...process.env, HOME: dir },
      maxBuffer: 8 * 1024 * 1024,
    });
  }

  it("a result over 64 KiB reaches a pipe in full, with exit 0", () => {
    const big = `${"x".repeat(199_990)}END-MARKER`;
    const s = store();
    s.setMeta(LAST_TICK_META_KEY, new Date().toISOString());
    s.upsert(task("t-big", "completed", { result: big }));
    const r = cli(["queue", "wait", "t-big", "--db", db]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`${big}\n`);
    const json = cli(["queue", "wait", "t-big", "--db", db, "--json"]);
    expect(json.status).toBe(0);
    expect(JSON.parse(json.stdout).result).toBe(big);
  });

  it("a ledger that cannot be opened exits 2, not 1 (failed)", () => {
    const junk = join(dir, "junk.db");
    writeFileSync(junk, "not a sqlite file, long enough to have a header ".repeat(4));
    const r = cli(["queue", "wait", "t-any", "--db", junk, "--timeout", "1m"]);
    expect(r.status).toBe(2);
    expect(r.stderr).not.toBe("");
  });
});
