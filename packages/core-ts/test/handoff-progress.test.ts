/**
 * Progress events of a long run: the core caps of `createProgressRecorder`
 * (a quiet first 5 s, one event per 15 s, 24 per task, 200-character lines
 * without control characters) and the scheduler's `onProgress` callback,
 * which writes them as `progress` events while the run lasts.
 */

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createProgressRecorder,
  mockGridFeed,
  PROGRESS_LINE_MAX_CHARS,
  PROGRESS_MAX_EVENTS,
  progressLine,
  Scheduler,
} from "../src/index.js";
import type { DispatchOptions, ProviderAdapter } from "../src/index.js";

const T0 = Date.parse("2026-11-01T10:00:00.000Z");

/** A recorder whose writes land in `writes` with the fake clock's offset from T0 in seconds. */
function recording(existing?: () => number) {
  const writes: Array<{ at: number; line: string; seq: number }> = [];
  const rec = createProgressRecorder((d) => writes.push({ at: (Date.now() - T0) / 1000, ...d }), existing ? { existing } : {});
  return { rec, writes };
}

/** `count` lines, one per second from the current fake time, then `close`. */
function linePerSecond(rec: { onLine(l: string): void; close(): void }, count: number): void {
  for (let i = 0; i < count; i++) {
    rec.onLine(`line ${i}`);
    vi.advanceTimersByTime(1000);
  }
  rec.close();
}

describe("progress caps", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a run that ends within 5 s writes no progress event", () => {
    const { rec, writes } = recording();
    for (let i = 0; i < 5; i++) {
      rec.onLine(`line ${i}`);
      vi.advanceTimersByTime(900);
    }
    rec.close();
    vi.advanceTimersByTime(60_000);
    expect(writes).toEqual([]);
  });

  it("a 40 s run that prints a line per second writes at most 3 progress events, 15 s apart", () => {
    const { rec, writes } = recording();
    linePerSecond(rec, 40);
    vi.advanceTimersByTime(60_000);
    expect(writes.map((w) => w.at)).toEqual([5, 20, 35]);
    // Each event shows the newest line when its slot opened.
    expect(writes).toEqual([
      { at: 5, line: "line 4", seq: 1 },
      { at: 20, line: "line 19", seq: 2 },
      { at: 35, line: "line 34", seq: 3 },
    ]);
  });

  it("a line that waits for its slot is written when the slot opens, and dropped when the run ends first", () => {
    const { rec, writes } = recording();
    rec.onLine("starting");
    vi.advanceTimersByTime(5_000);
    expect(writes).toEqual([{ at: 5, line: "starting", seq: 1 }]);
    vi.advanceTimersByTime(1_000);
    rec.onLine("half way");
    vi.advanceTimersByTime(10_000);
    rec.close();
    vi.advanceTimersByTime(60_000);
    expect(writes).toHaveLength(1);
  });

  it("a task never gets more than 24 progress events", () => {
    const { rec, writes } = recording();
    linePerSecond(rec, 600);
    expect(writes).toHaveLength(PROGRESS_MAX_EVENTS);
    expect(writes.map((w) => w.seq)).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
    // Events a run already wrote for this task count: a second run of it gets the rest.
    const again = recording(() => 20);
    linePerSecond(again.rec, 600);
    expect(again.writes.map((w) => w.seq)).toEqual([21, 22, 23, 24]);
  });

  it("a line longer than 200 characters is cut; control characters are removed", () => {
    expect(progressLine("a".repeat(250))).toBe("a".repeat(PROGRESS_LINE_MAX_CHARS));
    expect(progressLine("step\u0007 1\u001b[31m done\r")).toBe("step 1 done");
    // Terminal escapes go whole; line separators become spaces; bidirectional controls go.
    expect(progressLine("\u001b[31mred\u001b[0m done \u001b]0;title\u0007ok")).toBe("red done ok");
    expect(progressLine("a\u2028b\u2029c")).toBe("a b c");
    expect(progressLine("abc\u202edcb\u2066x\u2069")).toBe("abcdcbx");
    expect(progressLine("\u001b[0m")).toBeUndefined();
    // A huge line is read only from its start.
    expect(progressLine("z".repeat(5_000_000))).toBe("z".repeat(PROGRESS_LINE_MAX_CHARS));
    expect(progressLine("tab\tseparated")).toBe("tab separated");
    // A cut never splits a character made of two UTF-16 units.
    expect(Array.from(progressLine(`${"x".repeat(199)}😀😀`)!)).toHaveLength(200);
    expect(progressLine("   \u001b ")).toBeUndefined();
    const { rec, writes } = recording();
    vi.advanceTimersByTime(6_000);
    rec.onLine(`${"b".repeat(300)}\u0000`);
    rec.onLine("   ");
    rec.close();
    expect(writes).toEqual([{ at: 6, line: "b".repeat(200), seq: 1 }]);
  });

  it("a write that throws costs its line, not the recorder", () => {
    let calls = 0;
    const rec = createProgressRecorder(() => {
      calls++;
      throw new Error("database is locked");
    });
    vi.advanceTimersByTime(6_000);
    expect(() => rec.onLine("one")).not.toThrow();
    vi.advanceTimersByTime(15_000);
    expect(() => rec.onLine("two")).not.toThrow();
    rec.close();
    expect(calls).toBe(2);
  });
});

describe("progress events through the scheduler", () => {
  let dir: string;
  let s: Scheduler;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "tidegap-progress-")));
    s = new Scheduler({ dbPath: join(dir, "queue.db"), feed: mockGridFeed(), signing: false, rng: () => 0, defaultRegion: "DE" });
  });
  afterEach(() => {
    vi.useRealTimers();
    s.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  /** An adapter that reports `lines` one per fake second through `onProgress`, then answers. */
  function printing(lines: number) {
    const seen: DispatchOptions[] = [];
    const adapter: ProviderAdapter = {
      provider: "anthropic",
      ready: true,
      async dispatch(model, _prompt, options = {}) {
        seen.push(options);
        for (let i = 0; i < lines; i++) {
          options.onProgress?.(`step ${i}`);
          await vi.advanceTimersByTimeAsync(1000);
        }
        return { text: "done", model, provider: "anthropic", raw: null };
      },
    };
    return { adapter, seen };
  }

  async function runOne(lines: number) {
    const rec = await s.enqueueProviderCall(
      { type: "provider_call", provider: "anthropic", model: "claude-sonnet-5", prompt: "x" },
      { deadline: new Date(Date.now() + 3_600_000) },
    );
    s.runNow(rec.taskId);
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const { adapter, seen } = printing(lines);
    await s.tick({ anthropic: adapter });
    // A slot that would open after the run never writes.
    await vi.advanceTimersByTimeAsync(60_000);
    vi.useRealTimers();
    return { taskId: rec.taskId, seen, events: s.listTaskEvents(rec.taskId) };
  }

  it("a 20 s run writes capped progress events (actor tick, line and seq) between dispatched and completed", async () => {
    const { seen, events } = await runOne(20);
    expect(typeof seen[0]!.onProgress).toBe("function");
    const progress = events.filter((e) => e.kind === "progress");
    expect(progress.map((e) => ({ actor: e.actor, details: e.details }))).toEqual([
      { actor: "tick", details: { line: "step 4", seq: 1 } },
      { actor: "tick", details: { line: "step 19", seq: 2 } },
    ]);
    const kinds = events.map((e) => e.kind);
    expect(kinds.indexOf("dispatched")).toBeLessThan(kinds.indexOf("progress"));
    expect(kinds.lastIndexOf("progress")).toBeLessThan(kinds.indexOf("completed"));
  });

  it("a busy ledger costs the line, not the tick: each write waits at most 100 ms, one warning, later lines are stored", async () => {
    const rec = await s.enqueueProviderCall(
      { type: "provider_call", provider: "anthropic", model: "claude-sonnet-5", prompt: "x" },
      { deadline: new Date(Date.now() + 3_600_000) },
    );
    s.runNow(rec.taskId);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const req = createRequire(import.meta.url);
    type Raw = { prepare(sql: string): { run(): unknown }; close(): void };
    let lockDb: Raw;
    try {
      const { DatabaseSync } = req("node:sqlite") as { DatabaseSync: new (p: string) => Raw };
      lockDb = new DatabaseSync(join(dir, "queue.db"));
    } catch {
      lockDb = new (req("better-sqlite3") as new (p: string) => Raw)(join(dir, "queue.db"));
    }
    let lockedWallMs = 0;
    let warnings: unknown[][] = [];
    const adapter: ProviderAdapter = {
      provider: "anthropic",
      ready: true,
      async dispatch(model, _prompt, options = {}) {
        // Another connection holds the write lock for the first 35 fake seconds.
        lockDb.prepare("BEGIN IMMEDIATE").run();
        const t0 = performance.now();
        for (let i = 0; i < 35; i++) {
          options.onProgress?.(`busy ${i}`);
          await vi.advanceTimersByTimeAsync(1000);
        }
        lockedWallMs = performance.now() - t0;
        lockDb.prepare("COMMIT").run();
        for (let i = 0; i < 20; i++) {
          options.onProgress?.(`free ${i}`);
          await vi.advanceTimersByTimeAsync(1000);
        }
        return { text: "done", model, provider: "anthropic", raw: null };
      },
    };
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      await s.tick({ anthropic: adapter });
      await vi.advanceTimersByTimeAsync(60_000);
    } finally {
      vi.useRealTimers();
      lockDb.close();
      warnings = warn.mock.calls.filter((c) => String(c[0]).includes("could not record a progress event"));
      warn.mockRestore();
    }
    // Three slots (5 s, 20 s, 35 s) hit the lock; at 5 s each they would take 15 s of the tick's time.
    expect(lockedWallMs).toBeLessThan(2_000);
    const progress = s.listTaskEvents(rec.taskId).filter((e) => e.kind === "progress");
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.every((e) => String(e.details.line).startsWith("free "))).toBe(true);
    expect(s.listTaskEvents(rec.taskId).map((e) => e.kind)).toContain("completed");
    expect(warnings).toHaveLength(1);
  });

  it("a fast run writes no progress event, so its event list is as before", async () => {
    const { events } = await runOne(3);
    expect(events.map((e) => e.kind)).toEqual(["created", "expedited", "dispatched", "completed"]);
  });
});
