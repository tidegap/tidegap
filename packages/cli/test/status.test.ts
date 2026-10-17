/**
 * `tidegap status` (coherence U4): the readiness lines and exit code over a
 * temp HOME and ledger. No real `launchctl` or `systemctl` runs.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LAST_TICK_META_KEY, TaskStore, writeTickRunners } from "@tidegap/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runStatus } from "../src/commands/status.js";

const NOW = new Date("2026-10-20T12:00:00.000Z");

let home: string;
let dbPath: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tidegap-status-"));
  dbPath = join(home, ".tidegap", "queue.db");
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const opts = (extra: Record<string, unknown> = {}) => ({
  home,
  db: dbPath,
  now: NOW,
  platform: "darwin" as const,
  exec: () => ({ status: null }),
  creds: { claudeCodeDisabled: false },
  claudeLookup: { path: "", isExecutable: () => false, loginShell: () => undefined },
  ...extra,
});

describe("tidegap status", () => {
  it("in a clean home exits 1, names tidegap install, and creates no ledger", () => {
    const res = runStatus(opts());
    expect(res.exitCode).toBe(1);
    expect(res.rendered).toContain("Daemon:     not installed");
    expect(res.rendered).toContain("Last tick:  never");
    expect(res.rendered).toContain("Tasks will not run: no tick daemon. Run `tidegap install`.");
    expect(existsSync(dbPath)).toBe(false);
  });

  it("with a fresh tick and runner snapshot exits 0 and says tasks will run", () => {
    const store = new TaskStore({ dbPath: join(home, "q.db") });
    store.setMeta(LAST_TICK_META_KEY, new Date(NOW.getTime() - 30_000).toISOString());
    writeTickRunners(store, { at: new Date(NOW.getTime() - 30_000).toISOString(), providers: ["anthropic", "claude-code"], claude_lookup: "done" });
    store.close();
    const res = runStatus(opts({ db: join(home, "q.db") }));
    expect(res.exitCode).toBe(0);
    expect(res.rendered).toContain("Runners:    anthropic, claude-code (from the last tick)");
    expect(res.rendered).toContain("Tasks will run.");
  });

  it("--json prints the readiness object", () => {
    const res = runStatus(opts({ json: true }));
    const parsed = JSON.parse(res.rendered) as Record<string, unknown>;
    expect(parsed).toHaveProperty("ready", false);
    expect(parsed).toHaveProperty("problems");
    expect(parsed).toHaveProperty("line");
  });
});
