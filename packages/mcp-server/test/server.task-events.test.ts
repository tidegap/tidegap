/**
 * Task events through the REAL MCP handlers: writes are recorded as
 * `agent:mcp`, and `check_queue_status` with a task_id shows the newest five.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mockGridFeed, TaskStore } from "@tidegap/core";
import { afterEach, describe, expect, it } from "vitest";
import { createEbbServer } from "../src/server.js";

type TextResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

describe("task events in MCP", () => {
  it("records agent:mcp and check_queue_status shows the last 5 events, newest last", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tidegap-mcp-events-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const dbPath = join(dir, "queue.db");
    const built = createEbbServer({ feed: mockGridFeed(), dbPath, quotaConfigPath: join(dir, "config") });
    const client = new Client({ name: "events-test", version: "0.0.0" });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([built.server.connect(serverTransport), client.connect(clientTransport)]);
    cleanups.push(() => built.scheduler.shutdown());
    const call = async (name: string, args: Record<string, unknown>) =>
      (await client.callTool({ name, arguments: args })) as TextResult;

    const scheduled = await call("schedule_task", {
      prompt: "Nightly report",
      deadline: new Date(Date.now() + 6 * 3_600_000).toISOString(),
      region: "US-CAL-CISO",
    });
    expect(scheduled.isError).toBeFalsy();
    const store = new TaskStore({ dbPath });
    const [row] = store.list();
    const id = row!.taskId;
    expect(store.listTaskEvents(id).map((e) => [e.kind, e.actor])).toEqual([["created", "agent:mcp"]]);
    for (let i = 0; i < 6; i++) store.recordEvent(id, { kind: "replied", actor: "page", details: { child_task_id: `c${i}` } });
    store.close();

    const text = (await call("check_queue_status", { task_id: id })).content.map((c) => c.text).join("\n");
    const lines = text.split("\n");
    const at = lines.indexOf("Events (newest last):");
    expect(at).toBeGreaterThan(-1);
    const shown = lines.slice(at + 1).filter((l) => l.startsWith("  "));
    expect(shown).toHaveLength(5);
    expect(shown[0]).toMatch(/replied by page - reply c1$/);
    expect(shown[4]).toMatch(/replied by page - reply c5$/);
  });
});
