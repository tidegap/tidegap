/** Codex limits and tokens from local rollout logs (U3, KTD9). Fixture home; no real ~/.codex. */

import { cpSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { nodeUsageFs, readCodexUsage, type UsageFs } from "../src/usage/index.js";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "usage", "codex-home");
const DAY = join("sessions", "2026", "05", "21");
const A = "019e4c85-1e85-7813-bc53-1bfb7533f35a";
const B = "019e4d00-0000-7000-8000-000000000001";
/** 9 minutes after the last limit reading, inside its 5-hour window. */
const SOON = new Date("2026-05-21T22:00:00.000Z");

describe("readCodexUsage", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tidegap-codex-"));
    cpSync(FIX, root, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("the newest file with a reading wins, and in it the last non-null rate_limits", async () => {
    // The newest file (21:55) has only rate_limits: null; the older one ends with a null event too.
    const out = await readCodexUsage({ now: SOON, codexHome: root });
    expect(out).toEqual({
      status: "ok",
      as_of: "2026-05-21T21:51:01.471Z",
      plan_type: "plus",
      five_hour: { pct: 33, resets_at: "2026-05-22T02:01:32.000Z", window_minutes: 300 },
      seven_day: { pct: 43, resets_at: new Date(1779836455 * 1000).toISOString(), window_minutes: 10080 },
    });
  });

  it("a newest file 150 days old still gives limits; passed windows read reset_since_seen", async () => {
    const out = await readCodexUsage({ now: new Date("2026-10-18T21:51:01.471Z"), codexHome: root });
    expect(out.as_of).toBe("2026-05-21T21:51:01.471Z");
    expect(out.five_hour).toEqual({ pct: null, resets_at: "2026-05-22T02:01:32.000Z", window_minutes: 300, state: "reset_since_seen" });
    expect(out.seven_day?.state).toBe("reset_since_seen");
  });

  it("no sessions directory: not_found, no throw", async () => {
    expect(await readCodexUsage({ codexHome: join(root, "missing") })).toEqual({ status: "not_found" });
    expect(await readCodexUsage({ home: join(root, "nohome") })).toEqual({ status: "not_found" });
  });

  it("~/.codex is the default root", async () => {
    const home = mkdtempSync(join(tmpdir(), "tidegap-codex-home-"));
    cpSync(FIX, join(home, ".codex"), { recursive: true });
    expect((await readCodexUsage({ now: SOON, home })).status).toBe("ok");
    rmSync(home, { recursive: true, force: true });
  });

  it("with spend: the last total of each file active in the 5-hour window, newest first", async () => {
    const t = (iso: string) => new Date(iso);
    utimesSync(join(root, DAY, `rollout-2026-05-21T17-50-53-${A}.jsonl`), t("2026-05-21T21:52:00Z"), t("2026-05-21T21:52:00Z"));
    utimesSync(join(root, DAY, `rollout-2026-05-21T21-55-00-${B}.jsonl`), t("2026-05-21T21:58:00Z"), t("2026-05-21T21:58:00Z"));
    const out = await readCodexUsage({ now: SOON, codexHome: root, spend: true });
    expect(out.sessions).toEqual([
      {
        session_id: B,
        last_activity: "2026-05-21T21:58:00.000Z",
        tokens: { input: 500, cached_input: 100, output: 90, reasoning_output: 10, total: 600 },
      },
      {
        session_id: A,
        last_activity: "2026-05-21T21:52:00.000Z",
        tokens: { input: 28978, cached_input: 6528, output: 129, reasoning_output: 39, total: 29107 },
      },
    ]);
  });

  it("never opens auth.json", async () => {
    const touched: string[] = [];
    const spy: UsageFs = {
      readdir: (p) => (touched.push(p), nodeUsageFs.readdir(p)),
      stat: (p) => (touched.push(p), nodeUsageFs.stat(p)),
      readAt: (p, o, l) => (touched.push(p), nodeUsageFs.readAt(p, o, l)),
    };
    await readCodexUsage({ now: SOON, codexHome: root, fs: spy, spend: true });
    expect(touched.length).toBeGreaterThan(0);
    expect(touched.filter((p) => p.endsWith("auth.json"))).toEqual([]);
    expect(touched.every((p) => p.startsWith(join(root, "sessions")))).toBe(true);
  });
});
