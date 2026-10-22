/**
 * Readiness (coherence U1, KTD1 to KTD3): one pure assessment of "will
 * queued tasks run?" over host-gathered facts, plus the ledger helpers.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assessReadiness,
  pendingProvidersFromStore,
  readTickRunners,
  readTickSleep,
  writeTickSleep,
  runnersFromSnapshot,
  sleptBetween,
  Scheduler,
  mockGridFeed,
  TaskStore,
  TICK_RUNNERS_META_KEY,
  TICK_SLEEP_META_KEY,
  writeTickRunners,
} from "../src/index.js";
import type { ReadinessFacts } from "../src/index.js";

const NOW = new Date("2026-10-20T12:00:00.000Z");
const ago = (s: number) => new Date(NOW.getTime() - s * 1000).toISOString();

function facts(extra: Partial<ReadinessFacts> = {}): ReadinessFacts {
  return { daemon: "not_installed", lastTickAt: null, runners: null, pendingByProvider: {}, now: NOW, ...extra };
}

const codes = (f: ReadinessFacts) => assessReadiness(f).problems.map((p) => p.code);

describe("assessReadiness", () => {
  it("never ticked, no daemon → no_daemon with the install line", () => {
    const r = assessReadiness(facts());
    expect(r.ready).toBe(false);
    expect(r.problems.map((p) => p.code)).toEqual(["no_daemon"]);
    expect(r.line).toBe("Tasks will not run: no tick daemon. Run `tidegap install`.");
    expect(r.problems[0]!.fix).toBe("tidegap install");
  });

  it("never ticked, daemon unknown (ledger-only host) → no_daemon", () => {
    expect(codes(facts({ daemon: "unknown" }))).toEqual(["no_daemon"]);
  });

  it("daemon loaded, never ticked → ready with a first-tick note", () => {
    const r = assessReadiness(facts({ daemon: "loaded" }));
    expect(r.ready).toBe(true);
    expect(r.line).toBeNull();
    expect(r.notes).toEqual(["first tick within 5 minutes"]);
  });

  it("no daemon: a tick 30 s ago (page dispatcher) is ready; 3 minutes ago is not", () => {
    expect(assessReadiness(facts({ lastTickAt: ago(30) })).ready).toBe(true);
    expect(codes(facts({ lastTickAt: ago(180) }))).toEqual(["no_daemon"]);
  });

  it("installed, not loaded, no recent tick → daemon_not_loaded, fix tidegap install", () => {
    const r = assessReadiness(facts({ daemon: "installed_not_loaded" }));
    expect(r.problems.map((p) => p.code)).toEqual(["daemon_not_loaded"]);
    expect(r.problems[0]!.fix).toBe("tidegap install");
  });

  it("installed with a 300 s interval: 11 minutes old is stale, 9 minutes is fine", () => {
    expect(codes(facts({ daemon: "loaded", lastTickAt: ago(11 * 60) }))).toEqual(["daemon_stale"]);
    expect(codes(facts({ daemon: "installed", lastTickAt: ago(11 * 60) }))).toEqual(["daemon_stale"]);
    expect(assessReadiness(facts({ daemon: "loaded", lastTickAt: ago(9 * 60) })).ready).toBe(true);
    expect(assessReadiness(facts({ daemon: "loaded", lastTickAt: ago(11 * 60) })).line).toBe(
      "Tasks may not run: the tick daemon last ran 11 minutes ago. Run `tidegap tick --once` and check the error.",
    );
  });

  it("no_daemon and no_runner together: the line names no_daemon first", () => {
    const r = assessReadiness(
      facts({ runners: { providers: [], unknown: [], source: "probe" }, pendingByProvider: { openai: 1 } }),
    );
    expect(r.problems.map((p) => p.code)).toEqual(["no_daemon", "no_runner"]);
    expect(r.line).toMatch(/^Tasks will not run: no tick daemon\./);
  });

  it("a snapshot with claude-code and anthropic, 2 pending openai tasks → one no_runner for openai", () => {
    const runners = runnersFromSnapshot({ at: ago(30), providers: ["claude-code", "anthropic"], claude_lookup: "done" });
    const r = assessReadiness(
      facts({ lastTickAt: ago(30), runners, pendingByProvider: { openai: 2, anthropic: 3 } }),
    );
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatchObject({ code: "no_runner", provider: "openai", tasks: 2 });
    expect(r.problems[0]!.fix).toMatch(/OPENAI_API_KEY/);
    expect(r.line).toMatch(/2 openai tasks/);
  });

  it("a recent tick and no runner fact → runners unknown, ready (R2)", () => {
    expect(assessReadiness(facts({ lastTickAt: ago(30), pendingByProvider: { openai: 1 } })).ready).toBe(true);
  });

  it("no pending tasks and no runner → ready", () => {
    const r = assessReadiness(
      facts({ lastTickAt: ago(30), runners: { providers: [], unknown: [], source: "snapshot" } }),
    );
    expect(r.ready).toBe(true);
  });

  it("claude_lookup skipped: a pending anthropic task without a key is unknown, not missing", () => {
    const runners = runnersFromSnapshot({ at: ago(30), providers: ["openai"], claude_lookup: "skipped" });
    expect(runners.unknown).toEqual(["claude-code", "anthropic"]);
    const r = assessReadiness(facts({ lastTickAt: ago(30), runners, pendingByProvider: { anthropic: 1 } }));
    expect(r.ready).toBe(true);
  });

  it("the result echoes the facts it used", () => {
    const r = assessReadiness(facts({ daemon: "loaded", lastTickAt: ago(30) }));
    expect(r.ticker).toEqual({ daemon: "loaded", last_tick_at: ago(30), interval_s: 300, recent: true, slept_s: 0, last_exit: null });
    expect(r.runners).toEqual({ source: "unknown", providers: [], unknown: [] });
  });
});

describe("sleep between ticks (fake sleep counters)", () => {
  const BOOT = Date.parse("2026-10-18T16:25:19.000Z");
  const at = (sleptMin: number, woke?: number) => ({ boot_at: BOOT, slept_ms: sleptMin * 60_000, ...(woke ? { woke_at: woke } : {}) });
  // The stored reading carries the time of its tick, as the CLI tick writes it.
  const loaded = (extra: Partial<ReadinessFacts>) => {
    const f = facts({ daemon: "loaded", lastTickAt: ago(21 * 60), platform: "darwin", ...extra });
    if (f.lastTickSleep && !("at" in extra.lastTickSleep!)) f.lastTickSleep = { ...f.lastTickSleep, at: Date.parse(String(f.lastTickAt)) };
    return f;
  };

  it("sleptBetween: same boot gives the counter delta, capped at the wall gap", () => {
    expect(sleptBetween(at(10), at(29), 21 * 60_000)).toBe(19 * 60_000);
    expect(sleptBetween(at(10), at(60), 21 * 60_000)).toBe(21 * 60_000);
  });

  it("sleptBetween: another boot, a counter that went back, or a missing reading counts no sleep", () => {
    expect(sleptBetween({ boot_at: BOOT, slept_ms: 0 }, { boot_at: BOOT + 3_600_000, slept_ms: 600_000 }, 1e7)).toBe(0);
    expect(sleptBetween(at(30), at(10), 1e7)).toBe(0);
    expect(sleptBetween(null, at(10), 1e7)).toBe(0);
    expect(sleptBetween(at(10), undefined, 1e7)).toBe(0);
  });

  it("a 21-minute gap the Mac slept 19 minutes of: ready, with the sleep window as a note", () => {
    const woke = NOW.getTime() - 60_000; // woke one minute ago
    const r = assessReadiness(loaded({ lastTickSleep: at(5), sleepNow: at(24, woke) }));
    expect(r.ready).toBe(true);
    expect(r.ticker).toMatchObject({ recent: true, slept_s: 19 * 60 });
    const from = new Date(woke - 19 * 60_000);
    const hm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    expect(r.notes).toEqual([`the tick daemon paused while the Mac slept (${hm(from)}–${hm(new Date(woke))})`]);
  });

  it("a reading stored by an older tick than last_tick_at (another ticker moved it) explains nothing", () => {
    const stale = { ...at(5), at: Date.parse(ago(60 * 60)) };
    const r = assessReadiness(loaded({ lastTickSleep: stale, sleepNow: at(24) }));
    expect(r.problems.map((p) => p.code)).toEqual(["daemon_stale"]);
    expect(r.ticker.slept_s).toBe(0);
  });

  it("a wake time that does not fit one sleep after the last tick gives the length, not a clock window", () => {
    // Slept 19 of the 21 minutes, but the last wake was 15 minutes ago: several sleeps.
    const r = assessReadiness(loaded({ lastTickSleep: at(5), sleepNow: at(24, NOW.getTime() - 15 * 60_000) }));
    expect(r.notes).toEqual(["the tick daemon paused while the Mac slept (about 19 minutes)"]);
  });

  it("without a wake time the note gives the length; off macOS it says the computer", () => {
    const r = assessReadiness(loaded({ platform: "linux", lastTickSleep: at(5), sleepNow: at(24) }));
    expect(r.notes).toEqual(["the tick daemon paused while the computer slept (about 19 minutes)"]);
  });

  it("awake time past two intervals is still a problem, sleep or not", () => {
    // 41 minutes wall, 19 asleep: 22 awake minutes, over the 15-minute allowance after a sleep.
    expect(codes(loaded({ lastTickAt: ago(41 * 60), lastTickSleep: at(5), sleepNow: at(24) }))).toEqual(["daemon_stale"]);
  });

  it("after a sleep one more interval is allowed (launchd may restart its interval at the wake)", () => {
    // 33 minutes wall, 19 asleep: 14 awake minutes.
    expect(assessReadiness(loaded({ lastTickAt: ago(33 * 60), lastTickSleep: at(5), sleepNow: at(24) })).ready).toBe(true);
    // No sleep: the same 14 minutes are stale.
    expect(codes(loaded({ lastTickAt: ago(14 * 60), lastTickSleep: at(5), sleepNow: at(5) }))).toEqual(["daemon_stale"]);
  });

  it("a sleep under a minute explains nothing", () => {
    expect(codes(loaded({ lastTickAt: ago(11 * 60), lastTickSleep: at(0), sleepNow: at(0.5) }))).toEqual(["daemon_stale"]);
  });

  it("advice by cause: loaded and exit 1 → tick --once with the code; unprobed → install; not loaded → install", () => {
    const failing = assessReadiness(loaded({ daemonLastExit: 1 }));
    expect(failing.line).toBe(
      "Tasks may not run: the tick daemon last ran 21 minutes ago and exited with code 1. Run `tidegap tick --once` and check the error.",
    );
    expect(failing.ticker.last_exit).toBe(1);
    expect(assessReadiness(loaded({ daemonLastExit: 0 })).problems[0]!.fix).toBe("tidegap tick --once");
    expect(assessReadiness(loaded({ daemon: "installed" })).problems[0]!.fix).toBe("tidegap install");
    expect(assessReadiness(loaded({ daemon: "installed_not_loaded" })).problems[0]).toMatchObject({ code: "daemon_not_loaded", fix: "tidegap install" });
  });
});

describe("ledger helpers", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-readiness-"));
    dbPath = join(dir, "queue.db");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes and reads the tick_runners snapshot; garbage reads as none", () => {
    const store = new TaskStore({ dbPath });
    expect(readTickRunners(store)).toBeNull();
    writeTickRunners(store, { at: NOW.toISOString(), providers: ["claude-code"], claude_lookup: "done" });
    expect(readTickRunners(store)).toEqual({ at: NOW.toISOString(), providers: ["claude-code"], claude_lookup: "done" });
    store.setMeta(TICK_RUNNERS_META_KEY, "{not json");
    expect(readTickRunners(store)).toBeNull();
    store.close();
  });

  it("writes and reads the last_tick_sleep reading with its tick time; garbage, no tick time or null reads as none", () => {
    const store = new TaskStore({ dbPath });
    expect(readTickSleep(store)).toBeNull();
    writeTickSleep(store, { boot_at: 1, slept_ms: 2, woke_at: 3 }, NOW);
    expect(readTickSleep(store)).toEqual({ boot_at: 1, slept_ms: 2, at: NOW.getTime() });
    store.setMeta(TICK_SLEEP_META_KEY, JSON.stringify({ boot_at: 1, slept_ms: 2 }));
    expect(readTickSleep(store)).toBeNull();
    store.setMeta(TICK_SLEEP_META_KEY, JSON.stringify({ boot_at: "x" }));
    expect(readTickSleep(store)).toBeNull();
    writeTickSleep(store, { boot_at: 1, slept_ms: 2 }, NOW);
    writeTickSleep(store, null, NOW);
    expect(store.getMeta(TICK_SLEEP_META_KEY)).toBeUndefined();
    store.close();
  });

  it("counts pending provider-call tasks by provider", async () => {
    const s = new Scheduler({ dbPath, feed: mockGridFeed(), signing: false, rng: () => 0 });
    const spec = { type: "provider_call" as const, model: "m", prompt: "p" };
    const deadline = new Date(Date.now() + 6 * 3_600_000);
    await s.enqueueProviderCall({ ...spec, provider: "openai" }, { deadline, region: "DE" });
    await s.enqueueProviderCall({ ...spec, provider: "openai" }, { deadline, region: "DE" });
    const done = await s.enqueueProviderCall({ ...spec, provider: "anthropic" }, { deadline, region: "DE" });
    s.cancelTask(done.taskId);
    const store = new TaskStore({ dbPath });
    expect(pendingProvidersFromStore(store)).toEqual({ openai: 2 });
    store.close();
    s.shutdown();
  });
});
