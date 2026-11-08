import type { SpawnOptions } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assessReadiness,
  LAST_TICK_META_KEY,
  pendingProvidersFromStore,
  readTickRunners,
  runnersFromSnapshot,
  TaskStore,
} from "@tidegap/core";
import * as childProcess from "node:child_process";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  missingProviderKeysForPending,
  processStartedAt,
  runTickOnce,
  TICK_BUSY_MESSAGE,
  TICK_LOCK_STALE_MS,
  tickProcessRunning,
} from "../src/commands/tick.js";
import type { ProbeExec } from "../src/platform/probe.js";

// Every child_process entry point is a pass-through spy, so the suite can
// prove that no tick path spawns a real process (a real notifier would post
// on the developer's desktop).
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(actual.spawn),
    spawnSync: vi.fn(actual.spawnSync),
    exec: vi.fn(actual.exec),
    execFile: vi.fn(actual.execFile),
    execFileSync: vi.fn(actual.execFileSync),
    execSync: vi.fn(actual.execSync),
    fork: vi.fn(actual.fork),
  };
});

afterAll(() => {
  for (const name of ["spawn", "spawnSync", "exec", "execFile", "execFileSync", "execSync", "fork"] as const) {
    expect(vi.mocked(childProcess[name]), `child_process.${name} was called`).not.toHaveBeenCalled();
  }
});

describe("tidegap tick", () => {
  const saved = {
    a: process.env.ANTHROPIC_API_KEY,
    o: process.env.OPENAI_API_KEY,
    g: process.env.GEMINI_API_KEY,
    gg: process.env.GOOGLE_API_KEY,
    oh: process.env.OLLAMA_HOST,
  };

  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.OLLAMA_HOST;
  });

  afterEach(() => {
    for (const [k, v] of [
      ["ANTHROPIC_API_KEY", saved.a],
      ["OPENAI_API_KEY", saved.o],
      ["GEMINI_API_KEY", saved.g],
      ["GOOGLE_API_KEY", saved.gg],
      ["OLLAMA_HOST", saved.oh],
    ] as const) {
      if (v !== undefined) process.env[k] = v;
      else delete process.env[k];
    }
  });

  it("exits 0 with a clear message when no adapters are configured", async () => {
    const r = await runTickOnce({ db: ":memory:", envFile: "/nonexistent/tidegap/env" });
    expect(r.exitCode).toBe(0);
    expect(r.message).toMatch(/no adapters configured/i);
  });
});

describe("tick lock (one tick at a time)", () => {
  let dir: string;
  let dbPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-tick-lock-"));
    dbPath = join(dir, "queue.db");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const tick = () => runTickOnce({ db: dbPath, envFile: join(dir, "no-env"), notify: false });
  const lock = () => `${dbPath}.tick.lock`;

  it("a second tick while one runs exits 0 with one line and does nothing; the lock is gone after", async () => {
    const [a, b] = await Promise.all([tick(), tick()]);
    expect(a.message).toMatch(/no adapters configured/i);
    expect(b).toEqual({ exitCode: 0, message: TICK_BUSY_MESSAGE });
    expect(existsSync(lock())).toBe(false);
    expect((await tick()).message).toMatch(/no adapters configured/i);
  });

  it("a fresh lock held by another process skips the tick; a stale one is taken over", async () => {
    writeFileSync(lock(), "");
    expect(await tick()).toEqual({ exitCode: 0, message: TICK_BUSY_MESSAGE });
    const store = new TaskStore({ dbPath });
    try {
      // A busy tick still proves the daemon runs (a long job run holds the lock), but takes no runner snapshot.
      expect(Date.now() - Date.parse(store.getMeta(LAST_TICK_META_KEY) ?? "")).toBeLessThan(60_000);
      expect(store.getMeta("tick_runners")).toBeUndefined();
    } finally {
      store.close();
    }
    const old = new Date(Date.now() - TICK_LOCK_STALE_MS - 5_000);
    utimesSync(lock(), old, old);
    expect((await tick()).message).toMatch(/no adapters configured/i);
    expect(existsSync(lock())).toBe(false);
  });

  it("a tick that throws still releases the lock", async () => {
    const saved = process.env.TIDEGAP_CLAUDE_CODE;
    delete process.env.TIDEGAP_CLAUDE_CODE;
    try {
      const boom = runTickOnce({
        db: dbPath,
        envFile: join(dir, "no-env"),
        notify: false,
        claudeLookup: { path: dir, home: dir, platform: "linux", isExecutable: () => { throw new Error("lookup failed"); } },
      });
      await expect(boom).rejects.toThrow("lookup failed");
    } finally {
      if (saved === undefined) delete process.env.TIDEGAP_CLAUDE_CODE;
      else process.env.TIDEGAP_CLAUDE_CODE = saved;
    }
    expect(existsSync(lock())).toBe(false);
    expect((await tick()).message).toMatch(/no adapters configured/i);
  });
});

describe("the tick lock rule: rows a dead tick left running", () => {
  let dir: string;
  let dbPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-tick-dead-"));
    dbPath = join(dir, "queue.db");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** A fake `ps`: `lstart` lines by pid (as `ps -o lstart=` prints them in UTC); any other pid prints nothing. */
  function ps(starts: Record<number, string>, calls: string[][] = []): ProbeExec {
    return (cmd, args) => {
      calls.push([cmd, ...args]);
      const line = starts[Number(args.at(-1))];
      return cmd === "env" && args.includes("lstart=") && line ? { status: 0, stdout: `${line}\n` } : { status: 1, stdout: "" };
    };
  }

  /** A pid no process has: the first candidate that signal 0 reports as gone. */
  function deadPid(): number {
    for (const pid of [99_991, 99_989, 77_773, 4_194_301]) {
      try {
        process.kill(pid, 0);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ESRCH") return pid;
      }
    }
    throw new Error("no free pid found");
  }

  /** A `running` one-off command row whose `dispatched` event names `tick`. */
  function runningCommand(store: TaskStore, taskId: string, tick: Record<string, unknown>): void {
    store.upsert({
      taskId,
      status: "running",
      enqueuedAt: new Date().toISOString(),
      region: "DE",
      bodyJson: JSON.stringify({ type: "provider_call", provider: "command", model: "none", prompt: "", command: { run: "sleep 600", origin: "cli" } }),
      deadline: new Date(Date.now() + 3 * 3_600_000).toISOString(),
    });
    store.recordEvent(taskId, { kind: "dispatched", actor: "tick", details: { tick } });
  }

  it("reads a start time from ps in UTC; nothing for a pid ps does not know", () => {
    const calls: string[][] = [];
    const exec = ps({ 4242: "Thu Nov  5 09:00:00 2026" }, calls);
    expect(processStartedAt(4242, exec)).toBe("2026-11-05T09:00:00.000Z");
    expect(calls[0]).toEqual(["env", "TZ=UTC", "LC_ALL=C", "ps", "-o", "lstart=", "-p", "4242"]);
    expect(processStartedAt(4343, exec)).toBeUndefined();
  });

  it("reads this process's real start time from the system ps", async (ctx) => {
    // The real spawnSync, not the spy: this test runs ps on purpose, and the guard above checks the tick paths.
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const exec: ProbeExec = (cmd, args) => {
      const out = actual.spawnSync(cmd, args, { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8", timeout: 5_000 });
      return out.error ? { status: null } : { status: out.status, stdout: out.stdout };
    };
    if (exec("ps", ["-o", "pid=", "-p", String(process.pid)]).status !== 0) ctx.skip();
    const at = Date.parse(processStartedAt(process.pid, exec) ?? "");
    expect(Math.abs(at - (Date.now() - process.uptime() * 1000))).toBeLessThan(5_000);
  });

  it("a live pid is the recorded tick within a few seconds of its start time, a reused pid beyond; no start time to compare is undecided", () => {
    const live = process.ppid;
    const exec = ps({ [live]: "Thu Nov  5 09:00:02 2026" });
    const at = (started_at?: string) => ({ id: "tick-x", pid: live, ...(started_at ? { started_at } : {}) });
    // Linux ps derives the start time from a boot time that moves with the wall clock.
    expect(tickProcessRunning(at("2026-11-05T09:00:00.000Z"), exec)).toBe(true);
    expect(tickProcessRunning(at("2026-11-05T08:59:50.000Z"), exec)).toBe(false);
    expect(tickProcessRunning(at(), exec)).toBeUndefined();
    expect(tickProcessRunning(at("2026-11-05T09:00:00.000Z"), ps({}))).toBeUndefined();
    expect(tickProcessRunning({ id: "tick-x", pid: deadPid(), started_at: "2026-11-05T09:00:00.000Z" }, exec)).toBe(false);
    expect(tickProcessRunning({ id: "tick-x", pid: process.pid, started_at: "2026-11-05T09:00:00.000Z" }, exec)).toBe(false);
  });

  it("frees the row of a dead tick and of a reused pid as an interrupted attempt; leaves a live tick's row under a stale-looking lock", async () => {
    const live = process.ppid;
    const store = new TaskStore({ dbPath });
    try {
      runningCommand(store, "dead", { id: "tick-1", pid: deadPid() });
      runningCommand(store, "reused", { id: "tick-2", pid: live, started_at: "2026-11-01T08:00:00.000Z" });
      runningCommand(store, "live", { id: "tick-3", pid: live, started_at: "2026-11-05T09:00:00.000Z" });
    } finally {
      store.close();
    }
    // The live tick slept past the stale age: its lock looks stale, and this tick takes it over.
    const lock = `${dbPath}.tick.lock`;
    writeFileSync(lock, "");
    const old = new Date(Date.now() - TICK_LOCK_STALE_MS - 5_000);
    utimesSync(lock, old, old);
    const r = await runTickOnce({ db: dbPath, envFile: join(dir, "no-env"), notify: false, exec: ps({ [live]: "Thu Nov  5 09:00:00 2026" }) });
    expect(r.message).toMatch(/^tick: 0 inspected, 0 dispatched, 0 failed, 2 to retry from /);
    const after = new TaskStore({ dbPath });
    try {
      // One retry by default: each freed row is queued again with an interrupted attempt.
      for (const id of ["dead", "reused"]) {
        expect(after.get(id)!.status, id).toBe("scheduled");
        expect(after.listTaskEvents(id).find((e) => e.kind === "attempt_failed")?.details, id).toMatchObject({
          attempt: 1,
          failure_class: "interrupted",
          error: "interrupted: the tick stopped during the run",
        });
      }
      expect(after.get("live")!.status).toBe("running");
      expect(after.listTaskEvents("live").filter((e) => e.kind === "dispatched")).toHaveLength(1);
    } finally {
      after.close();
    }
  });

  it("each dispatched event names this process and its start time", async () => {
    // An ollama adapter that cannot connect: the row is dispatched, then fails at once.
    const saved = process.env.OLLAMA_HOST;
    process.env.OLLAMA_HOST = "http://127.0.0.1:9";
    try {
      const store = new TaskStore({ dbPath });
      store.upsert({
        taskId: "due",
        status: "scheduled",
        enqueuedAt: new Date().toISOString(),
        scheduledFor: new Date(Date.now() - 60_000).toISOString(),
        region: "DE",
        bodyJson: JSON.stringify({ type: "provider_call", provider: "ollama", model: "m", prompt: "p" }),
        deadline: new Date(Date.now() + 3_600_000).toISOString(),
      });
      store.close();
      await runTickOnce({ db: dbPath, envFile: join(dir, "no-env"), notify: false, exec: ps({ [process.pid]: "Thu Nov  5 10:00:00 2026" }) });
      const after = new TaskStore({ dbPath });
      try {
        const tick = after.listTaskEvents("due").find((e) => e.kind === "dispatched")!.details.tick as Record<string, unknown>;
        expect(tick).toMatchObject({ pid: process.pid, started_at: "2026-11-05T10:00:00.000Z" });
        expect(tick.id).toMatch(/^[0-9a-f-]{36}$/);
      } finally {
        after.close();
      }
    } finally {
      if (saved === undefined) delete process.env.OLLAMA_HOST;
      else process.env.OLLAMA_HOST = saved;
    }
  });
});

describe("missing-provider-key warning", () => {
  let dir: string;
  let dbPath: string;
  const saved = {
    a: process.env.ANTHROPIC_API_KEY,
    o: process.env.OPENAI_API_KEY,
    g: process.env.GEMINI_API_KEY,
    gg: process.env.GOOGLE_API_KEY,
    oh: process.env.OLLAMA_HOST,
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-tick-"));
    dbPath = join(dir, "queue.db");
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.OLLAMA_HOST;
    const store = new TaskStore({ dbPath });
    store.upsert({
      taskId: "pending-anthropic",
      status: "scheduled",
      enqueuedAt: new Date().toISOString(),
      scheduledFor: new Date(Date.now() + 3600_000).toISOString(),
      region: "US-CAL-CISO",
      bodyJson: JSON.stringify({
        type: "provider_call",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        prompt: "hi",
      }),
    });
    store.close();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of [
      ["ANTHROPIC_API_KEY", saved.a],
      ["OPENAI_API_KEY", saved.o],
      ["GEMINI_API_KEY", saved.g],
      ["GOOGLE_API_KEY", saved.gg],
      ["OLLAMA_HOST", saved.oh],
    ] as const) {
      if (v !== undefined) process.env[k] = v;
      else delete process.env[k];
    }
  });

  it("detects the missing key for a pending provider task", () => {
    expect(missingProviderKeysForPending(dbPath)).toEqual(["ANTHROPIC_API_KEY"]);
  });

  it("does not flag the key once it is set", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    expect(missingProviderKeysForPending(dbPath)).toEqual([]);
  });

  it("tick with no keys names the missing key in its message", async () => {
    const r = await runTickOnce({ db: dbPath, envFile: join(dir, "no-env") });
    expect(r.exitCode).toBe(0);
    expect(r.message).toContain("ANTHROPIC_API_KEY");
    expect(r.message).toMatch(/config\/tidegap\/env/);
  });

  it("a tick with no adapters still records last_tick_at and a snapshot with only the command runner", async () => {
    const lookup = { path: join(dir, "empty"), home: join(dir, "home"), platform: "linux" as const, isExecutable: () => false };
    const r = await runTickOnce({ db: dbPath, envFile: join(dir, "no-env"), claudeLookup: lookup });
    expect(r.message).toMatch(/no adapters configured/i);
    const store = new TaskStore({ dbPath });
    try {
      expect(store.getMeta(LAST_TICK_META_KEY)).toBeTruthy();
      const snap = readTickRunners(store);
      expect(snap).toMatchObject({ providers: ["command"], claude_lookup: "done" });
      // Ledger-only readiness (the MCP server's view): the runner is the problem, not the ticker.
      const readiness = assessReadiness({
        daemon: "unknown",
        lastTickAt: store.getMeta(LAST_TICK_META_KEY),
        runners: runnersFromSnapshot(snap!),
        pendingByProvider: pendingProvidersFromStore(store),
      });
      expect(readiness.problems.map((p) => p.code)).toEqual(["no_runner"]);
    } finally {
      store.close();
    }
  });

  it("returns [] for a missing/unreadable db", () => {
    expect(missingProviderKeysForPending(join(dir, "nope.db"))).toEqual([]);
  });
});

describe("tick receipts use the region's grid feed", () => {
  let dir: string;
  let dbPath: string;
  const savedHost = process.env.OLLAMA_HOST;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-tick-feed-"));
    dbPath = join(dir, "queue.db");
    process.env.OLLAMA_HOST = "http://ollama.test";
    // One fetch stub answers both sides of the tick: the GB Carbon
    // Intensity API (a flat 123 gCO2/kWh curve) and the Ollama chat call.
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = String(input);
      if (url.startsWith("https://api.carbonintensity.org.uk/intensity/")) {
        const from = new Date(url.split("/")[4]!).getTime();
        const data = Array.from({ length: 96 }, (_, i) => ({
          from: new Date(from + i * 30 * 60_000).toISOString(),
          to: new Date(from + (i + 1) * 30 * 60_000).toISOString(),
          intensity: { forecast: 123, actual: null },
        }));
        return Response.json({ data });
      }
      if (url === "http://ollama.test/api/chat") {
        return Response.json({
          model: "llama3.2:1b",
          message: { role: "assistant", content: "ok" },
          done: true,
          prompt_eval_count: 5,
          eval_count: 3,
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const store = new TaskStore({ dbPath });
    store.upsert({
      taskId: "due-ollama-gb",
      status: "scheduled",
      enqueuedAt: new Date(Date.now() - 60_000).toISOString(),
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
      region: "GB",
      bodyJson: JSON.stringify({
        type: "provider_call",
        provider: "ollama",
        model: "llama3.2:1b",
        prompt: "hi",
      }),
    });
    store.close();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (savedHost !== undefined) process.env.OLLAMA_HOST = savedHost;
    else delete process.env.OLLAMA_HOST;
    rmSync(dir, { recursive: true, force: true });
  });

  it("records the live feed's intensity, not the mock curve", async () => {
    const r = await runTickOnce({
      db: dbPath,
      region: "GB",
      envFile: join(dir, "no-env"),
      budgetConfig: join(dir, "no-config"),
    });
    expect(r.message).toContain("1 dispatched");
    const store = new TaskStore({ dbPath });
    const receipt = store.get("due-ollama-gb")?.receipt;
    store.close();
    expect(receipt?.gridSource).toBe("ukCarbonIntensity");
    expect(receipt?.intensityGCo2PerKwh).toBe(123);
  });
});

describe("tidegap tick pre-tick step (quota sweep, last_tick_at)", () => {
  let dir: string;
  let db: string;
  const savedOllama = process.env.OLLAMA_HOST;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-cli-quota-"));
    db = join(dir, "queue.db");
    // An adapter must exist for the tick to run. The seeded tasks use the
    // anthropic provider, which has no adapter here, so even a task the
    // window picker makes due now fails fast without a network call.
    process.env.OLLAMA_HOST = "http://127.0.0.1:9";
  });
  afterEach(() => {
    if (savedOllama !== undefined) process.env.OLLAMA_HOST = savedOllama;
    else delete process.env.OLLAMA_HOST;
    rmSync(dir, { recursive: true, force: true });
  });

  function seed(label: string, prevReset: Date): void {
    const store = new TaskStore({ dbPath: db });
    store.upsert({
      taskId: `quota-${label}`,
      status: "scheduled",
      enqueuedAt: new Date(prevReset.getTime() - 3 * 86_400_000).toISOString(),
      // A far-future window, so the unchanged task is never due in this tick.
      scheduledFor: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      region: "DE",
      bodyJson: JSON.stringify({ type: "provider_call", provider: "anthropic", model: "m", prompt: "p" }),
      deadline: new Date(prevReset.getTime() - 2 * 3_600_000).toISOString(),
      deadlineKind: "quota_reset",
      quotaProvider: label,
    });
    store.close();
  }

  it("re-resolves a passed quota deadline, names a missing label, and records last_tick_at", async () => {
    const prevReset = new Date(Math.floor((Date.now() - 3_600_000) / 60_000) * 60_000);
    const day = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][prevReset.getUTCDay()];
    const config = join(dir, "config");
    writeFileSync(config, `TIDEGAP_QUOTA_RESET_CLAUDE=${day} ${prevReset.toISOString().slice(11, 16)} UTC\n`);
    seed("claude", prevReset);
    seed("codex", prevReset);

    const r = await runTickOnce({ db, envFile: "/nonexistent/tidegap/env", budgetConfig: config });
    expect(r.message).toMatch(/quota reset \(claude\) passed for quota-claude/);
    expect(r.message).toMatch(/"codex" is not configured/);

    const store = new TaskStore({ dbPath: db });
    const expected = prevReset.getTime() + 7 * 86_400_000 - 2 * 3_600_000;
    expect(store.get("quota-claude")!.deadline).toBe(new Date(expected).toISOString());
    expect(store.get("quota-codex")!.deadline).toBe(
      new Date(prevReset.getTime() - 2 * 3_600_000).toISOString(),
    );
    expect(store.getMeta("last_tick_at")).toBeDefined();
    store.close();
  });
});

describe("tidegap tick notifications", () => {
  let dir: string;
  let dbPath: string;
  const savedHost = process.env.OLLAMA_HOST;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-tick-notify-"));
    dbPath = join(dir, "queue.db");
    process.env.OLLAMA_HOST = "http://ollama.test";
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = String(input);
      if (url === "http://ollama.test/api/chat") {
        return Response.json({
          model: "llama3.2:1b",
          message: { role: "assistant", content: "ok" },
          done: true,
          prompt_eval_count: 5,
          eval_count: 3,
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const store = new TaskStore({ dbPath });
    const due = (taskId: string, provider: string) =>
      store.upsert({
        taskId,
        status: "scheduled",
        enqueuedAt: new Date(Date.now() - 60_000).toISOString(),
        scheduledFor: new Date(Date.now() - 1_000).toISOString(),
        region: "FR",
        title: `title ${taskId}`,
        bodyJson: JSON.stringify({ type: "provider_call", provider, model: "llama3.2:1b", prompt: "hi" }),
      });
    due("ok-1", "ollama");
    due("ok-2", "ollama");
    // No anthropic adapter is registered, so this one fails fast.
    due("bad-1", "anthropic");
    store.close();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (savedHost !== undefined) process.env.OLLAMA_HOST = savedHost;
    else delete process.env.OLLAMA_HOST;
    rmSync(dir, { recursive: true, force: true });
  });

  function run(extra: Partial<Parameters<typeof runTickOnce>[0]> = {}) {
    const calls: Array<{ cmd: string; args: string[]; opts: SpawnOptions }> = [];
    const result = runTickOnce({
      db: dbPath,
      region: "FR",
      envFile: join(dir, "no-env"),
      budgetConfig: join(dir, "no-config"),
      platform: "linux",
      spawnNotify: (cmd, args, opts) => {
        calls.push({ cmd, args, opts });
      },
      ...extra,
    });
    return { result, calls };
  }

  it("posts one notification per completed or failed task (AE8)", async () => {
    const { result, calls } = run();
    const r = await result;
    expect(r.message.split("\n")[0]).toBe("tick: 3 inspected, 2 dispatched, 1 failed");
    expect(r.exitCode).toBe(1);
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.cmd === "notify-send" && c.args[0] === "--")).toBe(true);
    const titles = calls.map((c) => c.args[1]).sort();
    expect(titles).toEqual([
      "Tidegap: done: title ok-1",
      "Tidegap: done: title ok-2",
      "Tidegap: failed: title bad-1",
    ]);
  });

  it("--no-notify posts nothing", async () => {
    const { result, calls } = run({ notify: false });
    await result;
    expect(calls).toHaveLength(0);
  });

  it("TIDEGAP_NOTIFY=0 in the config posts nothing", async () => {
    const config = join(dir, "config");
    writeFileSync(config, "TIDEGAP_NOTIFY=0\n");
    const { result, calls } = run({ budgetConfig: config });
    await result;
    expect(calls).toHaveLength(0);
  });

  for (const [name, expectNone] of [
    ["TIDEGAP_NO_NOTIFY", true],
    ["EBB_NO_NOTIFY", false],
  ] as const) {
    it(`${name}=1 in the environment ${expectNone ? "posts nothing" : "is ignored since 0.19"}`, async () => {
      const saved = { TIDEGAP_NO_NOTIFY: process.env.TIDEGAP_NO_NOTIFY, EBB_NO_NOTIFY: process.env.EBB_NO_NOTIFY };
      delete process.env.TIDEGAP_NO_NOTIFY;
      delete process.env.EBB_NO_NOTIFY;
      process.env[name] = "1";
      try {
        const { result, calls } = run();
        await result;
        if (expectNone) expect(calls).toHaveLength(0);
        else expect(calls.length).toBeGreaterThan(0);
      } finally {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    });
  }

  it("without an injected spawner, a test run spawns no notifier", async () => {
    const { result } = run({ spawnNotify: undefined, platform: "darwin" });
    const r = await result;
    expect(r.message.split("\n")[0]).toBe("tick: 3 inspected, 2 dispatched, 1 failed");
    // The suite-level afterAll asserts child_process was never called.
  });

  it("win32 passes the text through env vars with a timeout on the child", async () => {
    const { result, calls } = run({ platform: "win32" });
    await result;
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      expect(c.cmd).toBe("powershell");
      expect(c.opts.timeout).toBeGreaterThan(0);
      expect(c.opts.env?.TIDEGAP_NOTIFY_TITLE).toMatch(/^Tidegap: (done|failed): title /);
      expect(c.opts.env?.PATH).toBe(process.env.PATH);
      expect(c.args.join(" ")).not.toContain("title ok-1");
    }
  });

  it("an unknown platform posts nothing and keeps the outcome", async () => {
    const { result, calls } = run({ platform: "aix" });
    const r = await result;
    expect(calls).toHaveLength(0);
    expect(r.message).toContain("2 dispatched, 1 failed");
  });

  it("a throwing spawner does not change the outcome", async () => {
    const r = await runTickOnce({
      db: dbPath,
      region: "FR",
      envFile: join(dir, "no-env"),
      budgetConfig: join(dir, "no-config"),
      platform: "linux",
      spawnNotify: () => {
        throw new Error("boom");
      },
    });
    expect(r.exitCode).toBe(1);
    expect(r.message).toContain("2 dispatched, 1 failed");
  });
});

describe("tick runner snapshot", () => {
  const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-claude");
  let root: string;
  let dbPath: string;
  const keys = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "OLLAMA_HOST", "TIDEGAP_CLAUDE_BIN", "TIDEGAP_CLAUDE_CODE"];
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const k of keys) {
      saved.set(k, process.env[k]);
      delete process.env[k];
    }
    root = realpathSync(mkdtempSync(join(tmpdir(), "tidegap-tick-snap-")));
    dbPath = join(root, "queue.db");
    cpSync(FIXTURE, join(root, "bin"), { recursive: true });
  });

  afterEach(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  });

  function snapshot() {
    const store = new TaskStore({ dbPath });
    try {
      return readTickRunners(store);
    } finally {
      store.close();
    }
  }

  it("records claude_lookup skipped on an empty macOS queue (the login shell never ran)", async () => {
    let shellRan = false;
    await runTickOnce({
      db: dbPath,
      envFile: join(root, "no-env"),
      notify: false,
      claudeLookup: {
        path: join(root, "empty"),
        home: join(root, "home"),
        platform: "darwin",
        isExecutable: () => false,
        loginShell: async () => {
          shellRan = true;
          return undefined;
        },
      },
    });
    expect(shellRan).toBe(false);
    expect(snapshot()).toMatchObject({ providers: ["command"], claude_lookup: "skipped" });
  });

  it("lists claude-code and anthropic when the fake claude is found", async () => {
    await runTickOnce({
      db: dbPath,
      envFile: join(root, "no-env"),
      notify: false,
      claudeLookup: {
        path: join(root, "bin"),
        home: join(root, "home"),
        platform: "linux",
        isExecutable: (p) => p.startsWith(root) && existsSync(p),
        loginShell: async () => undefined,
      },
    });
    expect(snapshot()).toMatchObject({ providers: ["anthropic", "claude-code", "command"], claude_lookup: "done" });
  });
});
