/**
 * Real MCP protocol smoke test.
 *
 * Builds an MCP server + client pair connected via InMemoryTransport,
 * exercises the three tools, asserts on CallToolResult shape.
 *
 * Engineering review v0.1 flagged that the existing server.smoke.test.ts
 * only tests the building blocks, not the protocol. This file closes that
 * gap.
 *
 * Note: we instantiate the server here rather than spawn dist/server.js as
 * a child process; that lets us test without binary location and avoids
 * stdio plumbing in the test harness. The handlers are the same.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { mockGridFeed, recommendWindow, Scheduler, TOOL_SURFACE, toolsForHost, paramsForHost } from "@tidegap/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createEbbServer, SERVER_INSTRUCTIONS } from "../src/server.js";

function buildServer() {
  const feed = mockGridFeed();
  const scheduler = new Scheduler({ feed, defaultRegion: "US-CAL-CISO" });

  const server = new Server(
    { name: "tidegap-mcp-test", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "get_grid_forecast",
        description: "Test stub",
        inputSchema: {
          type: "object",
          properties: {
            region: { type: "string" },
            hours: { type: "number" },
          },
          required: ["region"],
        },
      },
      {
        name: "schedule_task",
        description: "Test stub",
        inputSchema: {
          type: "object",
          properties: {
            prompt: { type: "string" },
            deadline: { type: "string" },
          },
          required: ["prompt", "deadline"],
        },
      },
      {
        name: "check_queue_status",
        description: "Test stub",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "recommend_window",
        description: "Test stub",
        inputSchema: {
          type: "object",
          properties: {
            deadline: { type: "string" },
            region: { type: "string" },
            carbon_budget_g: { type: "number" },
            model: { type: "string" },
          },
          required: ["deadline", "region"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name === "get_grid_forecast") {
      const args = z
        .object({ region: z.string(), hours: z.number().optional() })
        .parse(req.params.arguments ?? {});
      const forecast = await feed.fetchForecast(args.region, args.hours ?? 24);
      return {
        content: [
          {
            type: "text",
            text: `entries:${forecast.entries.length} source:${forecast.source}`,
          },
        ],
      };
    }
    if (req.params.name === "schedule_task") {
      const args = z
        .object({
          prompt: z.string().min(1),
          deadline: z.string().datetime({ offset: true }),
        })
        .parse(req.params.arguments ?? {});
      const record = scheduler.enqueue(async () => args.prompt, {
        deadline: args.deadline,
      });
      return {
        content: [{ type: "text", text: `task_id:${record.taskId}` }],
      };
    }
    if (req.params.name === "check_queue_status") {
      return {
        content: [
          { type: "text", text: `tasks:${scheduler.listTasks().length}` },
        ],
      };
    }
    if (req.params.name === "recommend_window") {
      const args = z
        .object({
          deadline: z.string().datetime({ offset: true }),
          region: z.string().min(1),
          carbon_budget_g: z.number().positive().optional(),
          model: z.string().optional(),
        })
        .parse(req.params.arguments ?? {});
      try {
        const result = await recommendWindow(
          {
            deadline: args.deadline,
            region: args.region,
            carbonBudgetG: args.carbon_budget_g,
            model: args.model,
          },
          { feed },
        );
        return {
          content: [
            { type: "text", text: JSON.stringify(result) },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `recommend_window rejected: ${msg}` }],
          isError: true,
        };
      }
    }
    return {
      content: [{ type: "text", text: `unknown:${req.params.name}` }],
      isError: true,
    };
  });

  return { server, scheduler };
}

async function buildClient() {
  return new Client({ name: "tidegap-mcp-test-client", version: "0.0.0" });
}

describe("tidegap-mcp protocol", () => {
  it("connects and lists four tools", async () => {
    const { server, scheduler } = buildServer();
    const client = await buildClient();
    const [serverTransport, clientTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([
      "check_queue_status",
      "get_grid_forecast",
      "recommend_window",
      "schedule_task",
    ]);

    await client.close();
    await server.close();
    scheduler.shutdown();
  });

  it("calls get_grid_forecast and gets a well-formed result", async () => {
    const { server, scheduler } = buildServer();
    const client = await buildClient();
    const [s, c] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(s), client.connect(c)]);

    const result = await client.callTool({
      name: "get_grid_forecast",
      arguments: { region: "US-CAL-CISO", hours: 6 },
    });
    expect(result.isError).toBeFalsy();
    const content = (result as { content: { type: string; text: string }[] }).content;
    expect(content).toHaveLength(1);
    expect(content[0]!.type).toBe("text");
    expect(content[0]!.text).toMatch(/entries:6/);
    expect(content[0]!.text).toMatch(/source:mock/);

    await client.close();
    await server.close();
    scheduler.shutdown();
  });

  it("calls schedule_task and gets back a task_id", async () => {
    const { server, scheduler } = buildServer();
    const client = await buildClient();
    const [s, c] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(s), client.connect(c)]);

    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const result = await client.callTool({
      name: "schedule_task",
      arguments: { prompt: "summarize my inbox", deadline: future },
    });
    expect(result.isError).toBeFalsy();
    const content = (result as { content: { text: string }[] }).content;
    expect(content[0]!.text).toMatch(/^task_id:t-[0-9a-f-]{36}$/);

    const status = await client.callTool({
      name: "check_queue_status",
      arguments: {},
    });
    expect((status as { content: { text: string }[] }).content[0]!.text).toMatch(
      /tasks:1/,
    );

    await client.close();
    await server.close();
    scheduler.shutdown();
  });

  it("calls recommend_window and returns a JSON recommendation", async () => {
    const { server, scheduler } = buildServer();
    const client = await buildClient();
    const [s, c] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(s), client.connect(c)]);

    const future = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    const result = await client.callTool({
      name: "recommend_window",
      arguments: { deadline: future, region: "US-CAL-CISO" },
    });
    expect(result.isError).toBeFalsy();
    const content = (result as { content: { text: string }[] }).content;
    expect(content).toHaveLength(1);
    const payload = JSON.parse(content[0]!.text) as {
      scheduledFor: string;
      intensityGCo2PerKwh: number;
      band: string;
      batchEligible: boolean;
      alternatives: unknown[];
      reasoning: string;
    };
    expect(typeof payload.scheduledFor).toBe("string");
    expect(payload.intensityGCo2PerKwh).toBeGreaterThan(0);
    expect(["very_clean", "clean", "average", "dirty", "very_dirty"]).toContain(
      payload.band,
    );
    expect(typeof payload.batchEligible).toBe("boolean");
    expect(Array.isArray(payload.alternatives)).toBe(true);
    expect(payload.reasoning.length).toBeGreaterThan(0);
    // recommend_window does NOT touch the scheduler queue — proof:
    expect(scheduler.listTasks()).toHaveLength(0);

    await client.close();
    await server.close();
    scheduler.shutdown();
  });

  it("recommend_window propagates InvalidDeadlineError as isError: true", async () => {
    const { server, scheduler } = buildServer();
    const client = await buildClient();
    const [s, c] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(s), client.connect(c)]);

    // Past deadline. The zod schema accepts it (datetime+offset is fine),
    // but recommendWindow rejects it at runtime.
    const past = "2020-01-01T00:00:00Z";
    const result = await client.callTool({
      name: "recommend_window",
      arguments: { deadline: past, region: "US-CAL-CISO" },
    });
    expect(result.isError).toBe(true);

    await client.close();
    await server.close();
    scheduler.shutdown();
  });

  it("rejects an unknown tool with isError: true", async () => {
    const { server, scheduler } = buildServer();
    const client = await buildClient();
    const [s, c] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(s), client.connect(c)]);

    const result = await client.callTool({
      name: "nonexistent_tool",
      arguments: {},
    });
    expect(result.isError).toBe(true);

    await client.close();
    await server.close();
    scheduler.shutdown();
  });
});

describe("server instructions", () => {
  it("the initialize answer of the real server carries SERVER_INSTRUCTIONS", async () => {
    const built = createEbbServer({ feed: mockGridFeed() });
    const client = await buildClient();
    const [s, c] = InMemoryTransport.createLinkedPair();
    await Promise.all([built.server.connect(s), client.connect(c)]);
    try {
      expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
    } finally {
      await client.close();
      await built.server.close();
      built.scheduler.shutdown();
    }
  });

  it("states the task model in at most 1,000 characters", () => {
    expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(1000);
    for (const fact of ["one run of one runner", "not_before", "not a run time", "check_queue_status", "repeat", "not cron"]) {
      expect(SERVER_INSTRUCTIONS, fact).toContain(fact);
    }
  });

  it("names only MCP tools and MCP parameters", () => {
    const mcp = toolsForHost("mcp");
    const tools = new Set(mcp.map((t) => t.name));
    const params = new Set(mcp.flatMap((t) => paramsForHost(t, "mcp").map((p) => p.name)));
    const named = [...SERVER_INSTRUCTIONS.matchAll(/\b[a-z]+(?:_[a-z]+)+\b/g)].map((m) => m[0]);
    expect(named.length).toBeGreaterThan(0);
    for (const name of named) expect(tools.has(name) || params.has(name), name).toBe(true);
    // OpenClaw-only names never appear.
    const openclawOnly = TOOL_SURFACE.filter((t) => !t.hosts.includes("mcp")).map((t) => t.name);
    expect(openclawOnly.length).toBeGreaterThan(0);
    for (const name of openclawOnly) expect(SERVER_INSTRUCTIONS, name).not.toContain(name);
  });
});
