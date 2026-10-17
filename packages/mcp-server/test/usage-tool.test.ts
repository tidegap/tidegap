/** MCP `tidegap_usage` and `schedule_task.after_limit_reset` (U7). No network, no Keychain. */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { writeUsageCache, type FetchLike } from "@tidegap/cli/usage";
import { mockGridFeed, TaskStore } from "@tidegap/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createEbbServer } from "../src/server.js";

const H = 3_600_000;
const TOKEN = "sk-ant-oat01-FIXTURE-TOKEN-do-not-leak";
type TextResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

let dir: string;
let dbPath: string;
const closers: Array<() => Promise<void>> = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tidegap-mcp-usage-"));
  dbPath = join(dir, "queue.db");
});
afterEach(async () => {
  while (closers.length) await closers.pop()!();
  rmSync(dir, { recursive: true, force: true });
});

function usage(extra: Record<string, unknown> = {}) {
  return { cachePath: join(dir, "usage.json"), configPath: join(dir, "config"), env: {}, ...extra };
}

function seed(fivePct: number, fiveReset: Date): void {
  writeUsageCache(
    {
      version: 1,
      claude: {
        statusline: {
          fetched_at: new Date().toISOString(),
          data: {
            five_hour: { pct: fivePct, resets_at: fiveReset.toISOString() },
            seven_day: { pct: 40, resets_at: new Date(Date.now() + 3 * 24 * H).toISOString() },
            scoped: [],
          },
        },
      },
    },
    join(dir, "usage.json"),
  );
}

async function connect(extra: Record<string, unknown> = {}) {
  const built = createEbbServer({ feed: mockGridFeed(), dbPath, usage: usage(extra) });
  const client = new Client({ name: "usage-test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([built.server.connect(a), client.connect(b)]);
  closers.push(async () => {
    await client.close();
    await built.server.close();
    built.scheduler.shutdown();
  });
  return client;
}

const text = (r: unknown) => (r as TextResult).content.map((c) => c.text).join("\n");

describe("tidegap_usage", () => {
  it("returns the usage/v1 document and its line", async () => {
    const reset = new Date(Date.now() + 2 * H);
    seed(72, reset);
    const client = await connect();
    const out = text(await client.callTool({ name: "tidegap_usage", arguments: {} }));
    expect(out.split("\n")[0]).toMatch(/^Claude 5h: 72%, resets /);
    const doc = JSON.parse(out.slice(out.indexOf("\n") + 1));
    expect(doc).toMatchObject({ schema: "usage/v1", claude: { status: "ok", source: "statusline" } });
    expect(doc.target_reset.at).toBe(reset.toISOString());
  });

  it("with OAuth on, the tool result never contains the token", async () => {
    const fetch: FetchLike = async () => ({
      status: 200,
      headers: { get: () => null },
      json: async () => ({ five_hour: { utilization: 10, resets_at: new Date(Date.now() + H).toISOString() } }),
    });
    const client = await connect({
      env: { oauth: "1" },
      fetch,
      credentials: {
        platform: "linux",
        readFile: (p: string) =>
          p.endsWith(".credentials.json")
            ? JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, expiresAt: Date.now() + 10 * H } })
            : undefined,
      },
    });
    const out = text(await client.callTool({ name: "tidegap_usage", arguments: {} }));
    expect(out).toMatch(/"source": "api"/);
    expect(out).not.toContain(TOKEN);
    expect(readFileSync(join(dir, "usage.json"), "utf8")).not.toContain(TOKEN);
  });
});

describe("schedule_task after_limit_reset", () => {
  it("an exhausted 5 h window queues the task with notBefore at the reset", async () => {
    const reset = new Date(Math.ceil((Date.now() + 3 * H) / 60_000) * 60_000);
    seed(100, reset);
    const client = await connect();
    const res = (await client.callTool({
      name: "schedule_task",
      arguments: { prompt: "Summarise", deadline: new Date(Date.now() + 2 * H).toISOString(), after_limit_reset: true },
    })) as TextResult;
    expect(res.isError).toBeFalsy();
    const id = /task_id: (\S+)/.exec(text(res))![1]!;
    expect(text(res)).toContain(`not_before: ${reset.toISOString()} (after the 5h limit reset`);
    const store = new TaskStore({ dbPath });
    const row = store.get(id)!;
    store.close();
    expect(row.notBefore).toBe(reset.toISOString());
    expect(Date.parse(row.deadline!)).toBe(reset.getTime() + 2 * H);
  });

  it("dry_run previews the earliest start and the raised deadline, queuing nothing", async () => {
    const reset = new Date(Math.ceil((Date.now() + 3 * H) / 60_000) * 60_000);
    seed(100, reset);
    const client = await connect();
    const res = (await client.callTool({
      name: "schedule_task",
      arguments: {
        prompt: "Summarise",
        deadline: new Date(Date.now() + 2 * H).toISOString(),
        after_limit_reset: true,
        dry_run: true,
      },
    })) as TextResult;
    expect(res.isError).toBeFalsy();
    const scheduledFor = Date.parse(/scheduled_for: (\S+)/.exec(text(res))![1]!);
    expect(scheduledFor).toBeGreaterThan(reset.getTime());
    expect(text(res)).toContain(`deadline: ${new Date(reset.getTime() + 2 * H).toISOString()}`);
    const store = new TaskStore({ dbPath });
    expect(store.list({}).length).toBe(0);
    store.close();
  });

  it("no limit state: a tool error with the cause, nothing queued", async () => {
    const client = await connect();
    const res = (await client.callTool({
      name: "schedule_task",
      arguments: { prompt: "Summarise", deadline: new Date(Date.now() + 2 * H).toISOString(), after_limit_reset: true },
    })) as TextResult;
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/limit state unavailable/);
    const store = new TaskStore({ dbPath });
    expect(store.list({}).length).toBe(0);
    store.close();
  });
});
