/**
 * The opt-in wake of an idle session: `queue add --wake` and its marker,
 * `queue show` naming the wake, the waiter behind `queue notices --wait
 * --rewake` (pid file, poll, `claude` ancestor, limit, the claim against the
 * prompt hook) and the tick sweep of old wake markers. Processes are fakes:
 * no test starts a real `claude`, and the clock is the test's.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { mockGridFeed, SESSION_NOTICES_SINCE_META_KEY, TaskStore, writeWakeMarker } from "@tidegap/core";
import type { TaskRecord, TaskStatus } from "@tidegap/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runQueueAdd } from "../src/commands/queue-add.js";
import { runQueueNotices } from "../src/commands/queue-watch.js";
import { runQueueShow } from "../src/commands/queue.js";
import { wakeSweep } from "../src/handoff/notices.js";
import { UsageError, type SessionSources } from "../src/handoff/session.js";
import { runWakeWaiter, WAITER_LIMIT_MS, WAITER_POLL_MS, type ProcIdentity, type WaiterProcess, type WakeWaiterOptions } from "../src/handoff/waiter.js";

const S = "5e55a0b1-2222-4333-8444-955566667777";
const CLAUDE = 4242;
/** The Stop hook's shell (`TIDEGAP_HOOK_PID`), a child of the `claude` process. */
const HOOK = 5151;
const T0 = Date.parse("2026-11-01T10:00:00.000Z");

let dir: string;
let db: string;
let sessions: string;
const open: TaskStore[] = [];

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "tidegap-wake-")));
  db = join(dir, "queue.db");
  sessions = join(dir, "sessions");
});

afterEach(() => {
  for (const s of open.splice(0)) s.close();
  rmSync(dir, { recursive: true, force: true });
});

function store(): TaskStore {
  const s = new TaskStore({ dbPath: db });
  open.push(s);
  return s;
}

/** A task of session S; `wake` puts `handoff.wake` in its body. */
function task(taskId: string, status: TaskStatus, opts: { wake?: boolean; title?: string } = {}): TaskRecord<unknown> {
  const done = status === "completed" || status === "failed" || status === "cancelled";
  return {
    taskId,
    status,
    enqueuedAt: new Date(T0 - 600_000).toISOString(),
    region: "FR",
    title: opts.title ?? `title ${taskId}`,
    originSessionId: S,
    bodyJson: JSON.stringify({
      type: "provider_call",
      provider: "command",
      model: "none",
      prompt: "",
      command: { run: "sleep 30", cwd: "/tmp", secrets: [], origin: "cli" },
      origin: { agent: "claude-code", via: "hook" },
      ...(opts.wake ? { handoff: { wake: true } } : {}),
    }),
    ...(done ? { completedAt: new Date().toISOString(), result: { text: "secret output" } } : {}),
  } as TaskRecord<unknown>;
}

/** A ledger whose notices cover everything finished this year, with `rows` in it. */
function seed(...rows: TaskRecord<unknown>[]): TaskStore {
  const s = store();
  s.setMeta(SESSION_NOTICES_SINCE_META_KEY, "2026-01-01T00:00:00.000Z");
  for (const r of rows) s.upsert(r, { kind: "created", actor: "cli" });
  return s;
}

/** Finish a task from another connection, as the tick does (so data_version changes). */
function finish(taskId: string, opts: { wake?: boolean; title?: string } = {}): void {
  const other = new TaskStore({ dbPath: db });
  try {
    other.upsert(task(taskId, "completed", opts), { kind: "completed", actor: "tick" });
  } finally {
    other.close();
  }
}

const wakeDir = () => join(sessions, "wake");
const marker = () => join(wakeDir(), S);
const pidFile = () => join(sessions, "waiters", `${S}.pid`);
const hookInput = JSON.stringify({ session_id: S });

/**
 * A process table with one `claude` (pid 4242) and its hook shell (pid
 * 5151), whose identities the test can change, as when a pid is reused.
 */
function procs(pid = 1001) {
  let claude: string | undefined = "501 Sun Nov 1 09:00:00 2026 /usr/local/bin/claude";
  let hook: ProcIdentity | undefined = { ppid: CLAUDE, id: "501 Sun Nov 1 09:59:00 2026 /bin/sh" };
  const look = (p: number): ProcIdentity | undefined => {
    if (p === CLAUDE) return claude === undefined ? undefined : { ppid: 1, id: claude };
    return p === HOOK ? hook : undefined;
  };
  const proc: WaiterProcess = {
    pid,
    claudePid: () => CLAUDE,
    identity: (pids) => pids.map(look),
  };
  return {
    proc,
    reuse: () => {
      claude = "501 Sun Nov 1 11:00:00 2026 /usr/bin/vim";
    },
    exit: () => {
      claude = undefined;
    },
    hookExit: () => {
      hook = undefined;
    },
    hookReuse: () => {
      hook = { ppid: CLAUDE, id: "501 Sun Nov 1 11:00:00 2026 /usr/bin/vim" };
    },
    /** The shell's parent ended, so it now hangs under launchd or init. */
    hookOrphan: () => {
      hook = { ppid: 1, id: hook!.id };
    },
  };
}

/** A clock that stands still until a sleep moves it; `onSleep(n)` runs after the n-th sleep. */
function clock(onSleep: (n: number) => void | Promise<void> = () => {}, start = T0) {
  let t = start;
  let n = 0;
  return {
    now: () => new Date(t),
    sleep: async (ms: number) => {
      t += ms;
      await onSleep(++n);
    },
    sleeps: () => n,
    at: () => t,
  };
}

async function waiter(opts: Partial<WakeWaiterOptions> & { proc?: WaiterProcess } = {}) {
  const errs: string[] = [];
  const stderr = (t: string) => {
    errs.push(t);
    return true;
  };
  const res = await runWakeWaiter({ db, dir: sessions, hookInput, stderr, proc: procs().proc, ...clock(), ...opts });
  return { ...res, errs };
}

describe("queue add --wake", () => {
  const inside: SessionSources = { claudePid: () => undefined, readCapture: () => undefined, envSessionId: () => S };
  const outside: SessionSources = { claudePid: () => undefined, readCapture: () => undefined, envSessionId: () => undefined };
  const add = (sources: SessionSources, extra: Record<string, unknown> = {}) =>
    runQueueAdd("echo hi", { db, feed: mockGridFeed(), region: "DE", workDir: dir, runner: "command", by: "10m", wake: true, sessionSources: sources, ...extra });

  it("queue add --wake outside a session exits 2 and queues nothing", async () => {
    const err = await add(outside).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UsageError);
    expect((err as UsageError).exitCode).toBe(2);
    expect((err as Error).message).toMatch(/--wake needs a Claude Code session/);
    expect(existsSync(db) ? store().list() : []).toEqual([]);
  });

  it("inside a session it stores the wake, writes the wake marker and says so; --json has wake true", async () => {
    const home = join(homedir(), ".tidegap", "sessions", "wake", S);
    const res = await add(inside);
    expect(res.rendered.split("\n")).toContain("wake: on (this session wakes when the task finishes, if it is idle, within 12 hours after its last turn)");
    expect(JSON.parse(store().get(res.record.taskId)!.bodyJson!).handoff).toEqual({ wake: true });
    expect(statSync(home).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(home)).mode & 0o777).toBe(0o700);
    const json = JSON.parse((await add(inside, { json: true })).rendered);
    expect(json).toMatchObject({ wake: true, wake_armed: true });
  });

  it("when the wake marker cannot be written, the text says not armed and --json has wake_armed false", async () => {
    const home = join(homedir(), ".tidegap", "sessions", "wake", S);
    rmSync(home, { recursive: true, force: true });
    mkdirSync(home, { recursive: true });
    try {
      const res = await add(inside);
      expect(res.rendered).toMatch(/^wake: not armed \(.*is not a regular file\); the notice comes with the next prompt$/m);
      const json = JSON.parse((await add(inside, { json: true })).rendered);
      expect(json).toMatchObject({ wake: true, wake_armed: false });
      const plain = JSON.parse((await add(inside, { json: true, wake: false })).rendered);
      expect(plain).toMatchObject({ wake: false, wake_armed: false });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("queue show names the wake setting of a wake task, in text and JSON", async () => {
    const res = await add(inside, { runner: "anthropic", model: "claude-sonnet-5" });
    const text = (await runQueueShow(res.record.taskId, { db, markRead: false, config: join(dir, "none") })).rendered;
    expect(text).toMatch(/^wake: on \(wakes its idle session when it finishes\)$/m);
    const json = JSON.parse((await runQueueShow(res.record.taskId, { db, json: true, markRead: false, config: join(dir, "none") })).rendered);
    expect(json.wake).toBe(true);
    const plain = await runQueueAdd("x", { db, feed: mockGridFeed(), region: "DE", workDir: dir, runner: "anthropic", by: "1h", sessionSources: inside });
    expect(JSON.parse((await runQueueShow(plain.record.taskId, { db, json: true, markRead: false, config: join(dir, "none") })).rendered).wake).toBe(false);
  });
});

describe("the wake waiter", () => {
  it("without a wake marker it exits 0 at once and writes no pid file", async () => {
    seed(task("t-w", "scheduled", { wake: true }));
    const r = await waiter();
    expect(r).toMatchObject({ exitCode: 0, outcome: "no-marker" });
    expect(existsSync(pidFile())).toBe(false);
  });

  it("the waiter exits 0 at once when the session has no pending wake task, and removes the wake marker", async () => {
    seed(task("t-plain", "scheduled"));
    writeWakeMarker(S, wakeDir());
    const time = clock();
    const r = await waiter(time);
    expect(r).toMatchObject({ exitCode: 0, outcome: "nothing-pending" });
    expect(time.sleeps()).toBe(0);
    expect(existsSync(marker())).toBe(false);
    expect(existsSync(pidFile())).toBe(false);
  });

  it("covers AE5: it prints the notice to stderr, claims via rewake and exits 2 when a wake task completes", async () => {
    const s = seed(task("t-w", "scheduled", { wake: true, title: "tg wake" }), task("t-other", "scheduled"));
    finish("t-other");
    writeWakeMarker(S, wakeDir());
    let pidDuringWait: string | undefined;
    const time = clock((n) => {
      if (n === 1) pidDuringWait = readFileSync(pidFile(), "utf8");
      if (n === 3) finish("t-w", { wake: true, title: "tg wake" });
    });
    const r = await waiter(time);
    expect(r.exitCode).toBe(2);
    expect(r.outcome).toBe("woke");
    expect(pidDuringWait).toBe("1001\n");
    expect(time.sleeps()).toBe(3);
    // The wake task first, then the other finished task of the session; never the result text.
    expect(r.errs).toEqual([
      [
        "Tidegap: 2 tasks queued from this session finished:",
        '- t-w completed "tg wake"',
        '- t-other completed "title t-other"',
        "Read one with: tidegap queue show <id> (or check_queue_status task_id=<id>).",
      ].join("\n"),
    ]);
    expect(r.claimed).toEqual(["t-w", "t-other"]);
    const notified = s.listTaskEvents("t-w").filter((e) => e.kind === "notified");
    expect(notified).toHaveLength(1);
    expect(notified[0]).toMatchObject({ actor: "agent:claude-code", details: { via: "rewake", session_id: S } });
    expect(s.get("t-w")!.readAt).toBeTruthy();
    // Nothing left to wait for: the markers and the pid file are gone, and the prompt hook has nothing to say.
    expect(existsSync(marker())).toBe(false);
    expect(existsSync(pidFile())).toBe(false);
    const printed: string[] = [];
    await runQueueNotices({ db, hook: true, hookInput, dir: join(sessions, "notices"), print: (t) => printed.push(t) });
    expect(printed).toEqual([]);
  });

  it("a wake task that finished before the turn ended wakes at the first look; another pending wake task keeps the marker", async () => {
    seed(task("t-w1", "completed", { wake: true }), task("t-w2", "scheduled", { wake: true }));
    writeWakeMarker(S, wakeDir());
    const time = clock();
    const r = await waiter(time);
    expect(r).toMatchObject({ exitCode: 2, claimed: ["t-w1"] });
    expect(time.sleeps()).toBe(0);
    expect(existsSync(marker())).toBe(true);
  });

  it("a wake task with a result file wakes once the file is recorded, not when it only completed", async () => {
    const s = seed(task("t-w", "scheduled", { wake: true }));
    writeWakeMarker(S, wakeDir());
    const withFile = (status: TaskStatus): TaskRecord<unknown> => {
      const r = task("t-w", status, { wake: true });
      const body = JSON.parse(r.bodyJson!);
      return { ...r, bodyJson: JSON.stringify({ ...body, handoff: { wake: true, resultPath: "/tmp/qa-wake.md" } }) };
    };
    s.upsert(withFile("scheduled"));
    const time = clock((n) => {
      const other = new TaskStore({ dbPath: db });
      try {
        if (n === 1) other.upsert(withFile("completed"), { kind: "completed", actor: "tick" });
        if (n === 4) other.recordResultFile("t-w", { path: "/tmp/qa-wake.md", written: true, bytes: 2 });
      } finally {
        other.close();
      }
    });
    const r = await waiter(time);
    expect(r).toMatchObject({ exitCode: 2, outcome: "woke", claimed: ["t-w"] });
    expect(time.sleeps()).toBe(4);
    expect(r.errs[0]).toContain("- t-w completed \"title t-w\" result_path: /tmp/qa-wake.md");
  });

  it("a waiter from a later Stop replaces the earlier one, which exits 0 at its next poll; the new one gets a fresh limit", async () => {
    seed(task("t-w", "scheduled", { wake: true }));
    writeWakeMarker(S, wakeDir());
    const second = clock((n) => {
      if (n === 30) finish("t-w", { wake: true });
    }, T0 + WAITER_LIMIT_MS - WAITER_POLL_MS);
    let later: Promise<Awaited<ReturnType<typeof waiter>>> | undefined;
    const first = clock((n) => {
      // The next Stop, near the first waiter's limit: its waiter starts and writes its pid.
      if (n === 1) later = waiter({ ...second, proc: procs(1002).proc });
    }, T0 + WAITER_LIMIT_MS - 2 * WAITER_POLL_MS);
    const a = await waiter({ ...first, proc: procs(1001).proc });
    expect(a).toMatchObject({ exitCode: 0, outcome: "replaced" });
    expect(first.sleeps()).toBe(1);
    // The older waiter left the newer one's pid file alone.
    expect(readFileSync(pidFile(), "utf8")).toBe("1002\n");
    const b = await later!;
    // 30 polls of 5 s: past the first waiter's limit, inside its own.
    expect(b).toMatchObject({ exitCode: 2, outcome: "woke", claimed: ["t-w"] });
    expect(existsSync(pidFile())).toBe(false);
  });

  it("the waiter exits 0 when its claude ancestor is gone, also when its pid now runs another program", async () => {
    for (const end of ["exit", "reuse"] as const) {
      seed(task(`t-${end}`, "scheduled", { wake: true }));
      writeWakeMarker(S, wakeDir());
      const p = procs();
      const r = await waiter({
        proc: p.proc,
        ...clock((n) => {
          if (n === 2) p[end]();
        }),
      });
      expect(r, end).toMatchObject({ exitCode: 0, outcome: "claude-gone" });
      expect(existsSync(pidFile()), end).toBe(false);
    }
  });

  it("outside a Claude Code process it exits 0 without waiting", async () => {
    seed(task("t-w", "scheduled", { wake: true }));
    writeWakeMarker(S, wakeDir());
    const r = await waiter({ proc: { pid: 1001, claudePid: () => undefined, identity: (pids) => pids.map(() => undefined) } });
    expect(r).toMatchObject({ exitCode: 0, outcome: "no-claude" });
    expect(existsSync(pidFile())).toBe(false);
  });

  it("the waiter exits 0 at its limit and leaves the notice unclaimed for the prompt hook", async () => {
    const s = seed(task("t-w", "scheduled", { wake: true }));
    writeWakeMarker(S, wakeDir());
    const time = clock();
    const r = await waiter(time);
    expect(r).toMatchObject({ exitCode: 0, outcome: "limit", claimed: [] });
    expect(time.at() - T0).toBe(WAITER_LIMIT_MS);
    expect(time.sleeps()).toBe(Math.ceil(WAITER_LIMIT_MS / WAITER_POLL_MS));
    expect(existsSync(pidFile())).toBe(false);
    // The task finishes later: its notice goes to the next prompt.
    finish("t-w", { wake: true });
    const printed: string[] = [];
    await runQueueNotices({ db, hook: true, hookInput, dir: join(sessions, "notices"), print: (t) => printed.push(t) });
    expect(printed.join("\n")).toContain("- t-w completed");
    expect(s.listTaskEvents("t-w").find((e) => e.kind === "notified")?.details).toMatchObject({ via: "prompt" });
  });

  it("a notice claimed by the prompt hook first makes the waiter exit 0", async () => {
    const s = seed(task("t-w", "scheduled", { wake: true }));
    writeWakeMarker(S, wakeDir());
    const time = clock(async (n) => {
      if (n !== 2) return;
      finish("t-w", { wake: true });
      // The user typed a prompt first: the hook prints and claims the notice.
      await runQueueNotices({ db, hook: true, hookInput, dir: join(sessions, "notices"), print: () => {} });
    });
    const r = await waiter(time);
    expect(r).toMatchObject({ exitCode: 0, outcome: "nothing-pending", claimed: [] });
    expect(s.listTaskEvents("t-w").filter((e) => e.kind === "notified").map((e) => e.details.via)).toEqual(["prompt"]);
  });

  it("when the prompt hook claims between the waiter's read and its claim, the waiter exits 0", async () => {
    const s = seed(task("t-w", "completed", { wake: true }));
    writeWakeMarker(S, wakeDir());
    const racing = (path: string): TaskStore => {
      const st = new TaskStore({ dbPath: path });
      const claim = st.claimNotice.bind(st);
      st.claimNotice = (id, details, actor) => {
        s.claimNotice(id, { via: "prompt", session_id: S }, "agent:claude-code");
        return claim(id, details, actor);
      };
      return st;
    };
    const r = await waiter({ openStore: racing });
    expect(r).toMatchObject({ exitCode: 0, outcome: "claimed-elsewhere", claimed: [] });
    expect(s.listTaskEvents("t-w").filter((e) => e.kind === "notified").map((e) => e.details.via)).toEqual(["prompt"]);
  });

  it("reads rows only when data_version changed", async () => {
    seed(task("t-w", "scheduled", { wake: true }));
    writeWakeMarker(S, wakeDir());
    let reads = 0;
    const counting = (path: string): TaskStore => {
      const st = new TaskStore({ dbPath: path });
      const list = st.listSessionNotices.bind(st);
      st.listSessionNotices = (o) => {
        reads++;
        return list(o);
      };
      return st;
    };
    const r = await waiter({
      openStore: counting,
      ...clock((n) => {
        if (n === 10) finish("t-w", { wake: true });
      }),
    });
    expect(r.exitCode).toBe(2);
    // The first look, then one after the other connection's commit, then the check of what is left.
    expect(reads).toBe(3);
  });

  it("a read that fails after a data_version change reads again at the next poll", async () => {
    seed(task("t-w", "scheduled", { wake: true }));
    writeWakeMarker(S, wakeDir());
    let busy = false;
    const flaky = (path: string): TaskStore => {
      const st = new TaskStore({ dbPath: path });
      const list = st.listSessionNotices.bind(st);
      st.listSessionNotices = (o) => {
        if (busy) {
          busy = false;
          throw new Error("database is locked");
        }
        return list(o);
      };
      return st;
    };
    const time = clock((n) => {
      if (n === 2) {
        finish("t-w", { wake: true });
        busy = true;
      }
    });
    const r = await waiter({ openStore: flaky, ...time });
    // No other commit comes: the poll after the failed read still looks.
    expect(r).toMatchObject({ exitCode: 2, outcome: "woke", claimed: ["t-w"] });
    expect(time.sleeps()).toBe(3);
  });

  it("a won claim stands when marking the task read fails: it still wakes", async () => {
    const s = seed(task("t-w", "completed", { wake: true }));
    writeWakeMarker(S, wakeDir());
    const noRead = (path: string): TaskStore => {
      const st = new TaskStore({ dbPath: path });
      st.markRead = () => {
        throw new Error("database is locked");
      };
      return st;
    };
    const r = await waiter({ openStore: noRead });
    expect(r).toMatchObject({ exitCode: 2, outcome: "woke", claimed: ["t-w"] });
    expect(s.listTaskEvents("t-w").filter((e) => e.kind === "notified").map((e) => e.details.via)).toEqual(["rewake"]);
  });

  it("a claim that fails exits 0 and leaves the notice unclaimed for the prompt hook", async () => {
    const s = seed(task("t-w", "completed", { wake: true }));
    writeWakeMarker(S, wakeDir());
    const noClaim = (path: string): TaskStore => {
      const st = new TaskStore({ dbPath: path });
      st.claimNotice = () => {
        throw new Error("database is locked");
      };
      return st;
    };
    const r = await waiter({ openStore: noClaim });
    expect(r).toMatchObject({ exitCode: 0, outcome: "error", claimed: [] });
    expect(s.listTaskEvents("t-w").filter((e) => e.kind === "notified")).toEqual([]);
    expect(s.listSessionNotices({ sessionId: S }).map((n) => n.record.taskId)).toEqual(["t-w"]);
  });

  it("a notice that cannot reach the hook (its shell is gone) is never claimed", async () => {
    const s = seed(task("t-w", "completed", { wake: true }));
    writeWakeMarker(S, wakeDir());
    const r = await waiter({ stderr: async () => false });
    expect(r).toMatchObject({ exitCode: 0, outcome: "no-reader", claimed: [] });
    expect(s.listTaskEvents("t-w").filter((e) => e.kind === "notified")).toEqual([]);
    expect(s.get("t-w")!.readAt).toBeFalsy();
  });

  it("a cancelled wake task wakes nobody; its notice goes to the next prompt", async () => {
    const s = seed(task("t-w", "scheduled", { wake: true }));
    writeWakeMarker(S, wakeDir());
    const time = clock((n) => {
      if (n !== 2) return;
      const other = new TaskStore({ dbPath: db });
      try {
        other.upsert(task("t-w", "cancelled", { wake: true }), { kind: "cancelled", actor: "cli" });
      } finally {
        other.close();
      }
    });
    const r = await waiter(time);
    expect(r).toMatchObject({ exitCode: 0, outcome: "nothing-pending", claimed: [] });
    expect(r.errs).toEqual([]);
    expect(existsSync(marker())).toBe(false);
    expect(s.listSessionNotices({ sessionId: S }).map((n) => n.record.taskId)).toEqual(["t-w"]);
  });

  it("one unreadable process table keeps the wait; three in a row count as the claude process gone", async () => {
    for (const fails of [1, 3]) {
      seed(task(`t-ps${fails}`, "scheduled", { wake: true }));
      writeWakeMarker(S, wakeDir());
      const p = procs();
      let looks = 0;
      const proc: WaiterProcess = {
        ...p.proc,
        identity: (pids) => {
          looks++;
          // The start look, then `fails` failed ps runs at the next polls.
          return looks >= 2 && looks < 2 + fails ? pids.map(() => null) : p.proc.identity(pids);
        },
      };
      const r = await waiter({
        proc,
        ...clock((n) => {
          if (n === 5) finish(`t-ps${fails}`, { wake: true });
        }),
      });
      if (fails === 1) expect(r, "one failure").toMatchObject({ exitCode: 2, outcome: "woke" });
      else expect(r, "three failures").toMatchObject({ exitCode: 0, outcome: "claude-gone", claimed: [] });
    }
  });

  it("the waiter exits 0 when its hook shell ends, its pid runs another program, or its parent ended; it claims nothing and touches no marker", async () => {
    for (const end of ["hookExit", "hookReuse", "hookOrphan"] as const) {
      const s = seed(task(`t-${end}`, "scheduled", { wake: true }), task(`t-${end}-other`, "completed"));
      writeWakeMarker(S, wakeDir());
      const p = procs();
      const time = clock((n) => {
        if (n === 2) p[end]();
      });
      const r = await waiter({ proc: p.proc, hookPid: String(HOOK), ...time });
      expect(r, end).toMatchObject({ exitCode: 0, outcome: "hook-gone", claimed: [] });
      // Found at the third poll, the one after the change.
      expect(time.sleeps(), end).toBe(2);
      expect(r.errs, end).toEqual([]);
      expect(existsSync(marker()), end).toBe(true);
      expect(existsSync(pidFile()), end).toBe(false);
      expect(s.listSessionNotices({ sessionId: S }).map((n) => n.record.taskId), end).toContain(`t-${end}-other`);
      expect(s.listTaskEvents(`t-${end}-other`).filter((e) => e.kind === "notified"), end).toEqual([]);
    }
  });

  it("one unreadable look at the hook shell keeps the wait; three in a row count as the hook gone", async () => {
    for (const fails of [1, 3]) {
      seed(task(`t-hps${fails}`, "scheduled", { wake: true }));
      writeWakeMarker(S, wakeDir());
      const p = procs();
      let looks = 0;
      const proc: WaiterProcess = {
        ...p.proc,
        identity: (pids) => {
          looks++;
          const seen = p.proc.identity(pids);
          // The start look, then `fails` looks where only the hook shell's row is unreadable.
          return looks >= 2 && looks < 2 + fails ? seen.map((v, i) => (pids[i] === HOOK ? null : v)) : seen;
        },
      };
      const r = await waiter({
        proc,
        hookPid: String(HOOK),
        ...clock((n) => {
          if (n === 5) finish(`t-hps${fails}`, { wake: true });
        }),
      });
      if (fails === 1) expect(r, "one failure").toMatchObject({ exitCode: 2, outcome: "woke", claimed: [`t-hps${fails}`] });
      else expect(r, "three failures").toMatchObject({ exitCode: 0, outcome: "hook-gone", claimed: [] });
    }
  });

  it("a hook shell that is gone when the wake task completes gets no notice and nothing is claimed", async () => {
    const s = seed(task("t-w", "scheduled", { wake: true }));
    writeWakeMarker(S, wakeDir());
    const p = procs();
    let looks = 0;
    const proc: WaiterProcess = {
      ...p.proc,
      identity: (pids) => {
        // The start look, poll 1, poll 2 (the task finished before it), then the look before the write.
        if (++looks === 4) p.hookExit();
        return p.proc.identity(pids);
      },
    };
    const r = await waiter({
      proc,
      hookPid: String(HOOK),
      ...clock((n) => {
        if (n === 1) finish("t-w", { wake: true });
      }),
    });
    expect(r).toMatchObject({ exitCode: 0, outcome: "hook-gone", claimed: [] });
    expect(looks).toBe(4);
    expect(r.errs).toEqual([]);
    expect(s.listTaskEvents("t-w").filter((e) => e.kind === "notified")).toEqual([]);
    expect(existsSync(marker())).toBe(true);
  });

  it("a hook shell that is gone at the start look: the waiter exits 0 at once, writes no pid file and claims nothing", async () => {
    const s = seed(task("t-hg0", "scheduled", { wake: true }), task("t-hg0-other", "completed"));
    writeWakeMarker(S, wakeDir());
    const p = procs();
    p.hookExit();
    const time = clock();
    const r = await waiter({ proc: p.proc, hookPid: String(HOOK), ...time });
    expect(r).toMatchObject({ exitCode: 0, outcome: "hook-gone", claimed: [] });
    expect(time.sleeps()).toBe(0);
    expect(existsSync(pidFile())).toBe(false);
    expect(existsSync(marker())).toBe(true);
    expect(s.listTaskEvents("t-hg0-other").filter((e) => e.kind === "notified")).toEqual([]);
  });

  it("an unreadable look right before the write is not a gone hook: the notice is written and claimed", async () => {
    seed(task("t-pw", "scheduled", { wake: true }));
    writeWakeMarker(S, wakeDir());
    const p = procs();
    let looks = 0;
    const proc: WaiterProcess = {
      ...p.proc,
      // The start look, poll 1, poll 2 (the task finished before it), then the look before the write.
      identity: (pids) => (++looks === 4 ? pids.map(() => null) : p.proc.identity(pids)),
    };
    const r = await waiter({
      proc,
      hookPid: String(HOOK),
      ...clock((n) => {
        if (n === 1) finish("t-pw", { wake: true });
      }),
    });
    expect(looks).toBe(4);
    expect(r).toMatchObject({ exitCode: 2, outcome: "woke", claimed: ["t-pw"] });
  });

  it("without a valid hook pid the waiter keeps the rules it had before: the hook shell is not looked at", async () => {
    for (const hookPid of [undefined, "", "0", "1", "abc", "12x", "-5", " 5151", "4194305"]) {
      const id = `t-hp-${hookPid ?? "none"}`;
      seed(task(id, "scheduled", { wake: true }));
      writeWakeMarker(S, wakeDir());
      const p = procs();
      p.hookExit();
      const r = await waiter({
        proc: p.proc,
        hookPid,
        ...clock((n) => {
          if (n === 2) finish(id, { wake: true });
        }),
      });
      expect(r, String(hookPid)).toMatchObject({ exitCode: 2, outcome: "woke", claimed: [id] });
    }
  });

  it("when its claude process runs another session (/clear, /resume), the waiter exits 0 and claims nothing", async () => {
    const s = seed(task("t-w", "scheduled", { wake: true }));
    writeWakeMarker(S, wakeDir());
    let runs = S;
    const time = clock((n) => {
      if (n === 2) runs = "0aaa0000-0000-4000-8000-000000000002";
      if (n === 3) finish("t-w", { wake: true });
    });
    const r = await waiter({ proc: { ...procs().proc, session: () => runs }, ...time });
    expect(r).toMatchObject({ exitCode: 0, outcome: "session-changed", claimed: [] });
    expect(s.listTaskEvents("t-w").filter((e) => e.kind === "notified")).toEqual([]);
  });

  it("a waiter whose pid file a newer, finished waiter removed exits 0; one an older waiter removed writes it again", async () => {
    for (const by of ["newer", "older"] as const) {
      seed(task(`t-${by}`, "scheduled", { wake: true }));
      writeWakeMarker(S, wakeDir());
      let rewritten: string | undefined;
      const time = clock((n) => {
        if (n === 1) {
          rmSync(pidFile());
          // A newer waiter refreshed the marker at its start, later than this one did.
          if (by === "newer") utimesSync(marker(), new Date(T0 + 60_000), new Date(T0 + 60_000));
        }
        if (n === 2) rewritten = existsSync(pidFile()) ? readFileSync(pidFile(), "utf8") : undefined;
        if (n === 3) finish(`t-${by}`, { wake: true });
      });
      const r = await waiter(time);
      if (by === "newer") {
        expect(r, by).toMatchObject({ exitCode: 0, outcome: "replaced" });
        expect(existsSync(pidFile()), by).toBe(false);
      } else {
        expect(r, by).toMatchObject({ exitCode: 2, outcome: "woke" });
        expect(rewritten, by).toBe("1001\n");
      }
    }
  });

  it("a stop signal ends the wait with exit 0 and removes the pid file", async () => {
    seed(task("t-w", "scheduled", { wake: true }));
    writeWakeMarker(S, wakeDir());
    const stop = new AbortController();
    const r = await waiter({
      signal: stop.signal,
      ...clock((n) => {
        if (n === 2) stop.abort();
      }),
    });
    expect(r).toMatchObject({ exitCode: 0, outcome: "stopped" });
    expect(existsSync(pidFile())).toBe(false);
    expect(existsSync(marker())).toBe(true);
  });

  it("the waiter refreshes the marker's age at every start; the tick sweep removes markers older than 12 h with nothing to wait for", async () => {
    const s = seed(task("t-w", "scheduled", { wake: true }));
    writeWakeMarker(S, wakeDir());
    const old = new Date(Date.now() - 13 * 3_600_000);
    utimesSync(marker(), old, old);
    const stop = new AbortController();
    await waiter({
      signal: stop.signal,
      now: () => new Date(),
      sleep: async () => {
        stop.abort();
      },
    });
    expect(Date.now() - statSync(marker()).mtimeMs).toBeLessThan(60_000);
    const stale = "aaaa1111-0000-4000-8000-000000000001";
    writeWakeMarker(stale, wakeDir());
    utimesSync(join(wakeDir(), stale), old, old);
    expect(wakeSweep(s, wakeDir())).toEqual([stale]);
    expect(existsSync(marker())).toBe(true);
    expect(existsSync(join(wakeDir(), stale))).toBe(false);
  });

  it("the sweep keeps an old marker while its session has a wake task to come, and removes any marker older than 7 days", () => {
    const now = new Date();
    const at = (msAgo: number) => new Date(now.getTime() - msAgo);
    const s = seed(task("t-open", "scheduled", { wake: true }));
    const pending = S;
    const fileDue = "bbbb2222-0000-4000-8000-000000000003";
    const fileDueOld = "cccc3333-0000-4000-8000-000000000004";
    const ancient = "dddd4444-0000-4000-8000-000000000005";
    // A completed wake task whose result file is not recorded yet; and one that completed 8 days ago.
    for (const [id, sid, completed] of [
      ["t-file", fileDue, at(3_600_000)],
      ["t-file-old", fileDueOld, at(8 * 86_400_000)],
      ["t-ancient", ancient, at(3_600_000)],
    ] as const) {
      const r = task(id, id === "t-ancient" ? "scheduled" : "completed", { wake: true });
      const body = JSON.parse(r.bodyJson!);
      s.upsert({
        ...r,
        originSessionId: sid,
        ...(id === "t-ancient" ? {} : { completedAt: completed.toISOString() }),
        bodyJson: JSON.stringify({ ...body, handoff: { wake: true, resultPath: `/tmp/${id}.md` } }),
      });
    }
    for (const sid of [pending, fileDue, fileDueOld]) {
      writeWakeMarker(sid, wakeDir());
      utimesSync(join(wakeDir(), sid), at(13 * 3_600_000), at(13 * 3_600_000));
    }
    writeWakeMarker(ancient, wakeDir());
    utimesSync(join(wakeDir(), ancient), at(8 * 86_400_000), at(8 * 86_400_000));
    expect(wakeSweep(s, wakeDir(), now).sort()).toEqual([ancient, fileDueOld].sort());
    expect(existsSync(join(wakeDir(), pending))).toBe(true);
    expect(existsSync(join(wakeDir(), fileDue))).toBe(true);
    // Without a ledger, only the 7-day rule applies.
    writeWakeMarker(ancient, wakeDir());
    utimesSync(join(wakeDir(), ancient), at(8 * 86_400_000), at(8 * 86_400_000));
    expect(wakeSweep(undefined, wakeDir(), now)).toEqual([ancient]);
  });
});

describe("queue notices --wait --rewake through the built CLI", () => {
  const entry = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
  function cli(args: string[], input: string) {
    if (!existsSync(entry)) throw new Error(`build the CLI first: ${entry} is missing`);
    return spawnSync(process.execPath, [entry, ...args], { input, encoding: "utf8", env: { ...process.env, HOME: dir } });
  }

  it("without a wake marker it exits 0 with no output; --wait or --rewake alone exits 1, never 2", () => {
    seed(task("t-w", "completed", { wake: true }));
    const r = cli(["queue", "notices", "--wait", "--rewake", "--db", db, "--hook-input", "-"], hookInput);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
    expect(store().listTaskEvents("t-w").some((e) => e.kind === "notified")).toBe(false);
    for (const flag of ["--wait", "--rewake"]) {
      const alone = cli(["queue", "notices", flag, "--db", db], hookInput);
      expect(alone.status, flag).toBe(1);
      expect(alone.stdout, flag).toBe("");
    }
  });
});
