/**
 * Session notices: `queue notices` (the prompt hook's command) and the
 * tick's marker sweep under ~/.tidegap/sessions/notices.
 */

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_NOTICES_SINCE_META_KEY, TaskStore } from "@tidegap/core";
import type { TaskRecord, TaskStatus } from "@tidegap/core";

import { runQueueNotices, type QueueNoticesOptions } from "../src/commands/queue-watch.js";
import { runTickOnce } from "../src/commands/tick.js";
import { noticeMarkerPath, noticesDir, noticeSweep } from "../src/handoff/notices.js";
import { UsageError, type SessionSources } from "../src/handoff/session.js";
import { sessionsDir } from "../src/session/capture.js";

const S1 = "sess-aaaa1111";
const S2 = "sess-bbbb2222";

interface RawDb {
  prepare(sql: string): { run(...a: unknown[]): unknown };
  close(): void;
}

/** A raw handle with TaskStore's backend order: node:sqlite, else better-sqlite3 (CI's Node 20). */
function openRawDb(path: string): RawDb {
  const req = createRequire(import.meta.url);
  try {
    const { DatabaseSync } = req("node:sqlite") as { DatabaseSync: new (p: string) => RawDb };
    return new DatabaseSync(path);
  } catch {
    const Database = req("better-sqlite3") as new (p: string) => RawDb;
    return new Database(path);
  }
}

function finished(
  taskId: string,
  status: TaskStatus,
  opts: { session?: string; title?: string; resultPath?: string; result?: string; error?: string; minutesAgo?: number } = {},
): TaskRecord<unknown> {
  const body = {
    type: "provider_call",
    provider: "anthropic",
    model: "m",
    prompt: "secret prompt text",
    origin: { agent: "claude-code", via: "hook" },
    ...(opts.resultPath ? { handoff: { resultPath: opts.resultPath } } : {}),
  };
  return {
    taskId,
    status,
    enqueuedAt: new Date(Date.now() - 3_600_000).toISOString(),
    completedAt: new Date(Date.now() - (opts.minutesAgo ?? 1) * 60_000).toISOString(),
    region: "FR",
    title: opts.title ?? `title ${taskId}`,
    originSessionId: opts.session ?? S1,
    bodyJson: JSON.stringify(body),
    ...(opts.result !== undefined ? { result: { text: opts.result } } : {}),
    ...(opts.error !== undefined ? { error: opts.error } : {}),
  } as TaskRecord<unknown>;
}

const hookInput = (sessionId: string) => JSON.stringify({ session_id: sessionId, hook_event_name: "UserPromptSubmit", prompt: "status?" });

let dir: string;
let db: string;
let markers: string;
const open: TaskStore[] = [];

function store(): TaskStore {
  const s = new TaskStore({ dbPath: db });
  open.push(s);
  return s;
}

/** A ledger whose notices cover everything finished this year. */
function ledger(): TaskStore {
  const s = store();
  s.setMeta(SESSION_NOTICES_SINCE_META_KEY, "2026-01-01T00:00:00.000Z");
  return s;
}

function fileEvent(taskId: string, details: Record<string, unknown>): void {
  const raw = openRawDb(db);
  raw.prepare(`INSERT INTO task_events (task_id, at, kind, actor, details) VALUES (?, ?, 'result_file', 'tick', ?)`).run(taskId, new Date().toISOString(), JSON.stringify(details));
  raw.close();
}

/** Runs `queue notices`; returns what it printed. */
async function notices(opts: QueueNoticesOptions): Promise<{ printed: string[]; claimed: string[] }> {
  const printed: string[] = [];
  const res = await runQueueNotices({ db, dir: markers, print: (t) => printed.push(t), ...opts });
  return { printed, claimed: res.claimed };
}

const own = (sessionId?: string): SessionSources => ({
  claudePid: () => undefined,
  readCapture: () => undefined,
  envSessionId: () => sessionId,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tidegap-notices-"));
  db = join(dir, "queue.db");
  markers = join(dir, "sessions", "notices");
});

afterEach(() => {
  for (const s of open.splice(0)) s.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("queue notices --hook", () => {
  it("notices --hook prints this session's finished tasks with title and result_path, then claims them", async () => {
    const s = ledger();
    s.upsert(finished("t-n1", "completed", { title: "Nightly test run", resultPath: "/tmp/tg-result.txt", minutesAgo: 3 }));
    s.upsert(finished("t-n2", "failed", { title: "Review the API change", minutesAgo: 2 }));
    s.upsert(finished("t-other", "completed", { session: S2 }));
    fileEvent("t-n1", { path: "/tmp/tg-result.txt", written: true, bytes: 12 });
    noticeSweep(s, markers);
    expect(existsSync(join(markers, S1))).toBe(true);
    const { printed, claimed } = await notices({ hook: true, hookInput: hookInput(S1) });
    expect(printed).toEqual([
      [
        "Tidegap: 2 tasks queued from this session finished:",
        '- t-n1 completed "Nightly test run" result_path: /tmp/tg-result.txt',
        '- t-n2 failed "Review the API change"',
        "Read one with: tidegap queue show <id> (or check_queue_status task_id=<id>).",
      ].join("\n"),
    ]);
    expect(claimed).toEqual(["t-n1", "t-n2"]);
    const n1 = s.listTaskEvents("t-n1").filter((e) => e.kind === "notified");
    expect(n1).toHaveLength(1);
    expect(n1[0]).toMatchObject({ actor: "agent:claude-code", details: { via: "prompt", session_id: S1 } });
    expect(s.get("t-n1")?.readAt).toBeTruthy();
    expect(s.get("t-n2")?.readAt).toBeTruthy();
    expect(s.get("t-other")?.readAt).toBeUndefined();
    // Nothing is left for S1, so its marker is gone; S2 keeps its own.
    expect(existsSync(join(markers, S1))).toBe(false);
    expect(existsSync(join(markers, S2))).toBe(true);
  });

  it("a second notices --hook prints nothing", async () => {
    const s = ledger();
    s.upsert(finished("t-once", "completed"));
    expect((await notices({ hook: true, hookInput: hookInput(S1) })).printed).toHaveLength(1);
    expect(await notices({ hook: true, hookInput: hookInput(S1) })).toEqual({ printed: [], claimed: [] });
  });

  it('a task whose result file failed prints "result file not written"', async () => {
    const s = ledger();
    s.upsert(finished("t-file", "completed", { title: "Write it", resultPath: "/tmp/tg-taken.txt" }));
    // Held back until the result file is settled.
    expect((await notices({ hook: true, hookInput: hookInput(S1), peek: true })).printed).toEqual([]);
    fileEvent("t-file", { path: "/tmp/tg-taken.txt", written: false, error: "the file exists" });
    const { printed } = await notices({ hook: true, hookInput: hookInput(S1) });
    expect(printed[0]).toContain('- t-file completed "Write it" result file not written');
    expect(printed[0]).not.toContain("the file exists");
  });

  it("a title with control characters and 300 characters prints one quoted line of at most 60 title characters", async () => {
    const s = ledger();
    const title = `\u001b[31mred\u0007 ${"x".repeat(300)}\nsecond line`;
    s.upsert(finished("t-long", "completed", { title }));
    const { printed } = await notices({ hook: true, hookInput: hookInput(S1) });
    const lines = printed[0]!.split("\n");
    expect(lines).toHaveLength(3);
    const quoted = /^- t-long completed (".*")$/.exec(lines[1]!)?.[1];
    expect(quoted).toBeDefined();
    const shown = JSON.parse(quoted!) as string;
    expect(Array.from(shown)).toHaveLength(60);
    expect(shown.startsWith("[31mred ")).toBe(true);
    expect(shown.endsWith("…")).toBe(true);
    // eslint-disable-next-line no-control-regex
    expect(printed[0]).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/);
  });

  it("the notice never contains the result text or the error text", async () => {
    const s = ledger();
    s.upsert(finished("t-r", "completed", { result: "RESULT-TEXT-123" }));
    s.upsert(finished("t-e", "failed", { error: "ERROR-TEXT-456" }));
    const { printed } = await notices({ hook: true, hookInput: hookInput(S1) });
    expect(printed[0]).toContain("t-r completed");
    expect(printed[0]).toContain("t-e failed");
    expect(printed[0]).not.toMatch(/RESULT-TEXT|ERROR-TEXT|secret prompt/);
  });

  it('twelve finished tasks print 10 lines and "and 2 more"', async () => {
    const s = ledger();
    for (let i = 1; i <= 12; i++) s.upsert(finished(`t-${String(i).padStart(2, "0")}`, "completed", { minutesAgo: 20 - i }));
    const first = await notices({ hook: true, hookInput: hookInput(S1) });
    const lines = first.printed[0]!.split("\n");
    expect(lines[0]).toBe("Tidegap: 12 tasks queued from this session finished:");
    expect(lines.filter((l) => /^- t-\d\d /.test(l))).toHaveLength(10);
    expect(lines[11]).toBe("- and 2 more: run `tidegap queue list --session current`.");
    expect(first.claimed).toHaveLength(10);
    // The two it did not name come on the next prompt.
    const second = await notices({ hook: true, hookInput: hookInput(S1) });
    expect(second.claimed).toEqual(["t-11", "t-12"]);
  });

  it("notices --hook with input that is not JSON, or names no session, prints nothing and exits 0", async () => {
    const s = ledger();
    s.upsert(finished("t-x", "completed"));
    for (const input of [undefined, "", "not json", "{", JSON.stringify({ prompt: "hi" }), JSON.stringify({ session_id: "../../etc" })]) {
      expect(await notices({ hook: true, hookInput: input })).toEqual({ printed: [], claimed: [] });
    }
    // A missing ledger is not created.
    rmSync(db, { force: true });
    expect(await notices({ hook: true, hookInput: hookInput(S1), db: join(dir, "absent.db") })).toEqual({ printed: [], claimed: [] });
    expect(existsSync(join(dir, "absent.db"))).toBe(false);
  });

  it("notices --hook past its 5 s deadline prints and claims nothing", async () => {
    const s = ledger();
    s.upsert(finished("t-late", "completed"));
    let calls = 0;
    const start = Date.now();
    // The first reading is the start; every later one is 6 s on.
    const now = () => new Date(calls++ === 0 ? start : start + 6_000);
    expect(await notices({ hook: true, hookInput: hookInput(S1), now })).toEqual({ printed: [], claimed: [] });
    expect(s.listTaskEvents("t-late").some((e) => e.kind === "notified")).toBe(false);
    expect(s.get("t-late")?.readAt).toBeUndefined();
  });

  it("notices --hook that runs past its deadline after the print claims no more and keeps the marker", async () => {
    const s = ledger();
    s.upsert(finished("t-slow", "completed"));
    noticeSweep(s, markers);
    let clock = Date.now();
    const printed: string[] = [];
    // The print returns 6 s after the process started: a busy ledger or a slow machine.
    const late = await runQueueNotices({
      db,
      dir: markers,
      hook: true,
      hookInput: hookInput(S1),
      startedAt: clock,
      now: () => new Date(clock),
      print: (t) => {
        printed.push(t);
        clock += 6_000;
      },
    });
    expect(printed).toHaveLength(1);
    expect(late.claimed).toEqual([]);
    expect(s.listTaskEvents("t-slow").some((e) => e.kind === "notified")).toBe(false);
    expect(s.get("t-slow")?.readAt).toBeUndefined();
    expect(existsSync(join(markers, S1))).toBe(true);
    // The next prompt delivers it again, in time, and claims it.
    const next = await notices({ hook: true, hookInput: hookInput(S1) });
    expect(next.printed).toHaveLength(1);
    expect(next.claimed).toEqual(["t-slow"]);
    expect(existsSync(join(markers, S1))).toBe(false);
  });

  it("notices --hook counts its deadline from startedAt (the CLI passes its process start)", async () => {
    const s = ledger();
    s.upsert(finished("t-start", "completed"));
    // A process that started 6 s ago (a slow Node start) prints nothing.
    const res = await runQueueNotices({ db, dir: markers, hook: true, hookInput: hookInput(S1), startedAt: Date.now() - 6_000, print: () => {} });
    expect(res).toEqual({ rendered: "", claimed: [] });
    expect(s.listTaskEvents("t-start").some((e) => e.kind === "notified")).toBe(false);
  });
});

describe("queue notices without --hook", () => {
  it("notices --session <another session> without --peek exits 2", async () => {
    ledger().upsert(finished("t-b", "completed", { session: S2 }));
    const err = await notices({ session: S2, sessionSources: own(S1) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UsageError);
    expect((err as UsageError).exitCode).toBe(2);
    const outside = await notices({ sessionSources: own() }).catch((e: unknown) => e);
    expect((outside as UsageError).exitCode).toBe(2);
    // Its own session works and claims as the CLI.
    const mine = await notices({ session: S2, sessionSources: own(S2) });
    expect(mine.claimed).toEqual(["t-b"]);
    expect(store().listTaskEvents("t-b").find((e) => e.kind === "notified")).toMatchObject({ actor: "cli", details: { via: "cli", session_id: S2 } });
  });

  it("notices --peek prints and claims nothing", async () => {
    const s = ledger();
    s.upsert(finished("t-p", "completed", { session: S2 }));
    noticeSweep(s, markers);
    const peek = await notices({ session: S2, peek: true, sessionSources: own(S1) });
    expect(peek.printed[0]).toContain("- t-p completed");
    expect(peek.claimed).toEqual([]);
    expect(s.listTaskEvents("t-p").some((e) => e.kind === "notified")).toBe(false);
    expect(s.get("t-p")?.readAt).toBeUndefined();
    expect(existsSync(join(markers, S2))).toBe(true);
  });
});

describe("noticeSweep", () => {
  it("noticeSweep creates a marker for a session with a deliverable notice and removes it when claimed", () => {
    const s = ledger();
    s.upsert(finished("t-s", "completed"));
    expect(noticeSweep(s, markers)).toEqual({ created: [S1], removed: [] });
    expect(statSync(markers).mode & 0o777).toBe(0o700);
    expect(statSync(join(markers, S1)).mode & 0o777).toBe(0o600);
    // A second sweep keeps it.
    expect(noticeSweep(s, markers)).toEqual({ created: [], removed: [] });
    expect(s.claimNotice("t-s", { via: "prompt", session_id: S1 })).toBe(true);
    expect(noticeSweep(s, markers)).toEqual({ created: [], removed: [S1] });
    expect(readdirSync(markers)).toEqual([]);
  });

  it("noticeSweep never writes a marker for a session id that fails the id rule", () => {
    const s = ledger();
    for (const [i, bad] of ["../../escape-x", "a/b/c/d/e/f", "has.dots.in", "short"].entries()) {
      s.upsert(finished(`t-bad-${i}`, "completed", { session: bad }));
    }
    expect(noticeSweep(s, markers)).toEqual({ created: [], removed: [] });
    expect(existsSync(markers)).toBe(false);
    expect(existsSync(join(dir, "escape-x"))).toBe(false);
    expect(noticeMarkerPath("../x", markers)).toBeUndefined();
  });

  it("noticeSweep removes markers older than 7 days", () => {
    const s = ledger();
    s.upsert(finished("t-due", "completed"));
    mkdirSync(markers, { recursive: true });
    const old = new Date(Date.now() - 8 * 86_400_000);
    for (const id of [S1, S2]) {
      writeFileSync(join(markers, id), "x\n");
      utimesSync(join(markers, id), old, old);
    }
    const res = noticeSweep(s, markers);
    expect(res.removed.sort()).toEqual([S1, S2]);
    // S1 still has a notice, so it gets a fresh marker; S2 has none.
    expect(res.created).toEqual([S1]);
    expect(Date.now() - statSync(join(markers, S1)).mtimeMs).toBeLessThan(60_000);
    expect(existsSync(join(markers, S2))).toBe(false);
  });

  it("a task completed by another writer gets its marker on the next sweep", () => {
    const s = ledger();
    expect(noticeSweep(s, markers).created).toEqual([]);
    // The Python core writes its rows with plain SQL.
    const raw = openRawDb(db);
    raw
      .prepare(
        `INSERT INTO tasks (task_id, status, enqueued_at, completed_at, region, origin_session_id, body_json)
         VALUES (?, 'completed', ?, ?, 'FR', ?, ?)`,
      )
      .run("t-py", new Date(Date.now() - 600_000).toISOString(), new Date().toISOString(), S2, JSON.stringify({ type: "provider_call", provider: "anthropic", model: "m", prompt: "p", origin: { agent: "claude-code", via: "env" } }));
    raw.close();
    expect(noticeSweep(s, markers).created).toEqual([S2]);
  });

  it("noticeSweep never follows a file planted at a marker path", () => {
    const s = ledger();
    s.upsert(finished("t-link", "completed"));
    mkdirSync(markers, { recursive: true, mode: 0o700 });
    const target = join(dir, "target.txt");
    writeFileSync(target, "keep\n");
    symlinkSync(target, join(markers, S1));
    noticeSweep(s, markers);
    expect(readFileSync(target, "utf8")).toBe("keep\n");
    expect(lstatSync(join(markers, S1)).isSymbolicLink()).toBe(true);
  });

  it("a tick pass with an adapter runs the sweep", async () => {
    const keys = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "OLLAMA_HOST", "TIDEGAP_CLAUDE_BIN", "TIDEGAP_CLAUDE_CODE"];
    const saved = keys.map((k) => [k, process.env[k]] as const);
    for (const k of keys) delete process.env[k];
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-a-key";
    try {
      ledger().upsert(finished("t-pass", "completed"));
      const home = noticesDir(sessionsDir());
      expect(existsSync(join(home, S1))).toBe(false);
      const r = await runTickOnce({
        db,
        envFile: join(dir, "no-env"),
        notify: false,
        claudeLookup: { path: "", home: dir, platform: "linux", isExecutable: () => false, loginShell: async () => undefined },
      });
      expect(r.message).toMatch(/^tick: /);
      expect(existsSync(join(home, S1))).toBe(true);
      rmSync(join(home, S1), { force: true });
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("a tick with no adapters still runs the sweep", async () => {
    const keys = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "OLLAMA_HOST", "TIDEGAP_CLAUDE_BIN", "TIDEGAP_CLAUDE_CODE"];
    const saved = keys.map((k) => [k, process.env[k]] as const);
    for (const k of keys) delete process.env[k];
    try {
      ledger().upsert(finished("t-tick", "completed"));
      const home = noticesDir(sessionsDir());
      expect(existsSync(join(home, S1))).toBe(false);
      const r = await runTickOnce({
        db,
        envFile: join(dir, "no-env"),
        notify: false,
        claudeLookup: { path: "", home: dir, platform: "linux", isExecutable: () => false, loginShell: async () => undefined },
      });
      expect(r.message).toMatch(/no adapters configured/);
      expect(existsSync(join(home, S1))).toBe(true);
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
