/** Claude Code spend from local JSONL (U3, KTD8). Fixture logs under a temp home; no real ~/.claude. */

import { cpSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { lineCost, nodeUsageFs, readClaudeSpend, type ClaudeLimitState, type UsageFs } from "../src/usage/index.js";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "usage", "claude-projects");
const NOW = new Date("2026-10-17T12:00:00.000Z");

/** Limit state whose 5-hour window resets 16:30, so the window starts 11:30. */
const known: ClaudeLimitState = {
  status: "ok",
  source: "statusline",
  stale: false,
  five_hour: { pct: 72, resets_at: "2026-10-17T16:30:00.000Z" },
  scoped: [],
};
const unknown: ClaudeLimitState = { status: "unavailable", stale: false, scoped: [] };

function assistant(ts: string, id: string, input: number, output: number): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: ts,
    requestId: `req_${id}`,
    message: { id: `msg_${id}`, model: "claude-sonnet-5", usage: { input_tokens: input, output_tokens: output } },
  });
}

describe("readClaudeSpend", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "tidegap-spend-"));
    cpSync(FIX, join(home, ".claude", "projects"), { recursive: true });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("counts the current 5-hour window once per response, subagents under the parent session", async () => {
    const spend = await readClaudeSpend(known, { now: NOW, home });
    expect(spend.window).toEqual({ start: "2026-10-17T11:30:00.000Z", basis: "five_hour", label: "current 5 h window" });
    // 11:45 response once (its duplicate block skipped), 11:50 subagent, 11:55 unknown model;
    // not the 11:00 line before the window, the user line or the <synthetic> reply.
    expect(spend.total).toEqual({
      input: 1_000_000 + 100 + 10,
      output: 1_000_000 + 200 + 20,
      cache_write: 1_000_000,
      cache_read: 1_000_000,
      cost_usd: 14.7022,
    });
    expect(spend.sessions.map((s) => [s.session_id, s.project, s.last_activity, s.cost_usd])).toEqual([
      ["sess-b1", "-proj-b", "2026-10-17T11:55:00.000Z", null],
      ["sess-a1", "-proj-a", "2026-10-17T11:50:00.000Z", 14.7022],
    ]);
    expect(spend.by_model.map((m) => [m.model, m.output, m.cost_usd])).toEqual([
      ["claude-sonnet-5", 1_000_200, 14.7022],
      ["claude-mystery-9", 20, null],
    ]);
    expect(spend.unpriced_models).toEqual(["claude-mystery-9"]);
    expect(spend.note).toBe("API list-price estimate, not billed");
  });

  it("list price: 1 M each of input, output, 5-min cache write and cache read on claude-sonnet-5 is 14.7 USD", () => {
    const m = 1_000_000;
    const { cost } = lineCost("claude-sonnet-5", {
      input_tokens: m,
      output_tokens: m,
      cache_creation_input_tokens: m,
      cache_read_input_tokens: m,
    });
    expect(cost).toBeCloseTo(2 + 10 + 2.5 + 0.2, 9);
    // A 1-hour cache write costs 2x input.
    expect(
      lineCost("claude-sonnet-5", { cache_creation_input_tokens: m, cache_creation: { ephemeral_1h_input_tokens: m } }).cost,
    ).toBeCloseTo(4, 9);
    expect(lineCost("claude-mystery-9", { input_tokens: m }).cost).toBeNull();
  });

  it("no limit state: the last 5 hours, labeled trailing 5 h", async () => {
    const spend = await readClaudeSpend(unknown, { now: NOW, home });
    expect(spend.window).toEqual({ start: "2026-10-17T07:00:00.000Z", basis: "trailing_5h", label: "trailing 5 h" });
    // The 11:00 line now counts.
    expect(spend.total.input).toBe(1_000_000 + 100 + 10 + 1000);
  });

  it("CLAUDE_CONFIG_DIR set: only its projects are scanned", async () => {
    const other = join(home, "other");
    mkdirSync(join(other, "projects", "-proj-c"), { recursive: true });
    writeFileSync(join(other, "projects", "-proj-c", "sess-c.jsonl"), `${assistant("2026-10-17T11:59:00.000Z", "c", 7, 8)}\n`);
    const spend = await readClaudeSpend(known, { now: NOW, home, claudeConfigDir: other });
    expect(spend.total).toMatchObject({ input: 7, output: 8 });
    expect(spend.sessions.map((s) => s.session_id)).toEqual(["sess-c"]);
  });

  it("a log not touched since the window start is not opened", async () => {
    const old = join(home, ".claude", "projects", "-proj-b", "sess-b1.jsonl");
    const before = new Date("2026-10-17T11:00:00.000Z");
    utimesSync(old, before, before);
    const opened: string[] = [];
    const fs: UsageFs = { ...nodeUsageFs, readAt: (p, o, l) => (opened.push(p), nodeUsageFs.readAt(p, o, l)) };
    const spend = await readClaudeSpend(known, { now: NOW, home, fs });
    expect(opened).not.toContain(old);
    expect(spend.sessions.map((s) => s.session_id)).toEqual(["sess-a1"]);
  });

  it("lists the five most recent sessions, newest first", async () => {
    const dir = join(home, ".claude", "projects", "-proj-many");
    mkdirSync(dir);
    for (let i = 0; i < 7; i++) {
      writeFileSync(join(dir, `s${i}.jsonl`), `${assistant(`2026-10-17T11:4${i}:00.000Z`, `m${i}`, 1, 1)}\n`);
    }
    const spend = await readClaudeSpend(known, { now: NOW, home });
    expect(spend.sessions.map((s) => s.session_id)).toEqual(["sess-b1", "sess-a1", "s6", "s5", "s4"]);
  });

  it("a long log: lines before the window are skipped, every line in it counts", async () => {
    const dir = join(home, ".claude", "projects", "-proj-long");
    mkdirSync(dir);
    const filler = `{"type":"user","timestamp":"2026-10-17T08:00:00.000Z","message":{"content":"${"x".repeat(2000)}"}}`;
    const lines = [assistant("2026-10-17T08:00:00.000Z", "early", 5000, 5000)];
    for (let i = 0; i < 3000; i++) lines.push(filler);
    lines.push(assistant("2026-10-17T11:31:00.000Z", "late1", 3, 4), filler, assistant("2026-10-17T11:32:00.000Z", "late2", 5, 6));
    writeFileSync(join(dir, "long.jsonl"), `${lines.join("\n")}\n`);
    const spend = await readClaudeSpend(known, { now: NOW, home });
    expect(spend.sessions.find((s) => s.session_id === "long")).toMatchObject({ input: 8, output: 10 });
  });
});
