/** Codex limits and tokens from local rollout logs (U3, KTD9). Fixture home; no real ~/.codex. */

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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

  it("limits come from the most recently modified file, not the newest-dated path", async () => {
    // A session started on 05-22 but last written before the 05-21 session's last reading.
    const later = join(root, "sessions", "2026", "05", "22");
    mkdirSync(later, { recursive: true });
    const text = readFileSync(join(root, DAY, `rollout-2026-05-21T17-50-53-${A}.jsonl`), "utf8").replaceAll('"used_percent":33', '"used_percent":5');
    const c = join(later, "rollout-2026-05-22T08-00-00-019e4e00-0000-7000-8000-000000000002.jsonl");
    writeFileSync(c, text);
    utimesSync(c, new Date("2026-05-21T20:00:00.000Z"), new Date("2026-05-21T20:00:00.000Z"));
    const a = join(root, DAY, `rollout-2026-05-21T17-50-53-${A}.jsonl`);
    utimesSync(a, new Date("2026-05-21T21:51:02.000Z"), new Date("2026-05-21T21:51:02.000Z"));
    const out = await readCodexUsage({ now: SOON, codexHome: root });
    expect(out.five_hour?.pct).toBe(33);
  });
});

describe("readCodexUsage on a large rollout file", () => {
  it("reads only the last 32 MiB and takes the last reading there", async () => {
    const event = (ts: string, pct: number) =>
      JSON.stringify({ timestamp: ts, type: "event_msg", payload: { type: "token_count", info: null, rate_limits: { plan_type: "plus", primary: { used_percent: pct, resets_at: 1779415292, window_minutes: 300 } } } });
    const filler = `${JSON.stringify({ type: "response_item", payload: { text: "x".repeat(1000) } })}\n`;
    const body = Buffer.from(
      `${event("2026-05-21T10:00:00.000Z", 1)}\n${filler.repeat(34 * 1024)}${event("2026-05-21T21:00:00.000Z", 44)}\n`,
    );
    const dir = join("/codex", "sessions", "2026", "05", "21");
    const file = join(dir, "rollout-2026-05-21T10-00-00-019e4f00-0000-7000-8000-000000000003.jsonl");
    const reads: number[] = [];
    const fs: UsageFs = {
      readdir: (p) =>
        ({ "/codex/sessions": ["2026"], "/codex/sessions/2026": ["05"], "/codex/sessions/2026/05": ["21"] })[p] ??
        (p === dir ? [file.slice(dir.length + 1)] : []),
      stat: (p) => (p === file ? { mtimeMs: 1, size: body.length, dir: false } : p.startsWith("/codex") ? { mtimeMs: 1, size: 0, dir: true } : undefined),
      readAt: (_p, o, l) => (reads.push(o), body.subarray(o, o + l)),
    };
    const out = await readCodexUsage({ now: SOON, codexHome: "/codex", fs });
    expect(out.five_hour?.pct).toBe(44);
    expect(Math.min(...reads)).toBe(body.length - 32 * 1024 * 1024);
  });
});
