import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  commandContextFor,
  encodeCallback,
  mockGridFeed,
  parseCallback,
  parseCommand,
  QueueListing,
  runCallback,
  runCommand,
  Scheduler,
  TELEGRAM_CALLBACK_MAX_BYTES,
  TaskStore,
} from "../src/index.js";
import type { CommandContext } from "../src/index.js";

const SPEC = { type: "provider_call" as const, provider: "anthropic" as const, model: "claude-sonnet-4-6", prompt: "Summarize the changelog" };
const H = 3_600_000;

describe("parseCommand", () => {
  it("parses the KTD15 grammar", () => {
    expect(parseCommand("/later 2 tonight")).toEqual({ kind: "later", ref: { n: 2 }, arg: { preset: "tonight" } });
    expect(parseCommand("/later t-abc tomorrow")).toEqual({ kind: "later", ref: { id: "t-abc" }, arg: { preset: "tomorrow_morning" } });
    expect(parseCommand("/later 1 1h")).toEqual({ kind: "later", ref: { n: 1 }, arg: { preset: "1h" } });
    expect(parseCommand("/later 1 reset")).toEqual({ kind: "later", ref: { n: 1 }, arg: { preset: "after_limit_reset" } });
    expect(parseCommand("/later 1 reset 14:05")).toEqual({ kind: "later", ref: { n: 1 }, arg: { preset: "after_limit_reset", resetClock: "14:05" } });
    expect(parseCommand("/later 1 23:30")).toEqual({ kind: "later", ref: { n: 1 }, arg: { clock: "23:30" } });
    expect(parseCommand("/cancel@tidegap_bot 3")).toEqual({ kind: "cancel", ref: { n: 3 } });
    expect(parseCommand("/start 123456")).toEqual({ kind: "pair", code: "123456" });
    expect(parseCommand("/pair 123456")).toEqual({ kind: "pair", code: "123456" });
    expect(parseCommand("/later 1 someday").kind).toBe("invalid");
    expect(parseCommand("hello").kind).toBe("unknown");
  });
});

describe("callback data", () => {
  it("l:<id>:n parses to later tonight", () => {
    expect(parseCallback("l:t-1:n")).toEqual({ action: "later", taskId: "t-1", preset: "tonight" });
    expect(parseCallback("l:t-1")).toEqual({ action: "later", taskId: "t-1" });
    expect(parseCallback("c:t-1")).toEqual({ action: "cancel", taskId: "t-1" });
    expect(parseCallback("c:t-1:n")).toBeNull();
    expect(parseCallback("q:t-1")).toBeNull();
  });

  it("the longest callback, for a series id, fits in 64 bytes", () => {
    const seriesId = "t-0f8fad5b-d9cb-469f-a165-70867728950e~999";
    for (const preset of ["1h", "tonight", "tomorrow_morning", "after_limit_reset"] as const) {
      const data = encodeCallback("later", seriesId, preset);
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(TELEGRAM_CALLBACK_MAX_BYTES);
      expect(parseCallback(data)).toEqual({ action: "later", taskId: seriesId, preset });
    }
  });
});

describe("runCommand and runCallback on a real scheduler", () => {
  let dir: string;
  let scheduler: Scheduler;
  let store: TaskStore;
  let ctx: CommandContext;
  let listing: QueueListing;
  let writes: string[];

  beforeEach(() => {
    // 10:00 local: every task below plans before tonight and tomorrow morning.
    const d = new Date();
    vi.useFakeTimers({ now: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 10, 0, 0), toFake: ["Date"] });
    dir = mkdtempSync(join(tmpdir(), "tidegap-channels-"));
    const dbPath = join(dir, "q.db");
    store = new TaskStore({ dbPath });
    scheduler = new Scheduler({ store, feed: mockGridFeed(), signing: false, eager: false, rng: () => 0 });
    const base = commandContextFor(scheduler, store);
    writes = [];
    ctx = {
      ...base,
      postpone: async (id, t) => (writes.push(`postpone ${id}`), base.postpone(id, t)),
      cancel: (id) => (writes.push(`cancel ${id}`), base.cancel(id)),
      runNow: (id) => (writes.push(`run ${id}`), base.runNow(id)),
    };
    listing = new QueueListing();
  });
  afterEach(() => {
    scheduler.shutdown();
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  async function enqueue(prompt: string, hoursAhead: number) {
    return scheduler.enqueueProviderCall({ ...SPEC, prompt }, { deadline: new Date(Date.now() + hoursAhead * H), region: "DE" });
  }

  it("/later 2 tonight with a listing postpones the second task", async () => {
    await enqueue("First task", 2);
    const second = await enqueue("Second task", 3);
    const [queue] = await runCommand(parseCommand("/queue"), ctx, listing);
    expect(queue!.text).toContain("2. Second task");
    const [reply] = await runCommand(parseCommand("/later 2 tonight"), ctx, listing);
    expect(writes).toEqual([`postpone ${second.taskId}`]);
    expect(reply!.text).toMatch(/^Moved: Second task\. Not before /);
  });

  it("/cancel abc with an unknown id answers no task abc", async () => {
    const [reply] = await runCommand(parseCommand("/cancel abc"), ctx, listing);
    expect(reply!.text).toBe("There is no task abc.");
    expect(writes).toEqual([]);
  });

  it("a number without a /queue asks for /queue and writes nothing", async () => {
    await enqueue("First task", 2);
    const [reply] = await runCommand(parseCommand("/cancel 1"), ctx, listing);
    expect(reply!.text).toMatch(/^Send \/queue first/);
    expect(writes).toEqual([]);
  });

  it("a listing expires after 10 minutes", async () => {
    const t = await enqueue("First task", 2);
    listing.set([t.taskId], new Date(Date.now() - 11 * 60_000));
    const [reply] = await runCommand(parseCommand("/run 1"), ctx, listing);
    expect(reply!.text).toMatch(/^Send \/queue first/);
  });

  it("a Cancel press on a completed task alerts, removes the buttons and writes nothing", async () => {
    const t = await enqueue("Done task", 2);
    store.upsert({ ...store.get(t.taskId)!, status: "completed", result: { text: "ok" } });
    const out = await runCallback(encodeCallback("cancel", t.taskId), ctx);
    expect(out.answer).toEqual({ text: "Done task is already completed.", showAlert: true });
    expect(out.removeButtons).toBe(true);
    expect(writes).toEqual([]);
  });

  it("a Cancel press on a pending task cancels it", async () => {
    const t = await enqueue("Pending task", 2);
    const out = await runCallback(encodeCallback("cancel", t.taskId), ctx);
    expect(store.get(t.taskId)!.status).toBe("cancelled");
    expect(out.removeButtons).toBe(true);
    expect(out.messages[0]!.text).toBe("Cancelled: Pending task.");
  });

  it("Later ▾ opens the preset menu; a preset press moves the task", async () => {
    const t = await enqueue("Movable task", 3);
    const menu = await runCallback(encodeCallback("later", t.taskId), ctx);
    const datas = menu.messages[0]!.buttons!.flat().map((b) => b.data);
    expect(datas).toContain(`l:${t.taskId}:m`);
    expect(writes).toEqual([]);
    const moved = await runCallback(`l:${t.taskId}:m`, ctx);
    expect(moved.answer.text).toBe("Moved");
    expect(writes).toEqual([`postpone ${t.taskId}`]);
  });

  it("/later reset without a known reset asks for the time", async () => {
    const t = await enqueue("Reset task", 3);
    const [reply] = await runCommand(parseCommand(`/later ${t.taskId} reset`), ctx, listing);
    expect(reply!.text).toBe(`needs the reset time: /later ${t.taskId} reset HH:MM (for example /later ${t.taskId} reset 14:05)`);
  });
});
