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
  runnersFromSnapshot,
  Scheduler,
  mockGridFeed,
  TaskStore,
  TICK_RUNNERS_META_KEY,
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
    expect(assessReadiness(facts({ daemon: "loaded", lastTickAt: ago(11 * 60) })).problems[0]!.message).toMatch(
      /may have slept/,
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
    expect(r.ticker).toEqual({ daemon: "loaded", last_tick_at: ago(30), interval_s: 300, recent: true });
    expect(r.runners).toEqual({ source: "unknown", providers: [], unknown: [] });
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
