/**
 * Coherence U7 through the REAL MCP handlers: postpone_task (Later),
 * schedule_task not_before, and the readiness line in the schedule reply.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LAST_TICK_META_KEY, LIMIT_RESET_HINT_META_KEY, mockGridFeed, TaskStore, writeTickRunners } from "@tidegap/core";
import { writeUsageCache } from "@tidegap/cli/usage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEbbServer } from "../src/server.js";

type TextResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

const H = 3_600_000;
let dir: string;
let dbPath: string;
const closers: Array<() => Promise<void>> = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tidegap-mcp-later-"));
  dbPath = join(dir, "queue.db");
});
afterEach(async () => {
  while (closers.length) await closers.pop()!();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

/** Local 14:00 two days ahead: "tonight" is 22:00 the same day. */
function afternoon(): Date {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 2, 14, 0, 0, 0);
}

async function connect() {
  const built = createEbbServer({
    feed: mockGridFeed(),
    dbPath,
    usage: { cachePath: join(dir, "usage.json"), configPath: join(dir, "config"), env: {} },
  });
  const client = new Client({ name: "later-test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([built.server.connect(a), client.connect(b)]);
  closers.push(async () => {
    await client.close();
    built.scheduler.shutdown();
  });
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as TextResult;
  return { ...built, call };
}

const text = (r: TextResult) => r.content.map((c) => c.text).join("\n");
const taskId = (r: TextResult) => /task_id: (\S+)/.exec(text(r))![1]!;

function row(id: string) {
  const store = new TaskStore({ dbPath });
  try {
    return { rec: store.get(id)!, hint: store.getMeta(LIMIT_RESET_HINT_META_KEY) };
  } finally {
    store.close();
  }
}

async function queued(call: Awaited<ReturnType<typeof connect>>["call"], hours = 6): Promise<string> {
  const now = Date.now();
  const r = await call("schedule_task", {
    prompt: "summarise the week",
    deadline: new Date(now + hours * H).toISOString(),
    region: "GB",
  });
  expect(r.isError, text(r)).toBeFalsy();
  return taskId(r);
}

describe("postpone_task", () => {
  it("preset tonight writes not_before 22:00 local and names the window", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: afternoon() });
    const { call } = await connect();
    const id = await queued(call);
    const r = await call("postpone_task", { task_id: id, preset: "tonight" });
    expect(r.isError, text(r)).toBeFalsy();
    expect(text(r)).toMatch(/not_before: \S+ \(22:00 local\)/);
    expect(text(r)).toMatch(/deadline: \S+ \(\d{4}-\d{2}-\d{2} 06:00 local\)/);
    const nb = new Date(row(id).rec.notBefore!);
    expect([nb.getHours(), nb.getMinutes()]).toEqual([22, 0]);
  });

  it("refuses an earlier target and names the planned time", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: afternoon() });
    const { call } = await connect();
    const id = await queued(call);
    await call("postpone_task", { task_id: id, preset: "tonight" });
    const before = row(id).rec.notBefore;
    const r = await call("postpone_task", { task_id: id, until: new Date(Date.now() + 2 * H).toISOString() });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^postpone_task rejected: .*already planned for (\d{4}-\d{2}-\d{2} )?\d{2}:\d{2}$/);
    expect(row(id).rec.notBefore).toBe(before);
  });

  it("after_limit_reset with reset_at stores the hint; a second task then needs no reset_at", async () => {
    const { call } = await connect();
    const first = await queued(call);
    const second = await queued(call);
    const missing = await call("postpone_task", { task_id: second, preset: "after_limit_reset" });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toMatch(/needs the reset time/);

    const reset = new Date(Date.now() + 7 * H);
    const r = await call("postpone_task", { task_id: first, preset: "after_limit_reset", reset_at: reset.toISOString() });
    expect(r.isError, text(r)).toBeFalsy();
    const stored = row(first);
    expect(Date.parse(stored.rec.notBefore!)).toBe(reset.getTime() + 5 * 60_000);
    expect(JSON.parse(stored.hint!).at).toBe(reset.toISOString());

    const again = await call("postpone_task", { task_id: second, preset: "after_limit_reset" });
    expect(again.isError).toBeFalsy();
    expect(Date.parse(row(second).rec.notBefore!)).toBe(reset.getTime() + 5 * 60_000);
  });

  it("after_limit_reset without reset_at uses this machine's limit reading", async () => {
    const reset = new Date(Date.now() + 7 * H);
    writeUsageCache(
      {
        version: 1,
        claude: {
          statusline: {
            fetched_at: new Date().toISOString(),
            data: {
              five_hour: { pct: 100, resets_at: reset.toISOString() },
              // later than the task's planned start (deadline +6 h)
              seven_day: { pct: 40, resets_at: new Date(Date.now() + 72 * H).toISOString() },
              scoped: [],
            },
          },
        },
      },
      join(dir, "usage.json"),
    );
    const { call } = await connect();
    const id = await queued(call);
    const r = await call("postpone_task", { task_id: id, preset: "after_limit_reset" });
    expect(r.isError, text(r)).toBeFalsy();
    expect(Date.parse(row(id).rec.notBefore!)).toBeGreaterThanOrEqual(reset.getTime());
  });

  it("needs exactly one target, and reset_at only with after_limit_reset", async () => {
    const { call } = await connect();
    const id = await queued(call);
    const none = await call("postpone_task", { task_id: id });
    expect(text(none)).toMatch(/exactly one of preset, until or delay_minutes/);
    const two = await call("postpone_task", { task_id: id, preset: "1h", delay_minutes: 30 });
    expect(text(two)).toMatch(/exactly one of/);
    const stray = await call("postpone_task", { task_id: id, preset: "1h", reset_at: new Date(Date.now() + H).toISOString() });
    expect(text(stray)).toMatch(/reset_at is only valid/);
  });

  it("after_limit_reset with no known reset says to pass reset_at", async () => {
    const { call } = await connect();
    const id = await queued(call);
    const r = await call("postpone_task", { task_id: id, preset: "after_limit_reset" });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/needs the reset time; pass reset_at/);
  });

  it("delay_minutes counts from the planned start", async () => {
    const { call } = await connect();
    const id = await queued(call);
    const r = await call("postpone_task", { task_id: id, delay_minutes: 90 });
    expect(r.isError, text(r)).toBeFalsy();
    const nb = Date.parse(row(id).rec.notBefore!);
    expect(nb).toBeGreaterThanOrEqual(Date.now() + 90 * 60_000 - 5_000);
  });
});

describe("schedule_task not_before", () => {
  it("stores a future not_before inside the deadline", async () => {
    const { call } = await connect();
    const at = new Date(Date.now() + 2 * H);
    const r = await call("schedule_task", {
      prompt: "after lunch",
      deadline: new Date(Date.now() + 8 * H).toISOString(),
      not_before: at.toISOString(),
      region: "GB",
    });
    expect(r.isError, text(r)).toBeFalsy();
    expect(text(r)).toContain(`not_before: ${at.toISOString()}`);
    expect(row(taskId(r)).rec.notBefore).toBe(at.toISOString());
  });

  it("refuses a not_before after the deadline and queues nothing", async () => {
    const { call } = await connect();
    const r = await call("schedule_task", {
      prompt: "too late",
      deadline: new Date(Date.now() + 2 * H).toISOString(),
      not_before: new Date(Date.now() + 3 * H).toISOString(),
      region: "GB",
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/not_before .* is after the deadline/);
    const store = new TaskStore({ dbPath });
    expect(store.list()).toHaveLength(0);
    store.close();
  });

  it("refuses not_before with dispatch=false instead of dropping it", async () => {
    const { call } = await connect();
    const r = await call("schedule_task", {
      prompt: "closure",
      deadline: new Date(Date.now() + 4 * H).toISOString(),
      not_before: new Date(Date.now() + H).toISOString(),
      dispatch: false,
      region: "GB",
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/not_before needs a persisted task/);
  });

  it("refuses a past not_before", async () => {
    const { call } = await connect();
    const r = await call("schedule_task", {
      prompt: "past",
      deadline: new Date(Date.now() + 2 * H).toISOString(),
      not_before: new Date(Date.now() - H).toISOString(),
      region: "GB",
    });
    expect(text(r)).toMatch(/not_before .* is not in the future/);
  });
});

describe("schedule_task readiness line (R6)", () => {
  it("a ledger nobody ticked: the no-daemon sentence, no npm boilerplate", async () => {
    const { call } = await connect();
    const r = await call("schedule_task", {
      prompt: "x",
      deadline: new Date(Date.now() + 6 * H).toISOString(),
      region: "GB",
    });
    expect(text(r)).toContain("Tasks will not run: no tick daemon. Run `tidegap install`.");
    expect(text(r)).not.toMatch(/npm install|Without the daemon/);
  });

  it("a fresh tick with a matching runner snapshot: one 'Runs at' line", async () => {
    const seed = new TaskStore({ dbPath });
    const now = new Date().toISOString();
    seed.setMeta(LAST_TICK_META_KEY, now);
    writeTickRunners(seed, { at: now, providers: ["anthropic"], claude_lookup: "done" });
    seed.close();
    const { call } = await connect();
    const r = await call("schedule_task", {
      prompt: "x",
      deadline: new Date(Date.now() + 6 * H).toISOString(),
      region: "GB",
    });
    expect(text(r)).not.toMatch(/Tasks will not run/);
    expect(text(r).match(/^Runs (at .* local|on the next tick)\.$/gm)).toHaveLength(1);
  });

  it("a fresh tick without a runner for the provider: the no-runner sentence", async () => {
    const seed = new TaskStore({ dbPath });
    const now = new Date().toISOString();
    seed.setMeta(LAST_TICK_META_KEY, now);
    writeTickRunners(seed, { at: now, providers: ["anthropic"], claude_lookup: "done" });
    seed.close();
    const { call } = await connect();
    const r = await call("schedule_task", {
      prompt: "x",
      provider: "openai",
      deadline: new Date(Date.now() + 6 * H).toISOString(),
      region: "GB",
    });
    expect(text(r)).toContain("Tasks will not run: 1 openai task has no runner.");
  });
});
