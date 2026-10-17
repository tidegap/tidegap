/**
 * CLI readiness gatherer (coherence U2): live daemon probe through an
 * injected exec, the ledger facts, and the runner fact from a fresh
 * `tick_runners` snapshot or, without one, the `claude` lookup and keys.
 * No real `launchctl` or `systemctl` runs; HOME is a temp dir.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LAST_TICK_META_KEY, mockGridFeed, Scheduler, TaskStore, writeTickRunners } from "@tidegap/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { gatherReadiness, type ProbeExec, type ReadinessCreds } from "../src/readiness.js";

const NOW = new Date("2026-10-20T12:00:00.000Z");
const NO_KEYS: ReadinessCreds = { claudeCodeDisabled: false };

let home: string;
let dbPath: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tidegap-readiness-cli-"));
  dbPath = join(home, "queue.db");
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function plist(): void {
  const dir = join(home, "Library", "LaunchAgents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "com.tidegap.tick.plist"), "<plist/>");
}

function exec(status: number | null, calls: string[][] = []): ProbeExec {
  return (cmd, args) => {
    calls.push([cmd, ...args]);
    return { status };
  };
}

async function enqueue(provider: "anthropic" | "openai"): Promise<void> {
  const s = new Scheduler({ dbPath, feed: mockGridFeed(), signing: false, rng: () => 0 });
  await s.enqueueProviderCall(
    { type: "provider_call", provider, model: "m", prompt: "p" },
    { deadline: new Date(Date.now() + 6 * 3_600_000), region: "DE" },
  );
  s.shutdown();
}

function meta(set: (store: TaskStore) => void): void {
  const store = new TaskStore({ dbPath });
  set(store);
  store.close();
}

const NO_CLAUDE = { path: "", isExecutable: () => false, loginShell: () => undefined };
const opts = (extra: Record<string, unknown> = {}) => ({ home, dbPath, now: NOW, creds: NO_KEYS, claudeLookup: NO_CLAUDE, ...extra });

describe("gatherReadiness", () => {
  it("macOS, plist present, launchctl print exits 0 → loaded", () => {
    plist();
    const calls: string[][] = [];
    const r = gatherReadiness(opts({ platform: "darwin", exec: exec(0, calls), uid: 501 }));
    expect(r.ticker.daemon).toBe("loaded");
    expect(calls).toEqual([["launchctl", "print", "gui/501/com.tidegap.tick"]]);
    expect(r.ready).toBe(true);
  });

  it("macOS, plist present, launchctl print exits 113 → installed_not_loaded", () => {
    plist();
    const r = gatherReadiness(opts({ platform: "darwin", exec: exec(113), uid: 501 }));
    expect(r.ticker.daemon).toBe("installed_not_loaded");
    expect(r.problems.map((p) => p.code)).toEqual(["daemon_not_loaded"]);
  });

  it("linux probes the user timer", () => {
    const dir = join(home, ".config", "systemd", "user");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "tidegap-tick.timer"), "");
    const calls: string[][] = [];
    const r = gatherReadiness(opts({ platform: "linux", exec: exec(3, calls) }));
    expect(calls).toEqual([["systemctl", "--user", "is-active", "tidegap-tick.timer"]]);
    expect(r.ticker.daemon).toBe("installed_not_loaded");
  });

  it("windows → daemon unknown and no probe", () => {
    const calls: string[][] = [];
    const r = gatherReadiness(opts({ platform: "win32", exec: exec(0, calls) }));
    expect(r.ticker.daemon).toBe("unknown");
    expect(calls).toEqual([]);
  });

  it("no ledger file → no SQLite error, no_daemon only, and no file is created", () => {
    const r = gatherReadiness(opts({ platform: "darwin", exec: exec(0) }));
    expect(r.problems.map((p) => p.code)).toEqual(["no_daemon"]);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("no snapshot, fake claude found, no keys, pending anthropic task → no no_runner", async () => {
    await enqueue("anthropic");
    const fake = join(home, "bin", "claude");
    const r = gatherReadiness(
      opts({ platform: "linux", exec: exec(0), claudeLookup: { ...NO_CLAUDE, path: join(home, "bin"), isExecutable: (p: string) => p === fake } }),
    );
    expect(r.runners).toEqual({ source: "probe", providers: ["claude-code", "anthropic"], unknown: [] });
    expect(r.problems.map((p) => p.code)).not.toContain("no_runner");
  });

  it("a fresh snapshot without openai wins over an exported OPENAI_API_KEY", async () => {
    await enqueue("openai");
    meta((s) => {
      s.setMeta(LAST_TICK_META_KEY, new Date(NOW.getTime() - 30_000).toISOString());
      writeTickRunners(s, { at: new Date(NOW.getTime() - 30_000).toISOString(), providers: ["claude-code", "anthropic"], claude_lookup: "done" });
    });
    const r = gatherReadiness(opts({ platform: "linux", exec: exec(0), creds: { ...NO_KEYS, openaiApiKey: "sk-test" } }));
    expect(r.runners.source).toBe("snapshot");
    expect(r.problems.map((p) => [p.code, p.provider])).toEqual([["no_runner", "openai"]]);
  });

  it("an old snapshot is ignored: the probe sees the key", async () => {
    await enqueue("openai");
    meta((s) => writeTickRunners(s, { at: "2026-10-19T00:00:00.000Z", providers: [], claude_lookup: "done" }));
    const r = gatherReadiness(opts({ platform: "linux", exec: exec(0), creds: { ...NO_KEYS, openaiApiKey: "sk-test" } }));
    expect(r.runners.source).toBe("probe");
    expect(r.problems.map((p) => p.code)).not.toContain("no_runner");
  });

  it("a key in the env file counts as present", async () => {
    await enqueue("openai");
    const envFile = join(home, "env");
    writeFileSync(envFile, "OPENAI_API_KEY=sk-file\n");
    const r = gatherReadiness(opts({ platform: "linux", exec: exec(0), envFile }));
    expect(r.runners.providers).toContain("openai");
  });

  it("no binary, no keys, pending anthropic task → no_runner for anthropic", async () => {
    await enqueue("anthropic");
    const r = gatherReadiness(opts({ platform: "linux", exec: exec(0) }));
    expect(r.problems.map((p) => [p.code, p.provider])).toEqual([
      ["no_daemon", undefined],
      ["no_runner", "anthropic"],
    ]);
  });

  it("two calls within 30 s spawn the probe once; after 30 s it probes again", () => {
    plist();
    const calls: string[][] = [];
    const probe = exec(0, calls);
    gatherReadiness(opts({ platform: "darwin", exec: probe, uid: 501 }));
    gatherReadiness(opts({ platform: "darwin", exec: probe, uid: 501, now: new Date(NOW.getTime() + 20_000) }));
    expect(calls).toHaveLength(1);
    gatherReadiness(opts({ platform: "darwin", exec: probe, uid: 501, now: new Date(NOW.getTime() + 31_000) }));
    expect(calls).toHaveLength(2);
  });
});
