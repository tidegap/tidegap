/**
 * Result files: the tick's sweep writes a completed task's result text to
 * its new file once, never replaces or follows anything at the path,
 * records one `result_file` event, and covers rows another core finished.
 * `queue wait` waits for that event, and the notice keeps a long path whole.
 */

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LAST_TICK_META_KEY, mockGridFeed, TaskStore } from "@tidegap/core";
import type { SessionNotice, TaskRecord, TaskStatus } from "@tidegap/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runQueueAdd } from "../src/commands/queue-add.js";
import { runQueueRunNow } from "../src/commands/queue.js";
import { runQueueNotices, runQueueWait, WAIT_EXIT } from "../src/commands/queue-watch.js";
import { runTickOnce } from "../src/commands/tick.js";
import type { SessionSources } from "../src/handoff/session.js";
import { NOTICE_LINE_MAX_CHARS, renderNoticeBlock, renderNotices } from "../src/handoff/notices.js";
import { resultFileSweep } from "../src/handoff/results.js";

const SESSION = "sess-results1";
/** The fake clock's start in the wait tests. */
const T0 = Date.parse("2026-10-31T10:00:00.000Z");

let dir: string;
let db: string;
let work: string;
const open: TaskStore[] = [];

function store(): TaskStore {
  const s = new TaskStore({ dbPath: db });
  open.push(s);
  return s;
}

/** A task as the tick (or the Python core) leaves it, asking for `resultPath`. */
function task(taskId: string, status: TaskStatus, resultPath: string | undefined, result = "the answer\n"): TaskRecord<unknown> {
  return {
    taskId,
    status,
    enqueuedAt: new Date(Date.now() - 60_000).toISOString(),
    region: "DE",
    title: `title ${taskId}`,
    originSessionId: SESSION,
    originCwd: work,
    bodyJson: JSON.stringify({
      type: "provider_call",
      provider: "anthropic",
      model: "claude-sonnet-5",
      prompt: "p",
      origin: { agent: "claude-code", via: "hook" },
      ...(resultPath ? { handoff: { resultPath } } : {}),
    }),
    ...(status === "completed" ? { result: { text: result }, completedAt: new Date().toISOString() } : {}),
    ...(status === "failed" ? { error: "boom", completedAt: new Date().toISOString() } : {}),
  } as TaskRecord<unknown>;
}

const fileEvents = (s: TaskStore, taskId: string) => s.listTaskEvents(taskId).filter((e) => e.kind === "result_file");

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "tidegap-results-")));
  db = join(dir, "queue.db");
  work = join(dir, "work");
  mkdirSync(work);
});
afterEach(() => {
  while (open.length > 0) open.pop()!.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the result-file sweep", () => {
  it("a completed task's result text lands at result_path with mode 0600 and a result_file event", () => {
    const s = store();
    const out = join(work, "answer.md");
    s.upsert(task("t-1", "completed", out));
    const done = resultFileSweep(s);
    expect(done).toEqual([{ taskId: "t-1", path: out, written: true, bytes: 11 }]);
    expect(readFileSync(out, "utf8")).toBe("the answer\n");
    expect(statSync(out).mode & 0o777).toBe(0o600);
    const [event] = fileEvents(s, "t-1");
    expect(event).toMatchObject({ actor: "tick", details: { path: out, written: true, bytes: 11 } });
    // No temporary file is left in the folder.
    expect(readdirSync(work)).toEqual(["answer.md"]);
  });

  it("a second sweep writes nothing", () => {
    const s = store();
    const out = join(work, "answer.md");
    s.upsert(task("t-1", "completed", out));
    resultFileSweep(s);
    writeFileSync(out, "changed by the user");
    expect(resultFileSweep(s)).toEqual([]);
    expect(readFileSync(out, "utf8")).toBe("changed by the user");
    expect(fileEvents(s, "t-1")).toHaveLength(1);
  });

  it("a target created by someone else after enqueue is left untouched and recorded with written false", () => {
    const s = store();
    const out = join(work, "answer.md");
    s.upsert(task("t-1", "completed", out));
    writeFileSync(out, "someone else's file");
    const [done] = resultFileSweep(s);
    expect(done).toMatchObject({ taskId: "t-1", written: false });
    expect(done!.error).toMatch(/already exists; a result file is never replaced/);
    expect(readFileSync(out, "utf8")).toBe("someone else's file");
    expect(fileEvents(s, "t-1")[0]!.details).toMatchObject({ path: out, written: false });
  });

  it("a target replaced by a symlink after enqueue is refused and recorded with written false; the link target is untouched", () => {
    const s = store();
    const out = join(work, "answer.md");
    const victim = join(dir, "victim.txt");
    writeFileSync(victim, "keep me");
    s.upsert(task("t-1", "completed", out));
    symlinkSync(victim, out);
    const [done] = resultFileSweep(s);
    expect(done).toMatchObject({ written: false });
    expect(readFileSync(victim, "utf8")).toBe("keep me");
    expect(lstatSync(out).isSymbolicLink()).toBe(true);
  });

  it("a folder swapped for a link into a protected folder after enqueue is refused", () => {
    const s = store();
    const out = join(work, "sub", "answer.md");
    s.upsert(task("t-1", "completed", out));
    mkdirSync(join(process.env.HOME!, ".ssh"), { recursive: true });
    symlinkSync(join(process.env.HOME!, ".ssh"), join(work, "sub"));
    const [done] = resultFileSweep(s);
    expect(done).toMatchObject({ written: false });
    expect(done!.error).toMatch(/\.ssh, a protected folder/);
    expect(existsSync(join(process.env.HOME!, ".ssh", "answer.md"))).toBe(false);
  });

  it("a ledger too busy to record the event leaves no file, so the next sweep writes it and records it written", () => {
    const s = store();
    const out = join(work, "busy.md");
    s.upsert(task("t-busy", "completed", out));
    const record = s.recordResultFile.bind(s);
    s.recordResultFile = () => {
      throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    };
    expect(resultFileSweep(s)).toEqual([]);
    expect(existsSync(out)).toBe(false);
    expect(fileEvents(s, "t-busy")).toHaveLength(0);
    s.recordResultFile = record;
    expect(resultFileSweep(s)).toEqual([{ taskId: "t-busy", path: out, written: true, bytes: 11 }]);
    expect(readFileSync(out, "utf8")).toBe("the answer\n");
    expect(readdirSync(work)).toEqual(["busy.md"]);
  });

  it("a failed task gets no file and no event", () => {
    const s = store();
    const out = join(work, "answer.md");
    s.upsert(task("t-1", "failed", out));
    s.upsert(task("t-2", "cancelled", join(work, "other.md")));
    expect(resultFileSweep(s)).toEqual([]);
    expect(existsSync(out)).toBe(false);
    expect(fileEvents(s, "t-1")).toEqual([]);
  });

  it("covers a row another core finished: a completed row with no events at all", () => {
    const raw = store();
    const out = join(work, "py.md");
    // The Python core writes the row and its own events; nothing from Node.
    raw.upsert(task("t-py", "completed", out, "from python"));
    expect(resultFileSweep(raw)).toEqual([{ taskId: "t-py", path: out, written: true, bytes: 11 }]);
    expect(readFileSync(out, "utf8")).toBe("from python");
  });

  it("a completed task with a JSON result and no text gets the JSON", () => {
    const s = store();
    const out = join(work, "data.json");
    s.upsert({ ...task("t-1", "completed", out), result: { items: [1, 2] } });
    resultFileSweep(s);
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({ items: [1, 2] });
  });
});

describe("a one-off command through the tick", () => {
  const CC_SESSION = "5e55a0b1-2222-4333-8444-955566667777";
  const inside: SessionSources = {
    claudePid: () => 42,
    readCapture: (pid) => (pid === 42 ? { sessionId: CC_SESSION, pid, projectDir: work } : undefined),
    envSessionId: () => undefined,
  };

  it("runs it, writes its result file before the notice sweep, and the notice names the file", async () => {
    const keys = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "OLLAMA_HOST", "TIDEGAP_CLAUDE_BIN", "TIDEGAP_CLAUDE_CODE"];
    const saved = keys.map((k) => [k, process.env[k]] as const);
    for (const k of keys) delete process.env[k];
    try {
      // A fresh ledger: no notice query ran before this task finished.
      const out = join(work, "hello.txt");
      const added = await runQueueAdd("echo hello", {
        db,
        runner: "command",
        by: "1h",
        resultPath: out,
        title: "say hello",
        feed: mockGridFeed(),
        region: "DE",
        workDir: work,
        sessionSources: inside,
      });
      const id = added.record.taskId;
      await runQueueRunNow(id, { db, feed: mockGridFeed(), region: "DE" });
      const r = await runTickOnce({
        db,
        region: "DE",
        envFile: join(dir, "no-env"),
        notify: false,
        claudeLookup: { path: "", home: dir, platform: "linux", isExecutable: () => false, loginShell: async () => undefined },
      });
      expect(r.message).toMatch(/^tick: 1 inspected, 1 dispatched, 0 failed/);
      expect(readFileSync(out, "utf8")).toBe("hello");
      const kinds = store().listTaskEvents(id).map((e) => e.kind);
      expect(kinds).toEqual(["created", "expedited", "dispatched", "completed", "result_file"]);
      const printed: string[] = [];
      const notice = await runQueueNotices({ db, peek: true, session: CC_SESSION, sessionSources: inside, print: (t) => printed.push(t) });
      expect(notice.rendered).toContain(`- ${id} completed "say hello" result_path: ${out}`);
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe("queue wait and the result file", () => {
  function fakeTime(onSleep: (n: number) => void = () => {}) {
    let t = T0;
    let n = 0;
    return {
      now: () => new Date(t),
      sleep: async (ms: number) => {
        t += ms;
        onSleep(++n);
      },
      print: async () => {},
    };
  }

  it("waits for the result file, then exits 0 with the result_path line", async () => {
    const s = store();
    s.setMeta(LAST_TICK_META_KEY, new Date().toISOString());
    const out = join(work, "answer.md");
    s.upsert(task("t-1", "completed", out));
    const time = fakeTime((n) => n === 2 && resultFileSweep(store()));
    const res = await runQueueWait("t-1", { db, timeout: "9m", ...time, stderr: () => {} });
    expect(res.exitCode).toBe(WAIT_EXIT.completed);
    expect(res.rendered).toBe(`the answer\n\nresult_path: ${out}`);
    const json = JSON.parse((await runQueueWait("t-1", { db, json: true, ...fakeTime(), stderr: () => {} })).rendered);
    expect(json).toMatchObject({ status: "completed", result_path: out, result_file: { written: true, bytes: 11 } });
    expect(Object.keys(json)).toEqual(["task_id", "status", "result", "error", "result_path", "result_file", "completed_at"]);
  });

  it("queue wait on a completed task whose file failed exits 1 and names the error", async () => {
    const s = store();
    s.setMeta(LAST_TICK_META_KEY, new Date().toISOString());
    const out = join(work, "answer.md");
    s.upsert(task("t-1", "completed", out));
    writeFileSync(out, "taken");
    resultFileSweep(s);
    const errs: string[] = [];
    const res = await runQueueWait("t-1", { db, ...fakeTime(), stderr: (l) => errs.push(l) });
    expect(res.exitCode).toBe(WAIT_EXIT.failed);
    expect(res.rendered).toMatch(new RegExp(`result_path: ${out} \\(not written: result path .* already exists`));
    expect(errs.join("\n")).toMatch(/queue wait: the result file was not written: not written: result path .* already exists/);
  });

  it("times out with exit 3 when the file is never recorded", async () => {
    const s = store();
    s.setMeta(LAST_TICK_META_KEY, new Date().toISOString());
    s.upsert(task("t-1", "completed", join(work, "answer.md")));
    const errs: string[] = [];
    const res = await runQueueWait("t-1", { db, timeout: "1m", ...fakeTime(), stderr: (l) => errs.push(l) });
    expect(res.exitCode).toBe(WAIT_EXIT.timeout);
    expect(errs).toContain("queue wait: timed out; t-1 is completed; its result file is not written yet");
  });

  it("a failed task that asked for a file does not wait for one", async () => {
    const s = store();
    s.setMeta(LAST_TICK_META_KEY, new Date().toISOString());
    s.upsert({ ...task("t-1", "failed", join(work, "answer.md")), completedAt: new Date(T0 - 600_000).toISOString() });
    const errs: string[] = [];
    const res = await runQueueWait("t-1", { db, timeout: "1m", daemon: "not_installed", ...fakeTime(), stderr: (l) => errs.push(l) });
    expect(res.exitCode).toBe(WAIT_EXIT.failed);
    expect(res.rendered).toBe(`error: boom\nresult_path: ${join(work, "answer.md")}`);
    expect(errs).toEqual([]);
  });
});

describe("queue wait on a result file that waits for a Node tick", () => {
  const NO_UNIT =
    "queue wait: t-1 is completed, but its result file waits for a Node tick. Run `tidegap tick --once`, or `tidegap install` to start the tick daemon.";
  const UNIT = "queue wait: t-1 is completed, but its result file waits for a Node tick. Run `tidegap tick --once` and check the error.";

  /** Fake time from T0; `at` logs each stderr line with the seconds since T0. */
  function clock(onSleep: (n: number) => void = () => {}) {
    let t = T0;
    let n = 0;
    const at: Array<[number, string]> = [];
    return {
      at,
      now: () => new Date(t),
      sleep: async (ms: number) => {
        t += ms;
        onSleep(++n);
      },
      stderr: (line: string) => at.push([(t - T0) / 1000, line]),
      print: async () => {},
    };
  }

  /** A completed row with a result path and no result_file event, as the Python core leaves it. */
  function completed(completedAt: number | undefined, taskId = "t-1") {
    const s = store();
    s.setMeta(LAST_TICK_META_KEY, new Date().toISOString());
    const row = { ...task(taskId, "completed", join(work, "answer.md")) } as TaskRecord<unknown>;
    if (completedAt === undefined) delete (row as { completedAt?: string }).completedAt;
    else row.completedAt = new Date(completedAt).toISOString();
    s.upsert(row);
    return s;
  }

  it("completed two intervals ago with no unit file: the first text once, and the wait goes on to its timeout", async () => {
    completed(T0 - 120_000);
    const c = clock();
    const res = await runQueueWait("t-1", { db, timeout: "1m", daemon: "not_installed", ...c });
    expect(res.exitCode).toBe(WAIT_EXIT.timeout);
    expect(c.at.map(([, l]) => l)).toEqual([NO_UNIT, "queue wait: timed out; t-1 is completed; its result file is not written yet"]);
    expect(c.at[0]![0]).toBe(0);
  });

  it("the hint does not end the wait: exit 0 once the tick writes the file", async () => {
    completed(T0 - 120_000);
    const c = clock((n) => n === 3 && resultFileSweep(store()));
    const res = await runQueueWait("t-1", { db, timeout: "1m", daemon: "not_installed", ...c });
    expect(res.exitCode).toBe(WAIT_EXIT.completed);
    expect(c.at.map(([, l]) => l)).toEqual([NO_UNIT]);
  });

  it("with a unit file on disk: the second text, after 300 s and not before", async () => {
    completed(T0);
    const c = clock();
    const res = await runQueueWait("t-1", { db, timeout: "6m", daemon: "installed", ...c });
    expect(res.exitCode).toBe(WAIT_EXIT.timeout);
    const hints = c.at.filter(([, l]) => l === UNIT);
    expect(hints).toHaveLength(1);
    expect(hints[0]![0]).toBeGreaterThan(300);
    expect(hints[0]![0]).toBeLessThanOrEqual(302);
  });

  it("without completed_at the interval counts from the first poll that saw it completed", async () => {
    completed(undefined);
    const c = clock();
    await runQueueWait("t-1", { db, timeout: "2m", daemon: "not_installed", ...c });
    const hints = c.at.filter(([, l]) => l === NO_UNIT);
    expect(hints).toHaveLength(1);
    expect(hints[0]![0]).toBeGreaterThan(60);
    expect(hints[0]![0]).toBeLessThanOrEqual(62);
  });

  it("a file event within one interval: no hint", async () => {
    completed(T0);
    const c = clock((n) => n === 5 && resultFileSweep(store()));
    const res = await runQueueWait("t-1", { db, timeout: "1m", daemon: "not_installed", ...c });
    expect(res.exitCode).toBe(WAIT_EXIT.completed);
    expect(c.at).toEqual([]);
  });

  /** A Node tick's lock on the ledger, touched at `t` as a running tick touches it. */
  const holdTickLock = (t: number) => {
    const lock = `${db}.tick.lock`;
    writeFileSync(lock, "");
    utimesSync(lock, new Date(t), new Date(t));
  };

  it("a Node tick that runs past the interval holds the hint, and its file ends the wait", async () => {
    completed(T0 - 600_000);
    holdTickLock(T0);
    const c = clock((n) => {
      if (n < 4) return holdTickLock(c.now().getTime());
      if (n === 4) {
        resultFileSweep(store());
        rmSync(`${db}.tick.lock`);
      }
    });
    const res = await runQueueWait("t-1", { db, timeout: "1m", daemon: "installed", ...c });
    expect(res.exitCode).toBe(WAIT_EXIT.completed);
    expect(c.at).toEqual([]);
  });

  it("a Node tick that ends without the file: the hint at the next poll", async () => {
    completed(T0 - 600_000);
    holdTickLock(T0);
    const c = clock((n) => (n < 3 ? holdTickLock(c.now().getTime()) : n === 3 && rmSync(`${db}.tick.lock`)));
    const res = await runQueueWait("t-1", { db, timeout: "1m", daemon: "installed", ...c });
    expect(res.exitCode).toBe(WAIT_EXIT.timeout);
    const hints = c.at.filter(([, l]) => l === UNIT);
    expect(hints).toEqual([[6, UNIT]]);
  });

  it("a stale tick lock, left by a tick that died, does not hold the hint", async () => {
    completed(T0 - 600_000);
    holdTickLock(T0 - 120_000);
    const c = clock();
    await runQueueWait("t-1", { db, timeout: "1m", daemon: "installed", ...c });
    expect(c.at.filter(([, l]) => l === UNIT)).toEqual([[0, UNIT]]);
  });

  it("--json: the hint goes to stderr, and stdout is the same JSON", async () => {
    completed(T0 - 600_000);
    const c = clock();
    const res = await runQueueWait("t-1", { db, timeout: "1m", json: true, daemon: "not_installed", ...c });
    expect(res.exitCode).toBe(WAIT_EXIT.timeout);
    expect(c.at.filter(([, l]) => l === NO_UNIT)).toHaveLength(1);
    const json = JSON.parse(res.rendered) as Record<string, unknown>;
    expect(Object.keys(json)).toEqual(["task_id", "status", "result", "error", "result_path", "result_file", "completed_at"]);
    expect(json).toMatchObject({ status: "completed", result_file: null });
  });
});

describe("the notice line and a long result path", () => {
  const notice = (id: string, path: string, title = "A long title ".repeat(10)): SessionNotice => ({
    record: { ...task(id, "completed", path), title },
    resultPath: path,
    resultFile: { path, written: true },
  });

  it("keeps a long result path whole: the title is cut first, then dropped", () => {
    const path = `/tmp/${"deep/".repeat(90)}result.md`;
    expect(path.length).toBeGreaterThan(NOTICE_LINE_MAX_CHARS);
    const text = renderNotices([notice("t-long", path)]);
    const line = text.split("\n")[1]!;
    expect(line.endsWith(` result_path: ${path}`)).toBe(true);
    expect(line).toBe(`- t-long completed result_path: ${path}`);
    const mid = `/tmp/${"x".repeat(300)}.md`;
    const midLine = renderNotices([notice("t-mid", mid)]).split("\n")[1]!;
    expect(midLine.endsWith(` result_path: ${mid}`)).toBe(true);
    expect(midLine.length).toBeLessThanOrEqual(NOTICE_LINE_MAX_CHARS);
    expect(midLine).toMatch(/^- t-mid completed "A long title.*…" result_path: /);
  });

  it("keeps the whole notice under 9,000 characters and counts the tasks it could not list", () => {
    const path = (i: number) => `/tmp/${String(i).repeat(1000)}.md`.slice(0, 1024);
    const block = renderNoticeBlock(Array.from({ length: 10 }, (_, i) => notice(`t-${i}`, path(i))));
    expect(block.text.length).toBeLessThanOrEqual(9_000);
    expect(block.listed).toBeLessThan(10);
    expect(block.text).toContain(`- and ${10 - block.listed} more: run \`tidegap queue list --session current\`.`);
    for (const line of block.text.split("\n").slice(1, 1 + block.listed)) expect(line).toMatch(/ result_path: \/tmp\/\d+/);
  });
});
