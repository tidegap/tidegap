/**
 * Tests against the REAL server implementation (src/server.ts), not a stub.
 *
 * Audit §Tier2.6 flagged that the "protocol" tests exercised a parallel
 * mini-server built inside the test file, which is why §0.10 (restart
 * blindness) and §1.9 (advertised-schema drift) survived. These tests
 * import `createEbbServer` / `TOOL_DEFINITIONS` and drive the actual
 * handlers over an InMemoryTransport.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mockGridFeed, type TaskRecord } from "@tidegap/core";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildToolList,
  createEbbServer,
  formatTask,
  resolveStartupDb,
  SERVER_VERSION,
  TOOL_DEFINITIONS,
} from "../src/server.js";

type TextResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

async function connect(deps: Parameters<typeof createEbbServer>[0] = {}) {
  const built = createEbbServer({ feed: mockGridFeed(), ...deps });
  const client = new Client({ name: "real-test-client", version: "0.0.0" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    built.server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  // shutdown() is not idempotent (closing a closed SQLite store throws);
  // tests may close explicitly, so the cleanup swallows the double-close.
  const safeShutdown = () => {
    try {
      built.scheduler.shutdown();
    } catch {
      /* already shut down */
    }
  };
  cleanups.push(safeShutdown);
  const close = async () => {
    await client.close();
    await built.server.close();
    safeShutdown();
  };
  return { ...built, client, close };
}

function tmpDb(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "tidegap-mcp-test-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, dbPath: join(dir, "queue.db") };
}

function textOf(result: unknown): string {
  return (result as TextResult).content.map((c) => c.text).join("\n");
}

describe("advertised tool schemas are derived from the zod validators (§1.9)", () => {
  it("advertises exactly the eleven tools", async () => {
    const { client, close } = await connect();
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(
      TOOL_DEFINITIONS.map((d) => d.name).sort(),
    );
    expect(tools.tools).toHaveLength(11);
    await close();
  });

  it("every tool's advertised properties exactly match its zod schema keys", async () => {
    const { client, close } = await connect();
    const advertised = (await client.listTools()).tools;
    for (const def of TOOL_DEFINITIONS) {
      const tool = advertised.find((t) => t.name === def.name);
      expect(tool, `tool ${def.name} missing from ListTools`).toBeDefined();
      const props = Object.keys(
        (tool!.inputSchema as { properties?: Record<string, unknown> })
          .properties ?? {},
      ).sort();
      const zodKeys = Object.keys(def.schema.shape).sort();
      expect(props, `properties drift on ${def.name}`).toEqual(zodKeys);
      // required must be exactly the non-optional zod keys.
      const required = (
        (tool!.inputSchema as { required?: string[] }).required ?? []
      ).sort();
      const expectedRequired = zodKeys
        .filter((k) => !def.schema.shape[k]!.isOptional())
        .sort();
      expect(required, `required drift on ${def.name}`).toEqual(expectedRequired);
      // descriptions survive the derivation.
      expect(tool!.description).toBe(def.description);
    }
    await close();
  });

  it("schedule_task advertises all five previously-missing params", () => {
    const schema = buildToolList().find((t) => t.name === "schedule_task")!
      .inputSchema as { properties: Record<string, unknown> };
    for (const p of [
      "dry_run",
      "dispatch",
      "provider",
      "output_path",
      "redact_in_receipt",
    ]) {
      expect(schema.properties, `schedule_task missing ${p}`).toHaveProperty(p);
    }
  });

  it("TOOL_DEFINITIONS schemas are all zod objects (parity test stays honest)", () => {
    for (const def of TOOL_DEFINITIONS) {
      expect(def.schema).toBeInstanceOf(z.ZodObject);
    }
  });
});

describe("restart rehydration (§0.10)", () => {
  it("check_queue_status and cancel_all see persisted tasks after a restart", async () => {
    const { dbPath } = tmpDb();
    const deadline = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();

    // Session 1: schedule a persistent provider_call task, then "restart".
    const first = await connect({ dbPath });
    const scheduled = await first.client.callTool({
      name: "schedule_task",
      arguments: { prompt: "nightly digest", deadline },
    });
    expect((scheduled as TextResult).isError).toBeFalsy();
    const taskId = /task_id: (t-[0-9a-f-]{36})/.exec(textOf(scheduled))?.[1];
    expect(taskId).toBeDefined();
    await first.close();

    // Session 2: a brand-new Scheduler over the same db. The in-memory
    // map is empty — the persisted ledger must still be visible.
    const second = await connect({ dbPath });
    expect(second.scheduler.listTasks()).toHaveLength(0); // precondition

    const status = await second.client.callTool({
      name: "check_queue_status",
      arguments: {},
    });
    const statusText = textOf(status);
    expect(statusText).not.toContain("Queue is empty");
    expect(statusText).toMatch(/Total tasks: 1/);
    expect(statusText).toContain(taskId!);

    // Detail view resolves the persisted task too.
    const detail = await second.client.callTool({
      name: "check_queue_status",
      arguments: { task_id: taskId },
    });
    expect((detail as TextResult).isError).toBeFalsy();
    expect(textOf(detail)).toContain(`task_id: ${taskId}`);

    // cancel_all must find (and cancel) the rehydrated task.
    const cancelled = await second.client.callTool({
      name: "cancel_all",
      arguments: {},
    });
    expect(textOf(cancelled)).toMatch(/Cancelled 1 of 1/);

    const after = await second.client.callTool({
      name: "check_queue_status",
      arguments: {},
    });
    expect(textOf(after)).toMatch(/cancelled: 1/);
    await second.close();
  });
});

describe("schedule_task response enrichment (§1.11)", () => {
  it("success text carries carbon estimate, window, region, grid_source and the SYNTHETIC warning", async () => {
    const { dbPath } = tmpDb();
    const { client, close } = await connect({ dbPath });
    const deadline = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    const result = await client.callTool({
      name: "schedule_task",
      arguments: { prompt: "summarize inbox", deadline, region: "US-CAL-CISO" },
    });
    expect((result as TextResult).isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toMatch(/estimated_carbon_g_co2: \d/);
    expect(text).toMatch(/scheduled_for: \d{4}-/);
    expect(text).toContain("region: US-CAL-CISO");
    expect(text).toContain(`deadline: ${deadline}`);
    expect(text).toContain("grid_source: mock");
    expect(text).toContain("SYNTHETIC (mock) grid data");
    await close();
  });

  it("dry_run previews with the server default model (not a hardcoded one) and persists nothing", async () => {
    const { client, scheduler, close } = await connect({
      defaultModel: "test-default-model",
    });
    const deadline = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
    const result = await client.callTool({
      name: "schedule_task",
      arguments: { prompt: "preview me", deadline, dry_run: true },
    });
    expect((result as TextResult).isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("dry_run plan (nothing persisted)");
    expect(text).toContain("model: test-default-model");
    expect(text).toMatch(/estimated_carbon_g_co2: \d/);
    expect(text).toContain("grid_source: mock");
    expect(text).toContain("SYNTHETIC (mock) grid data");
    expect(scheduler.listTasks()).toHaveLength(0);
    expect(scheduler.listPersistedTasks()).toHaveLength(0);
    await close();
  });

  it("stores a claude-code tools list and rejects a tool outside the allowlist", async () => {
    const { dbPath } = tmpDb();
    const { client, scheduler, close } = await connect({ dbPath });
    const deadline = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
    const ok = await client.callTool({
      name: "schedule_task",
      arguments: { prompt: "weather in Kyiv", deadline, provider: "claude-code", tools: ["WebFetch"] },
    });
    expect((ok as TextResult).isError).toBeFalsy();
    const [rec] = scheduler.listPersistedTasks();
    expect(JSON.parse(rec!.bodyJson!).tools).toEqual(["WebFetch"]);
    for (const dry_run of [false, true]) {
      const bad = await client.callTool({
        name: "schedule_task",
        arguments: { prompt: "x", deadline, provider: "claude-code", tools: ["Bash"], dry_run },
      });
      expect((bad as TextResult).isError).toBe(true);
      expect(textOf(bad)).toContain('"Bash" not allowed');
      expect(textOf(bad)).toContain("WebSearch, WebFetch, Read, Grep, Glob");
    }
    expect(scheduler.listPersistedTasks()).toHaveLength(1);
    await close();
  });

  describe("per-provider default model (R12)", () => {
    const saved = process.env.TIDEGAP_DEFAULT_MODEL;
    afterEach(() => {
      if (saved === undefined) delete process.env.TIDEGAP_DEFAULT_MODEL;
      else process.env.TIDEGAP_DEFAULT_MODEL = saved;
    });

    async function previewModel(provider?: string): Promise<string> {
      const { client, close } = await connect();
      const deadline = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
      const result = await client.callTool({
        name: "schedule_task",
        arguments: {
          prompt: "preview me",
          deadline,
          dry_run: true,
          ...(provider ? { provider } : {}),
        },
      });
      await close();
      expect((result as TextResult).isError).toBeFalsy();
      const line = textOf(result).split("\n").find((l) => l.startsWith("model: "));
      return line!.slice("model: ".length);
    }

    it.each([
      [undefined, "claude-sonnet-5"],
      ["anthropic", "claude-sonnet-5"],
      ["openai", "gpt-6-sol"],
      ["gemini", "gemini-3.8-flash"],
      ["ollama", "llama3.1"],
    ])("dry_run with provider %s and no model previews %s", async (provider, model) => {
      delete process.env.TIDEGAP_DEFAULT_MODEL;
      expect(await previewModel(provider)).toBe(model);
    });

    it("TIDEGAP_DEFAULT_MODEL overrides the Anthropic default only", async () => {
      process.env.TIDEGAP_DEFAULT_MODEL = "claude-opus-5";
      expect(await previewModel()).toBe("claude-opus-5");
      expect(await previewModel("openai")).toBe("gpt-6-sol");
      expect(await previewModel("gemini")).toBe("gemini-3.8-flash");
    });

    it("the persisted task carries the same per-provider default as the preview", async () => {
      delete process.env.TIDEGAP_DEFAULT_MODEL;
      const { client, scheduler, close } = await connect({ dbPath: ":memory:" });
      const deadline = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
      const result = await client.callTool({
        name: "schedule_task",
        arguments: { prompt: "persist me", deadline, provider: "openai" },
      });
      expect((result as TextResult).isError).toBeFalsy();
      expect(textOf(result)).toContain("model: gpt-6-sol");
      const [task] = scheduler.listPersistedTasks();
      expect(JSON.parse(task.bodyJson!).model).toBe("gpt-6-sol");
      await close();
    });
  });

  it("recommend_window payload includes grid_source", async () => {
    const { client, close } = await connect();
    const deadline = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    const result = await client.callTool({
      name: "recommend_window",
      arguments: { deadline, region: "US-CAL-CISO" },
    });
    expect((result as TextResult).isError).toBeFalsy();
    const payload = JSON.parse(textOf(result)) as { grid_source?: string };
    expect(payload.grid_source).toBe("mock");
    await close();
  });

  it("check_queue_status receipt rendering surfaces actual/delta/grid/energy provenance", () => {
    const record: TaskRecord<unknown> = {
      taskId: "t-receipt-test",
      status: "completed",
      enqueuedAt: "2026-06-28T00:00:00Z",
      completedAt: "2026-06-28T03:00:00Z",
      scheduledFor: "2026-06-28T03:00:00Z",
      region: "US-CAL-CISO",
      deadline: "2026-06-28T08:00:00Z",
      result: "the LLM answer",
      receipt: {
        taskId: "t-receipt-test",
        ranAt: "2026-06-28T03:00:00Z",
        region: "US-CAL-CISO",
        estimatedCarbonGCo2: 0.4,
        actualCarbonGCo2: 0.3,
        deltaPct: -25,
        intensityGCo2PerKwh: 200,
        gridSource: "mock",
        energySource: "estimated",
        durationMs: 1234,
      },
    };
    const text = formatTask(record);
    expect(text).toContain("estimated_carbon_g: 0.4");
    expect(text).toContain("actual_carbon_g: 0.3");
    expect(text).toContain("delta_pct: -25");
    expect(text).toContain("intensity_g_co2_per_kwh: 200");
    expect(text).toContain("grid_source: mock — SYNTHETIC (mock) grid data");
    expect(text).toContain("energy_source: estimated");
    expect(text).toContain("deadline: 2026-06-28T08:00:00Z");
    expect(text).toContain("Result:\nthe LLM answer");
  });
});

describe("startup db resolution (§1.9 in-memory fallback)", () => {
  it("keeps an explicit :memory: request as an ephemeral store", () => {
    expect(resolveStartupDb(":memory:")).toEqual({ dbPath: ":memory:" });
  });

  it("returns the requested path (and creates its directory) when possible", () => {
    const { dir } = tmpDb();
    const wanted = join(dir, "nested", "queue.db");
    const resolved = resolveStartupDb(wanted);
    expect(resolved.dbPath).toBe(wanted);
    expect(resolved.fallbackNote).toBeUndefined();
  });

  it("actually falls back to in-memory when the directory cannot be created", () => {
    const { dir } = tmpDb();
    // A regular file where a directory is needed → mkdir fails.
    const blocker = join(dir, "not-a-dir");
    writeFileSync(blocker, "x");
    const resolved = resolveStartupDb(join(blocker, "sub", "queue.db"));
    expect(resolved.dbPath).toBeUndefined();
    expect(resolved.fallbackNote).toMatch(/could not create/);
    // And a server built from that resolution must not crash — it runs
    // a working in-memory queue.
    const built = createEbbServer({
      feed: mockGridFeed(),
      dbPath: resolved.dbPath,
    });
    cleanups.push(() => built.scheduler.shutdown());
    expect(built.scheduler.listPersistedTasks()).toEqual([]);
    expect(() => built.scheduler.listTasks()).not.toThrow();
  });
});

describe("server metadata", () => {
  it("SERVER_VERSION comes from package.json (no hand-synced constant)", async () => {
    const pkg = (await import("../package.json")) as unknown as {
      default?: { version: string };
      version?: string;
    };
    const version = pkg.default?.version ?? pkg.version;
    expect(SERVER_VERSION).toBe(version);
    expect(SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
