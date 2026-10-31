import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { carbonBudgetConfigPath, mockGridFeed, Scheduler, TaskStore } from "@tidegap/core";

import tidegapPlugin, {
  bootstrapDispatcherOnStartup,
  runDispatchTick,
} from "../src/index.js";
import {
  availableProviders,
  buildAdapters,
  inferProvider,
  setLlmBridgeForTest,
} from "../src/dispatch.js";
import {
  __setPuppeteerImportForTest,
  __setSpawnForTest,
  setOsNotificationsDisabled,
  deliverResult,
  formatReport,
  getDeliveryConfig,
  notificationContent,
  osNotifyCommand,
  readDeliveryRecord,
  recordDeliveryOutcomes,
  scanDeliveryOptions,
  setDeliveryConfig,
  setDeliveryStorePath,
  validateDeliveryConfig,
} from "../src/delivery.js";
import type { StubResolvedTool } from "./stub-tool-plugin.js";

const TOOL_NAMES = [
  "schedule_task",
  "recommend_window",
  "check_queue_status",
  "cancel_task",
  "get_grid_forecast",
  "update_deadline",
  "cancel_all",
  "set_delivery",
  "expedite_task",
  "retry_task",
  "reply_task",
];

function tool(name: string): StubResolvedTool {
  const found = tidegapPlugin.tools.find((t: StubResolvedTool) => t.name === name);
  if (!found) throw new Error(`tool ${name} is not registered`);
  return found;
}

/** An ISO-8601 deadline ~24h in the future. */
function deadlineISO(hoursAhead = 24): string {
  return new Date(Date.now() + hoursAhead * 60 * 60 * 1000).toISOString();
}

describe("Tidegap OpenClaw plugin — registration", () => {
  it("loads as a tool plugin with id 'tidegap'", () => {
    expect(tidegapPlugin.id).toBe("tidegap");
    expect(tidegapPlugin.name).toMatch(/Tidegap/);
  });

  it("registers the eleven tools, MCP-style names with no tidegap_ or ebb_ prefix", () => {
    const names = tidegapPlugin.tools.map((t: StubResolvedTool) => t.name).sort();
    expect(names).toEqual([...TOOL_NAMES].sort());
    for (const t of tidegapPlugin.tools) {
      expect(t.name).not.toMatch(/^(tidegap|ebb)_/);
    }
  });

  it("gives every tool a label, a description and a parameters schema", () => {
    for (const t of tidegapPlugin.tools) {
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.parameters).toBeTruthy();
    }
  });
});

describe("Tidegap OpenClaw plugin — region precedence", () => {
  let tmp: string;
  let dbPath: string;
  let saved: string | undefined;
  let bump = 0;
  const configPath = () => carbonBudgetConfigPath();

  /** Store the region setting with a fresh mtime, so the reader sees it. */
  function storeSetting(value: string): void {
    mkdirSync(dirname(configPath()), { recursive: true });
    writeFileSync(configPath(), `TIDEGAP_DEFAULT_REGION=${value}\n`);
    const t = new Date(Date.now() + ++bump * 5_000);
    utimesSync(configPath(), t, t);
  }

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "tidegap-plugin-region-"));
    dbPath = join(tmp, "queue.db");
    saved = existsSync(configPath()) ? readFileSync(configPath(), "utf8") : undefined;
  });

  afterAll(() => {
    if (saved === undefined) rmSync(configPath(), { force: true });
    else writeFileSync(configPath(), saved);
    rmSync(tmp, { recursive: true, force: true });
  });

  async function schedule(region?: string, defaultRegion?: string) {
    return (await tool("schedule_task").execute(
      { prompt: "region test", deadline: deadlineISO(), ...(region ? { region } : {}) },
      { dbPath, ...(defaultRegion ? { defaultRegion } : {}) },
    )) as { region: string; region_source: string };
  }

  it("plugin defaultRegion beats the stored setting (region_source: config)", async () => {
    storeSetting("FR");
    const res = await schedule(undefined, "DE");
    expect([res.region, res.region_source]).toEqual(["DE", "config"]);
  });

  it("the stored setting beats the time zone and is re-read on the next call", async () => {
    storeSetting("FR");
    const first = await schedule();
    expect([first.region, first.region_source]).toEqual(["FR", "setting"]);
    storeSetting("de");
    const second = await schedule();
    expect([second.region, second.region_source]).toEqual(["DE", "setting"]);
  });

  it("a tool argument reports flag and wins over config and setting", async () => {
    storeSetting("FR");
    const res = await schedule("us-cal-ciso", "DE");
    expect([res.region, res.region_source]).toEqual(["US-CAL-CISO", "flag"]);
  });

  it("an unknown zone argument is rejected with the closest zones", async () => {
    await expect(schedule("UA")).rejects.toThrow(
      /^schedule_task rejected: Unknown zone UA\. Closest: PL\. Request a region: https:\/\/github\.com\//,
    );
    await expect(
      tool("get_grid_forecast").execute({ region: "XX" }, { dbPath: "/nonexistent-dir/queue.db" }),
    ).rejects.toThrow(/^get_grid_forecast rejected: Unknown zone XX\. Request a region: /);
  });

  it("an unknown zone passes through when an Electricity Maps key is configured", async () => {
    const urls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      urls.push(String(input instanceof Request ? input.url : input));
      return new Response("unauthorized", { status: 401 });
    }) as typeof fetch;
    try {
      await tool("get_grid_forecast").execute(
        { region: "US-CAR-DUK", hours: 2 },
        { dbPath: "/nonexistent-dir/queue.db", electricityMapsApiKey: "test-key" },
      );
    } catch {
      /* the stubbed 401 may surface as an error; the zone reaching the feed is the point */
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(urls.some((u) => u.includes("US-CAR-DUK"))).toBe(true);
  });
});

describe("Tidegap OpenClaw plugin — tool execution", () => {
  let tmp: string;
  let dbPath: string;
  let scheduledId: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "tidegap-plugin-test-"));
    dbPath = join(tmp, "queue.db");
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("recommend_window returns a window without opening the queue DB", async () => {
    const res = (await tool("recommend_window").execute(
      { deadline: deadlineISO(), region: "GB" },
      { dbPath: "/nonexistent-dir/queue.db" },
    )) as Record<string, unknown>;
    expect(res).toBeTruthy();
    expect(typeof res).toBe("object");
  });

  it("get_grid_forecast returns a forecast without opening the queue DB", async () => {
    const res = (await tool("get_grid_forecast").execute(
      { region: "GB", hours: 6 },
      { dbPath: "/nonexistent-dir/queue.db" },
    )) as Record<string, unknown>;
    expect(res).toBeTruthy();
    expect(typeof res).toBe("object");
  });

  it("schedule_task persists a task and reports region_source", async () => {
    const res = (await tool("schedule_task").execute(
      { prompt: "tidegap plugin test task", deadline: deadlineISO(), region: "GB" },
      { dbPath },
    )) as {
      task_id: string;
      status: string;
      region: string;
      region_source: string;
      persisted_to: string;
    };
    expect(res.task_id).toBeTruthy();
    expect(res.region).toBe("GB");
    expect(res.region_source).toBe("flag");
    expect(res.persisted_to).toBe(dbPath);
    scheduledId = res.task_id;
  });

  it("check_queue_status lists the scheduled task", async () => {
    const res = (await tool("check_queue_status").execute(
      {},
      { dbPath },
    )) as { total: number; tasks: Array<{ task_id: string }> };
    expect(res.total).toBeGreaterThanOrEqual(1);
    expect(res.tasks.some((t) => t.task_id === scheduledId)).toBe(true);
  });

  it("update_deadline reschedules a queued task", async () => {
    const res = (await tool("update_deadline").execute(
      { task_id: scheduledId, deadline: deadlineISO(48) },
      { dbPath },
    )) as { task_id: string; status: string };
    expect(res.task_id).toBe(scheduledId);
    expect(["queued", "scheduled"]).toContain(res.status);
  });

  it("cancel_task cancels the scheduled task", async () => {
    const res = (await tool("cancel_task").execute(
      { task_id: scheduledId },
      { dbPath },
    )) as { task_id: string; status: string };
    expect(res.task_id).toBe(scheduledId);
    expect(res.status).toBe("cancelled");
  });

  it("cancel_all cancels remaining queued/scheduled tasks", async () => {
    await tool("schedule_task").execute(
      { prompt: "second task", deadline: deadlineISO(), region: "GB" },
      { dbPath },
    );
    const res = (await tool("cancel_all").execute({}, { dbPath })) as {
      matched: number;
      cancelled: number;
      errors: unknown[];
    };
    expect(res.matched).toBeGreaterThanOrEqual(1);
    expect(res.cancelled).toBeGreaterThanOrEqual(1);
  });

  it("check_queue_status throws for an unknown task id", async () => {
    await expect(
      tool("check_queue_status").execute(
        { task_id: "t-does-not-exist" },
        { dbPath },
      ),
    ).rejects.toThrow();
  });

  it("runDispatchTick dispatches an overdue scheduled task", async () => {
    const sched = (await tool("schedule_task").execute(
      { prompt: "dispatch me", deadline: deadlineISO(), region: "GB" },
      { dbPath },
    )) as { task_id: string };

    // Force the chosen window into the past via the shared store — the
    // task is now overdue and must be picked up by the next sweep.
    const store = new TaskStore({ dbPath });
    const rec = store.get(sched.task_id);
    if (!rec) throw new Error("scheduled task was not persisted");
    rec.status = "scheduled";
    rec.scheduledFor = new Date(Date.now() - 60_000).toISOString();
    store.upsert(rec);
    store.close();

    const stub = {
      provider: "anthropic" as const,
      ready: true,
      async dispatch(model: string, prompt: string) {
        return { text: `stub:${prompt}`, model, provider: "anthropic", raw: {} };
      },
    };
    const result = await runDispatchTick({ dbPath }, { anthropic: stub });
    expect(result.dispatched).toBeGreaterThanOrEqual(1);

    const after = (await tool("check_queue_status").execute(
      { task_id: sched.task_id },
      { dbPath },
    )) as { status: string };
    expect(after.status).toBe("completed");
  });

  it("bridge dispatch (no model): the runtime bridge is called WITHOUT a model override", async () => {
    const bridgeRequests: Array<Record<string, unknown>> = [];
    setLlmBridgeForTest(async (req) => {
      bridgeRequests.push(req as Record<string, unknown>);
      return {
        text: "PASS via the OpenClaw runtime bridge",
        provider: "anthropic",
        model: "gateway-agent-model",
        usage: { totalTokens: 9 },
      };
    });
    try {
      const sched = (await tool("schedule_task").execute(
        { prompt: "bridge default-model test", deadline: deadlineISO(), region: "GB" },
        { dbPath },
      )) as { task_id: string; dispatch: string; note?: string };
      expect(sched.dispatch).toBe("openclaw-runtime");
      expect(sched.note).toBeUndefined();

      const store = new TaskStore({ dbPath });
      const rec = store.get(sched.task_id);
      if (!rec) throw new Error("task was not persisted");
      rec.status = "scheduled";
      rec.scheduledFor = new Date(Date.now() - 60_000).toISOString();
      store.upsert(rec);
      store.close();

      const result = await runDispatchTick({ dbPath });
      expect(result.dispatched).toBeGreaterThanOrEqual(1);
      // The 0.1.6 bug: any `model` param triggers OpenClaw's override-policy
      // denial. The bridge must never send one.
      expect(bridgeRequests.length).toBeGreaterThanOrEqual(1);
      expect(bridgeRequests[0]).not.toHaveProperty("model");

      const after = (await tool("check_queue_status").execute(
        { task_id: sched.task_id },
        { dbPath },
      )) as { status: string };
      expect(after.status).toBe("completed");
    } finally {
      setLlmBridgeForTest(undefined);
    }
  });

  it("bridge dispatch (explicit model): still no model override; schedule_task notes it", async () => {
    const bridgeRequests: Array<Record<string, unknown>> = [];
    setLlmBridgeForTest(async (req) => {
      bridgeRequests.push(req as Record<string, unknown>);
      return { text: "PASS", provider: "anthropic", model: "gateway-agent-model" };
    });
    try {
      const sched = (await tool("schedule_task").execute(
        {
          prompt: "bridge explicit-model test",
          deadline: deadlineISO(),
          region: "GB",
          model: "claude-opus-4-1",
        },
        { dbPath },
      )) as { task_id: string; dispatch: string; note?: string };
      expect(sched.dispatch).toBe("openclaw-runtime");
      // The user is told the explicit model is not applied via the bridge.
      expect(sched.note).toMatch(/model/i);

      const store = new TaskStore({ dbPath });
      const rec = store.get(sched.task_id);
      if (!rec) throw new Error("task was not persisted");
      rec.status = "scheduled";
      rec.scheduledFor = new Date(Date.now() - 60_000).toISOString();
      store.upsert(rec);
      store.close();

      const result = await runDispatchTick({ dbPath });
      expect(result.dispatched).toBeGreaterThanOrEqual(1);
      // Even with an explicit model the bridge must not send a model override.
      expect(bridgeRequests[0]).not.toHaveProperty("model");

      const after = (await tool("check_queue_status").execute(
        { task_id: sched.task_id },
        { dbPath },
      )) as { status: string };
      expect(after.status).toBe("completed");
    } finally {
      setLlmBridgeForTest(undefined);
    }
  });

  it("expedite_task dispatches a scheduled task immediately", async () => {
    setLlmBridgeForTest(async () => ({
      text: "expedited result",
      provider: "anthropic",
      model: "gateway-agent-model",
    }));
    try {
      const sched = (await tool("schedule_task").execute(
        { prompt: "expedite me", deadline: deadlineISO(), region: "GB" },
        { dbPath },
      )) as { task_id: string };

      const res = (await tool("expedite_task").execute(
        { task_id: sched.task_id },
        { dbPath },
      )) as { status: string };
      expect(res.status).toBe("completed");

      const after = (await tool("check_queue_status").execute(
        { task_id: sched.task_id },
        { dbPath },
      )) as { status: string; intensitySource?: string };
      expect(after.status).toBe("completed");
      expect(after.intensitySource).toBe("expedited");
    } finally {
      setLlmBridgeForTest(undefined);
    }
  });

  it("retry_task re-dispatches a failed task", async () => {
    const sched = (await tool("schedule_task").execute(
      { prompt: "retry me", deadline: deadlineISO(), region: "GB" },
      { dbPath },
    )) as { task_id: string };

    // Drive the task to `failed`: expedite it through a throwing bridge.
    setLlmBridgeForTest(async () => {
      throw new Error("simulated dispatch failure");
    });
    try {
      const failedRes = (await tool("expedite_task").execute(
        { task_id: sched.task_id },
        { dbPath },
      )) as { status: string };
      expect(failedRes.status).toBe("failed");
    } finally {
      setLlmBridgeForTest(undefined);
    }

    // retry_task on a failed task re-dispatches it; a working bridge completes it.
    setLlmBridgeForTest(async () => ({
      text: "retry succeeded",
      provider: "anthropic",
      model: "gateway-agent-model",
    }));
    try {
      const res = (await tool("retry_task").execute(
        { task_id: sched.task_id },
        { dbPath },
      )) as { status: string };
      expect(res.status).toBe("completed");
    } finally {
      setLlmBridgeForTest(undefined);
    }
  });
});

describe("Tidegap OpenClaw plugin — reply_task and series (ui v2)", () => {
  let tmp: string;
  let dbPath: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "tidegap-plugin-v2-"));
    dbPath = join(tmp, "queue.db");
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("reply_task on a completed task creates a child with the parent link", async () => {
    const sched = (await tool("schedule_task").execute(
      { prompt: "summarize my inbox", deadline: deadlineISO(), region: "GB" },
      { dbPath },
    )) as { task_id: string };
    setLlmBridgeForTest(async () => ({
      text: "five mails",
      provider: "anthropic",
      model: "gateway-agent-model",
    }));
    try {
      await tool("expedite_task").execute({ task_id: sched.task_id }, { dbPath });
    } finally {
      setLlmBridgeForTest(undefined);
    }
    const res = (await tool("reply_task").execute(
      { task_id: sched.task_id, text: "which are urgent?" },
      { dbPath },
    )) as { task_id: string; parent_task_id: string };
    expect(res.parent_task_id).toBe(sched.task_id);
    const store = new TaskStore({ dbPath });
    const child = store.get(res.task_id)!;
    expect(child.parentTaskId).toBe(sched.task_id);
    expect(JSON.parse(child.bodyJson!).messages).toHaveLength(2);
    store.close();
  });

  it("reply_task on a cancelled task is refused", async () => {
    const sched = (await tool("schedule_task").execute(
      { prompt: "x", deadline: deadlineISO(), region: "GB" },
      { dbPath },
    )) as { task_id: string };
    await tool("cancel_task").execute({ task_id: sched.task_id }, { dbPath });
    await expect(
      tool("reply_task").execute({ task_id: sched.task_id, text: "y" }, { dbPath }),
    ).rejects.toThrow(/is cancelled; only completed provider-call tasks accept a reply/);
  });

  it("cancel_task with series: true ends a repeating task's series", async () => {
    const s = new Scheduler({ dbPath, feed: mockGridFeed(), signing: false });
    const rec = await s.enqueueProviderCall(
      { type: "provider_call", provider: "anthropic", model: "m", prompt: "weekly" },
      { deadline: deadlineISO(6), region: "GB", repeat: "weekly" },
    );
    s.shutdown();
    const res = (await tool("cancel_task").execute(
      { task_id: rec.taskId, series: true },
      { dbPath },
    )) as { status: string; series_ended: boolean };
    expect(res.status).toBe("cancelled");
    expect(res.series_ended).toBe(true);
    const store = new TaskStore({ dbPath });
    expect(store.get(rec.taskId)?.repeat).toBe("none");
    expect(store.get(`${rec.taskId}~2`)).toBeUndefined();
    store.close();
  });
});

describe("Tidegap OpenClaw plugin — dispatch adapters", () => {
  beforeEach(() => setLlmBridgeForTest(undefined));

  it("buildAdapters is empty when no provider credentials are configured", () => {
    expect(buildAdapters({})).toEqual({});
  });

  it("buildAdapters exposes an adapter per configured plugin-config credential", () => {
    const adapters = buildAdapters({
      anthropicApiKey: "sk-ant-test",
      openaiApiKey: "sk-openai-test",
    });
    expect(adapters.anthropic?.provider).toBe("anthropic");
    expect(adapters.openai?.provider).toBe("openai");
    expect(typeof adapters.anthropic?.dispatch).toBe("function");
  });

  it("builds a Gemini adapter from geminiApiKey, else googleApiKey", () => {
    expect(buildAdapters({ geminiApiKey: "g" }).gemini?.provider).toBe("gemini");
    expect(buildAdapters({ googleApiKey: "g" }).gemini?.provider).toBe("gemini");
    expect(buildAdapters({}).gemini).toBeUndefined();
  });

  it("builds an Ollama adapter only when ollamaHost is set", () => {
    expect(buildAdapters({ ollamaHost: "http://localhost:11434" }).ollama?.provider).toBe(
      "ollama",
    );
    expect(buildAdapters({}).ollama).toBeUndefined();
  });

  it("adds Gemini / Ollama alongside the bridge (they never ride the bridge)", () => {
    setLlmBridgeForTest(async () => ({ text: "" }));
    try {
      const adapters = buildAdapters({
        geminiApiKey: "g",
        ollamaHost: "http://localhost:11434",
      });
      // Bridge covers the two hosted providers…
      expect(adapters.anthropic?.provider).toBe("anthropic");
      expect(adapters.openai?.provider).toBe("openai");
      // …and Gemini / Ollama get their own direct adapters.
      expect(adapters.gemini?.provider).toBe("gemini");
      expect(adapters.ollama?.provider).toBe("ollama");
    } finally {
      setLlmBridgeForTest(undefined);
    }
  });
});

describe("Tidegap OpenClaw plugin — grid feed is built from plugin config", () => {
  it("get_grid_forecast uses the eiaApiKey from plugin config, never the environment", async () => {
    // TIDEGAP_EIA_API_KEY is exported but must be ignored; the eiaApiKey config
    // field is what reaches the EIA endpoint.
    const savedEnv = process.env.TIDEGAP_EIA_API_KEY;
    process.env.TIDEGAP_EIA_API_KEY = "leaked-env-key";
    const realFetch = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url));
      throw new Error("blocked in test");
    }) as unknown as typeof fetch;
    try {
      const res = (await tool("get_grid_forecast").execute(
        { region: "US-CAL-CISO", hours: 3 },
        { eiaApiKey: "cfg-eia-key" },
      )) as { source: string };
      // The feed degrades to mock because the request was blocked — the point
      // is WHICH credential it tried to use.
      expect(res.source).toBe("mock");
      expect(urls.some((u) => u.includes("cfg-eia-key"))).toBe(true);
      expect(urls.some((u) => u.includes("leaked-env-key"))).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
      if (savedEnv === undefined) delete process.env.TIDEGAP_EIA_API_KEY;
      else process.env.TIDEGAP_EIA_API_KEY = savedEnv;
    }
  });

  it("with no grid credentials configured, US zones fall back to the mock feed", async () => {
    const res = (await tool("get_grid_forecast").execute(
      { region: "US-CAL-CISO", hours: 3 },
      {},
    )) as { source: string; forecast: unknown[] };
    expect(res.source).toBe("mock");
  });
});

describe("Tidegap OpenClaw plugin — provider inference", () => {
  beforeEach(() => setLlmBridgeForTest(undefined));

  it("infers openai from gpt-* and o<n>* models, anthropic from claude-*", () => {
    expect(inferProvider("gpt-4o")).toBe("openai");
    expect(inferProvider("gpt-5.5")).toBe("openai");
    expect(inferProvider("o3-mini")).toBe("openai");
    expect(inferProvider("o1")).toBe("openai");
    expect(inferProvider("claude-sonnet-4-6")).toBe("anthropic");
    expect(inferProvider("claude-opus-4-1")).toBe("anthropic");
  });

  it("infers gemini from gemini-* models", () => {
    expect(inferProvider("gemini-2.0-flash")).toBe("gemini");
    expect(inferProvider("gemini-1.5-pro")).toBe("gemini");
    expect(inferProvider("  GEMINI-2.0-FLASH  ")).toBe("gemini"); // trim + case
  });

  it("infers ollama only for models in the ollamaModels allow-list", () => {
    const cfg = { ollamaModels: "llama3.1, mistral , qwen2.5" };
    expect(inferProvider("llama3.1", cfg)).toBe("ollama");
    expect(inferProvider("MISTRAL", cfg)).toBe("ollama"); // case-insensitive
    // Not listed → falls through to the anthropic default (not ollama).
    expect(inferProvider("phi3", cfg)).toBe("anthropic");
    // No allow-list → an ollama model is NOT inferred (explicit provider only).
    expect(inferProvider("llama3.1", {})).toBe("anthropic");
  });

  it("defaults unknown / empty models to anthropic", () => {
    expect(inferProvider(undefined)).toBe("anthropic");
    expect(inferProvider("")).toBe("anthropic");
    expect(inferProvider("some-random-model")).toBe("anthropic");
    expect(inferProvider("  GPT-4O  ")).toBe("openai"); // trim + case-insensitive
  });

  it("availableProviders reflects plugin config, and both hosted providers under the bridge", () => {
    expect([...availableProviders({})]).toEqual([]);
    expect([...availableProviders({ anthropicApiKey: "k" })]).toEqual(["anthropic"]);
    expect(
      [...availableProviders({ openaiApiKey: "k" })].sort(),
    ).toEqual(["openai"]);
    // Gemini / Ollama are available from their own config, bridge or not.
    expect([...availableProviders({ geminiApiKey: "k" })]).toEqual(["gemini"]);
    expect([...availableProviders({ googleApiKey: "k" })]).toEqual(["gemini"]);
    expect([...availableProviders({ ollamaHost: "http://localhost:11434" })]).toEqual([
      "ollama",
    ]);
    setLlmBridgeForTest(async () => ({ text: "" }));
    try {
      // With the bridge captured, both hosted providers are dispatchable;
      // Gemini / Ollama still require their own config.
      expect([...availableProviders({})].sort()).toEqual(["anthropic", "openai"]);
      expect(
        [...availableProviders({ ollamaHost: "http://localhost:11434" })].sort(),
      ).toEqual(["anthropic", "ollama", "openai"]);
    } finally {
      setLlmBridgeForTest(undefined);
    }
  });
});

describe("Tidegap OpenClaw plugin — schedule_task provider param", () => {
  let tmp: string;
  let dbPath: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "tidegap-provider-test-"));
    dbPath = join(tmp, "queue.db");
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  beforeEach(() => setLlmBridgeForTest(undefined));

  it("infers provider from model and records provider_source", async () => {
    // Bridge present so the api-key rejection path is not triggered.
    setLlmBridgeForTest(async () => ({ text: "" }));
    try {
      const gpt = (await tool("schedule_task").execute(
        { prompt: "p", deadline: deadlineISO(), region: "GB", model: "gpt-4o" },
        { dbPath },
      )) as { provider: string; provider_source: string; model: string };
      expect(gpt.provider).toBe("openai");
      expect(gpt.provider_source).toBe("inferred");
      expect(gpt.model).toBe("gpt-4o");

      const claude = (await tool("schedule_task").execute(
        { prompt: "p", deadline: deadlineISO(), region: "GB", model: "claude-opus-4-1" },
        { dbPath },
      )) as { provider: string };
      expect(claude.provider).toBe("anthropic");

      // No model → default anthropic + flagship model.
      const dflt = (await tool("schedule_task").execute(
        { prompt: "p", deadline: deadlineISO(), region: "GB" },
        { dbPath },
      )) as { provider: string; model: string };
      expect(dflt.provider).toBe("anthropic");
      expect(dflt.model).toBe("claude-sonnet-5");
    } finally {
      setLlmBridgeForTest(undefined);
    }
  });

  it("infers gemini from a gemini-* model and defaults each provider's model", async () => {
    setLlmBridgeForTest(async () => ({ text: "" }));
    try {
      const gem = (await tool("schedule_task").execute(
        { prompt: "p", deadline: deadlineISO(), region: "GB", model: "gemini-1.5-pro" },
        { dbPath },
      )) as { provider: string; provider_source: string; model: string };
      expect(gem.provider).toBe("gemini");
      expect(gem.provider_source).toBe("inferred");
      expect(gem.model).toBe("gemini-1.5-pro");

      // Explicit ollama with no model → default ollama flagship model.
      const oll = (await tool("schedule_task").execute(
        { prompt: "p", deadline: deadlineISO(), region: "GB", provider: "ollama" },
        { dbPath },
      )) as { provider: string; provider_source: string; model: string };
      expect(oll.provider).toBe("ollama");
      expect(oll.provider_source).toBe("flag");
      expect(oll.model).toBe("llama3.1");
    } finally {
      setLlmBridgeForTest(undefined);
    }
  });

  it.each([
    ["anthropic", "claude-sonnet-5"],
    ["openai", "gpt-6-sol"],
    ["gemini", "gemini-3.8-flash"],
    ["ollama", "llama3.1"],
  ] as const)("an explicit %s provider with no model defaults to %s", async (provider, expected) => {
    setLlmBridgeForTest(async () => ({ text: "" }));
    try {
      const rec = (await tool("schedule_task").execute(
        { prompt: "p", deadline: deadlineISO(), region: "GB", provider },
        { dbPath },
      )) as { provider: string; model: string };
      expect(rec.provider).toBe(provider);
      expect(rec.model).toBe(expected);
    } finally {
      setLlmBridgeForTest(undefined);
    }
  });

  it("explicit provider wins over model inference", async () => {
    setLlmBridgeForTest(async () => ({ text: "" }));
    try {
      const res = (await tool("schedule_task").execute(
        {
          prompt: "p",
          deadline: deadlineISO(),
          region: "GB",
          model: "gpt-4o",
          provider: "anthropic",
        },
        { dbPath },
      )) as { provider: string; provider_source: string };
      expect(res.provider).toBe("anthropic");
      expect(res.provider_source).toBe("flag");
    } finally {
      setLlmBridgeForTest(undefined);
    }
  });

  it("rejects at schedule time when the api-key path lacks the chosen provider's credential", async () => {
    // No bridge, only an anthropicApiKey in PLUGIN CONFIG → an openai (gpt)
    // task must be rejected rather than queued to fail (or POSTed to the wrong
    // provider) at dispatch. Credentials come from plugin config, never the
    // environment.
    setLlmBridgeForTest(undefined);
    const config = { dbPath, anthropicApiKey: "sk-ant-test" };
    await expect(
      tool("schedule_task").execute(
        { prompt: "p", deadline: deadlineISO(), region: "GB", model: "gpt-4o" },
        config,
      ),
    ).rejects.toThrow(/openaiApiKey/);

    // An anthropic task with the anthropic credential set is accepted.
    const ok = (await tool("schedule_task").execute(
      { prompt: "p", deadline: deadlineISO(), region: "GB", model: "claude-sonnet-4-6" },
      config,
    )) as { provider: string; dispatch: string };
    expect(ok.provider).toBe("anthropic");
    expect(ok.dispatch).toBe("api-key");
  });

  it("ignores provider credentials present in the ambient environment", async () => {
    // The whole point of the 0.14.2 refactor: an ANTHROPIC_API_KEY exported by
    // the gateway process must have NO effect on the plugin, because the
    // plugin never reads the environment. With no plugin config, dispatch is
    // "unconfigured" and a gpt task is still rejected.
    setLlmBridgeForTest(undefined);
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-from-env";
    try {
      await expect(
        tool("schedule_task").execute(
          { prompt: "p", deadline: deadlineISO(), region: "GB", model: "gpt-4o" },
          { dbPath },
        ),
      ).resolves.toMatchObject({ dispatch: "unconfigured" });
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });

  it("surfaces the SYNTHETIC (mock) grid note when the feed is mock", async () => {
    setLlmBridgeForTest(async () => ({ text: "" }));
    try {
      const res = (await tool("schedule_task").execute(
        { prompt: "p", deadline: deadlineISO(), region: "GB" },
        { dbPath },
      )) as { grid_source?: string; synthetic_grid_data?: string };
      // The default grid feed with no live keys is the deterministic mock.
      if (res.grid_source === "mock") {
        expect(res.synthetic_grid_data).toMatch(/SYNTHETIC \(mock\)/);
      }
      expect(res.grid_source).toBeTruthy();
    } finally {
      setLlmBridgeForTest(undefined);
    }
  });
});

describe("Tidegap OpenClaw plugin — submitted-status rendering", () => {
  let tmp: string;
  let dbPath: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "tidegap-submitted-test-"));
    dbPath = join(tmp, "queue.db");
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  beforeEach(() => setLlmBridgeForTest(undefined));

  it("renders a 'submitted' task with its batch_id in the queue list", async () => {
    setLlmBridgeForTest(async () => ({ text: "" }));
    let taskId: string;
    try {
      const sched = (await tool("schedule_task").execute(
        { prompt: "batch me", deadline: deadlineISO(48), region: "GB" },
        { dbPath },
      )) as { task_id: string };
      taskId = sched.task_id;
    } finally {
      setLlmBridgeForTest(undefined);
    }

    // Simulate the core's batch routing: flip the row to "submitted" + batch_id.
    const store = new TaskStore({ dbPath });
    const rec = store.get(taskId);
    if (!rec) throw new Error("task was not persisted");
    rec.status = "submitted";
    rec.batchId = "batch_abc123";
    store.upsert(rec);
    // Does the linked core build actually round-trip batchId through SQLite?
    // (v0.12 core persists it; an older build silently drops the column.) Only
    // assert the plugin surfaces it when core supports it — the plugin's own
    // rendering (show batch_id when present) is what we're pinning here.
    const coreRoundTripsBatchId = store.get(taskId)?.batchId === "batch_abc123";
    store.close();

    const list = (await tool("check_queue_status").execute({}, { dbPath })) as {
      tasks: Array<{ task_id: string; status: string; batch_id?: string }>;
    };
    const row = list.tasks.find((t) => t.task_id === taskId);
    expect(row?.status).toBe("submitted");
    if (coreRoundTripsBatchId) {
      expect(row?.batch_id).toBe("batch_abc123");
    }
  });

  it("expedite_task surfaces the scheduler's rejection message cleanly", async () => {
    // A running task cannot be expedited; the core throws, and the plugin must
    // relay that message rather than a generic failure. (Mirrors how a
    // 'submitted' task is rejected once the core enforces it.)
    const store = new TaskStore({ dbPath });
    const rec = {
      taskId: "t-running-guard",
      status: "running" as const,
      enqueuedAt: new Date().toISOString(),
      region: "GB",
      bodyJson: JSON.stringify({
        type: "provider_call",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        prompt: "x",
      }),
    };
    store.upsert(rec);
    store.close();

    await expect(
      tool("expedite_task").execute({ task_id: "t-running-guard" }, { dbPath }),
    ).rejects.toThrow(/expedite_task could not run task t-running-guard/);
  });
});

describe("Tidegap OpenClaw plugin — runDispatchTick skips provider-less tasks", () => {
  let tmp: string;
  let dbPath: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "tidegap-skip-test-"));
    dbPath = join(tmp, "queue.db");
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  beforeEach(() => setLlmBridgeForTest(undefined));

  it("leaves an overdue task 'scheduled' (not failed) when no adapter serves its provider", async () => {
    setLlmBridgeForTest(async () => ({ text: "" }));
    let taskId: string;
    try {
      const sched = (await tool("schedule_task").execute(
        { prompt: "no adapter yet", deadline: deadlineISO(), region: "GB" },
        { dbPath },
      )) as { task_id: string };
      taskId = sched.task_id;
    } finally {
      setLlmBridgeForTest(undefined);
    }

    // Force the window into the past so the task is due.
    const store = new TaskStore({ dbPath });
    const rec = store.get(taskId);
    if (!rec) throw new Error("task was not persisted");
    rec.status = "scheduled";
    rec.scheduledFor = new Date(Date.now() - 60_000).toISOString();
    store.upsert(rec);
    store.close();

    // No bridge, empty adapters → the provider has no adapter. The task must
    // be SKIPPED (left scheduled), not failed.
    const result = await runDispatchTick({ dbPath }, {});
    expect(result.failed).toBe(0);
    expect(result.results.every((r) => r.taskId !== taskId)).toBe(true);

    const after = (await tool("check_queue_status").execute(
      { task_id: taskId },
      { dbPath },
    )) as { status: string };
    expect(after.status).toBe("scheduled");
  });
});

describe("Tidegap OpenClaw plugin — startup dispatcher bootstrap", () => {
  it("bootstrapDispatcherOnStartup is exported and idempotent, and honours the disable flag", () => {
    // The suite's setup file calls suppressStartupDispatch(), so the
    // module-load call's deferred queue-open is a no-op. Calling it directly
    // must not throw and must be idempotent (guarded so a second call is a
    // no-op). The opt-out is now the `disableStartupDispatch` PLUGIN CONFIG
    // field — the old EBB_DISABLE_STARTUP_DISPATCH environment variable is
    // gone, because the bundle reads no environment variables at all.
    expect(typeof bootstrapDispatcherOnStartup).toBe("function");
    expect(() => bootstrapDispatcherOnStartup({ disableStartupDispatch: true })).not.toThrow();
    expect(() => bootstrapDispatcherOnStartup({})).not.toThrow();
  });
});

describe("Tidegap OpenClaw plugin — result delivery", () => {
  const completedTask = {
    taskId: "t-deliver",
    status: "completed",
    region: "GB",
    enqueuedAt: "2026-05-21T00:00:00Z",
    completedAt: "2026-05-21T03:00:00Z",
    result: { text: "the deferred answer" },
    receipt: {
      taskId: "t-deliver",
      ranAt: "2026-05-21T03:00:00Z",
      region: "GB",
      estimatedCarbonGCo2: 42,
      provider: "openai",
      model: "gpt-5.5",
      durationMs: 1200,
      prompt: "x",
    },
  } as unknown as Parameters<typeof formatReport>[0];

  it("scanDeliveryOptions reflects whether a chat channel is configured", () => {
    const withTg = scanDeliveryOptions({
      channels: { telegram: { enabled: true, botToken: "x", allowFrom: ["1"] } },
    });
    expect(withTg.find((o) => o.mode === "chat")?.available).toBe(true);
    const without = scanDeliveryOptions({});
    expect(without.find((o) => o.mode === "chat")?.available).toBe(false);
    expect(without.find((o) => o.mode === "webhook")?.available).toBe(true);
  });

  it("validateDeliveryConfig requires a target for webhook and file", () => {
    expect(validateDeliveryConfig({ modes: ["webhook"] })).toMatch(/webhook_url/);
    expect(validateDeliveryConfig({ modes: ["file"] })).toMatch(/file_path/);
    expect(validateDeliveryConfig({ modes: [] })).toMatch(/at least one/);
    expect(validateDeliveryConfig({ modes: ["chat"] })).toBeNull();
  });

  it("formatReport renders md / html / json", () => {
    expect(formatReport(completedTask, "md")).toContain("the deferred answer");
    expect(formatReport(completedTask, "html")).toContain("<html");
    const json = JSON.parse(formatReport(completedTask, "json")) as {
      result: string;
    };
    expect(json.result).toBe("the deferred answer");
  });

  it("deliverResult writes a file and POSTs a webhook", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tidegap-deliver-"));
    const filePath = join(dir, "report.md");
    let posted: { task_id?: string } | undefined;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      posted = JSON.parse(init.body) as { task_id?: string };
      return { ok: true, status: 200 } as Response;
    }) as unknown as typeof fetch;
    try {
      const outcomes = await deliverResult(
        completedTask,
        {
          modes: ["file", "webhook", "queue"],
          filePath,
          webhookUrl: "https://example.test/hook",
          format: "md",
        },
        {},
      );
      expect(outcomes.every((o) => o.ok)).toBe(true);
      expect(readFileSync(filePath, "utf8")).toContain("the deferred answer");
      expect(posted?.task_id).toBe("t-deliver");
    } finally {
      globalThis.fetch = realFetch;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("setDeliveryConfig / getDeliveryConfig round-trip via the sidecar", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tidegap-sidecar-"));
    setDeliveryStorePath(join(dir, "delivery.db"));
    try {
      await setDeliveryConfig("t-z", { modes: ["chat", "file"], filePath: "/tmp/r.md" });
      expect((await getDeliveryConfig("t-z", true)).modes).toEqual(["chat", "file"]);
      // an unknown task falls back to the chat default
      expect((await getDeliveryConfig("t-unknown", true)).modes).toEqual(["chat"]);
    } finally {
      setDeliveryStorePath(undefined);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recordDeliveryOutcomes persists per-mode outcomes for later audit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tidegap-outcomes-"));
    setDeliveryStorePath(join(dir, "delivery.db"));
    try {
      await recordDeliveryOutcomes("t-o", { modes: ["chat", "webhook"] }, [
        { mode: "chat", ok: true, detail: "Telegram DM → 1" },
        { mode: "webhook", ok: false, detail: "HTTP 500" },
      ]);
      const rec = await readDeliveryRecord("t-o");
      expect(rec?.deliveredAt).toBeTruthy();
      expect(rec?.outcomes?.find((o) => o.mode === "chat")?.ok).toBe(true);
      expect(rec?.outcomes?.find((o) => o.mode === "webhook")?.ok).toBe(false);
      expect(await readDeliveryRecord("t-none")).toBeUndefined();
    } finally {
      setDeliveryStorePath(undefined);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── OS-notification delivery (ROADMAP item 7) ──────────────────────────────

  it("scanDeliveryOptions advertises the os mode", () => {
    const opts = scanDeliveryOptions({});
    const os = opts.find((o) => o.mode === "os");
    expect(os).toBeDefined();
    // On the CI/dev host (darwin/linux/win32) os is supported.
    expect(typeof os?.available).toBe("boolean");
  });

  it("osNotifyCommand builds the correct binary + args per platform", () => {
    const title = "Tidegap — task t-1 complete";
    const body = 'line "one"\n42 gCO2e';

    const mac = osNotifyCommand("darwin", title, body)!;
    expect(mac.cmd).toBe("osascript");
    // AppleScript: a fixed script; the text arrives as argv after --.
    expect(mac.args.slice(-3)).toEqual(["--", title, body]);

    const linux = osNotifyCommand("linux", title, body)!;
    expect(linux.cmd).toBe("notify-send");
    expect(linux.args).toEqual(["--", title, body]);

    const win = osNotifyCommand("win32", title, body)!;
    expect(win.cmd).toBe("powershell");
    expect(win.args).toContain("-Command");
    expect(win.args[win.args.length - 1]).toContain("ToastNotification");

    // Unsupported platform → null (caller records an honest failure).
    expect(osNotifyCommand("aix" as NodeJS.Platform, title, body)).toBeNull();
  });

  it("notificationContent truncates, redacts secrets, and includes grams", () => {
    const task = {
      ...completedTask,
      taskId: "t-notify",
      result: { text: `secret sk-ant-${"a".repeat(30)} then ${"x".repeat(300)}` },
    } as unknown as Parameters<typeof formatReport>[0];
    const { title, body } = notificationContent(task);
    expect(title).toContain("t-notify");
    expect(body).not.toContain("sk-ant-");
    expect(body).toContain("[REDACTED]");
    expect(body).toContain("gCO2e");
    // preview is truncated with an ellipsis
    expect(body).toContain("…");
  });

  it("deliverResult os mode succeeds via a mocked spawn (exit 0)", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    __setSpawnForTest(((cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("close", 0));
      return child;
    }) as never);
    try {
      const outcomes = await deliverResult(completedTask, { modes: ["os"] }, {});
      expect(outcomes[0].mode).toBe("os");
      expect(outcomes[0].ok).toBe(true);
      expect(calls.length).toBe(1);
    } finally {
      __setSpawnForTest(undefined);
    }
  });

  it("deliverResult os mode spawns nothing when disableOsNotifications is on", async () => {
    const calls: string[] = [];
    __setSpawnForTest(((cmd: string) => {
      calls.push(cmd);
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("close", 0));
      return child;
    }) as never);
    setOsNotificationsDisabled(true);
    try {
      const outcomes = await deliverResult(completedTask, { modes: ["os"] }, {});
      expect(outcomes[0]).toMatchObject({ mode: "os", ok: false });
      expect(outcomes[0].detail).toMatch(/disableOsNotifications/);
      expect(calls).toEqual([]);
    } finally {
      setOsNotificationsDisabled(false);
      __setSpawnForTest(undefined);
    }
  });

  it("deliverResult os mode records an honest failure when the binary is missing", async () => {
    __setSpawnForTest((() => {
      const child = new EventEmitter();
      queueMicrotask(() => {
        const err = new Error("spawn notify-send ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        child.emit("error", err);
      });
      return child;
    }) as never);
    try {
      const outcomes = await deliverResult(completedTask, { modes: ["os"] }, {});
      expect(outcomes[0].mode).toBe("os");
      expect(outcomes[0].ok).toBe(false);
      expect(outcomes[0].detail).toMatch(/not found/);
    } finally {
      __setSpawnForTest(undefined);
    }
  });

  // ── PDF delivery (ROADMAP item 8) ──────────────────────────────────────────

  it("deliverResult pdf renders the HTML report via a stubbed puppeteer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tidegap-pdf-"));
    const filePath = join(dir, "report.pdf");
    let setContentHtml: string | undefined;
    const pdfCalls: Array<{ path?: string }> = [];
    let closed = false;

    __setPuppeteerImportForTest(async () => ({
      // puppeteer's default export carries `launch`.
      default: {
        async launch() {
          return {
            async newPage() {
              return {
                async setContent(html: string) {
                  setContentHtml = html;
                },
                async pdf(opts: { path: string }) {
                  pdfCalls.push(opts);
                  // Emulate puppeteer writing the file to `path`.
                  writeFileSync(opts.path, "%PDF-1.4 stub");
                },
              };
            },
            async close() {
              closed = true;
            },
          };
        },
      },
    }));
    try {
      const outcomes = await deliverResult(
        completedTask,
        { modes: ["file"], filePath, format: "pdf" },
        {},
      );
      expect(outcomes[0].mode).toBe("file");
      expect(outcomes[0].ok).toBe(true);
      expect(outcomes[0].detail).toContain(filePath);
      // The HTML report template was fed to puppeteer, then rendered to PDF.
      expect(setContentHtml).toContain("<html");
      expect(setContentHtml).toContain("the deferred answer");
      expect(pdfCalls[0]?.path).toBe(filePath);
      expect(readFileSync(filePath, "utf8")).toContain("%PDF");
      expect(closed).toBe(true);
    } finally {
      __setPuppeteerImportForTest(undefined);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("deliverResult pdf records an actionable failure when puppeteer is absent", async () => {
    __setPuppeteerImportForTest(async () => {
      const err = new Error(
        "Cannot find package 'puppeteer'",
      ) as NodeJS.ErrnoException;
      err.code = "ERR_MODULE_NOT_FOUND";
      throw err;
    });
    try {
      const outcomes = await deliverResult(
        completedTask,
        { modes: ["file"], filePath: "/tmp/tidegap-should-not-exist.pdf", format: "pdf" },
        {},
      );
      expect(outcomes[0].mode).toBe("file");
      expect(outcomes[0].ok).toBe(false);
      expect(outcomes[0].detail).toMatch(/puppeteer/);
      expect(outcomes[0].detail).toMatch(/npm install puppeteer/);
      expect(outcomes[0].detail).toMatch(/kept in the queue/);
    } finally {
      __setPuppeteerImportForTest(undefined);
    }
  });
});

describe("Tidegap OpenClaw plugin — task visibility (v0.17)", () => {
  let tmp: string;
  let dbPath: string;
  let savedHome: string | undefined;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "tidegap-visibility-test-"));
    dbPath = join(tmp, "queue.db");
    // The pre-tick quota sweep reads ~/.tidegap/config; point HOME at a
    // temp dir so the test controls that file.
    savedHome = process.env.HOME;
    process.env.HOME = tmp;
  });
  afterAll(() => {
    process.env.HOME = savedHome;
    rmSync(tmp, { recursive: true, force: true });
  });
  beforeEach(() => setLlmBridgeForTest(undefined));

  it("schedule_task stores origin_host 'openclaw' and a title", async () => {
    setLlmBridgeForTest(async () => ({ text: "" }));
    let taskId: string;
    try {
      const sched = (await tool("schedule_task").execute(
        // DE: no ENTSO-E token in tests, so the feed uses the mock curve
        // and the test makes no network call.
        { prompt: "Nightly digest\nwith details", deadline: deadlineISO(), region: "DE" },
        { dbPath },
      )) as { task_id: string };
      taskId = sched.task_id;
    } finally {
      setLlmBridgeForTest(undefined);
    }
    const store = new TaskStore({ dbPath });
    expect(store.get(taskId)!.originHost).toBe("openclaw");
    expect(store.get(taskId)!.title).toBe("Nightly digest");
    store.close();
  });

  it("the dispatch loop re-resolves a quota task whose reset passed instead of dispatching it (AE9)", async () => {
    // A weekly reset that happened one hour ago (UTC), margin 2 h.
    const now = Date.now();
    const prevReset = new Date(Math.floor((now - 3_600_000) / 60_000) * 60_000);
    const day = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][prevReset.getUTCDay()];
    const hhmm = prevReset.toISOString().slice(11, 16);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(tmp, ".tidegap"), { recursive: true });
    writeFileSync(
      join(tmp, ".tidegap", "config"),
      `TIDEGAP_QUOTA_RESET_CLAUDE=${day} ${hhmm} UTC\nTIDEGAP_QUOTA_MARGIN_H_CLAUDE=2\n`,
    );
    const store = new TaskStore({ dbPath });
    store.upsert({
      taskId: "quota-ae9",
      status: "scheduled",
      enqueuedAt: new Date(now - 3 * 86_400_000).toISOString(),
      scheduledFor: new Date(now - 4 * 3_600_000).toISOString(),
      // DE: no ENTSO-E token in tests, so the feed falls back to the mock
      // curve and the reschedule makes no network call.
      region: "DE",
      bodyJson: JSON.stringify({
        type: "provider_call",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        prompt: "weekly sweep",
      }),
      deadline: new Date(prevReset.getTime() - 2 * 3_600_000).toISOString(),
      deadlineKind: "quota_reset",
      quotaProvider: "claude",
    });

    const dispatched: string[] = [];
    const stub = {
      provider: "anthropic" as const,
      ready: true,
      async dispatch(model: string, prompt: string) {
        dispatched.push(prompt);
        return { text: "ok", model, provider: "anthropic", raw: {} };
      },
    };
    await runDispatchTick({ dbPath }, { anthropic: stub });

    const row = store.get("quota-ae9")!;
    const expectedDeadline = prevReset.getTime() + 7 * 86_400_000 - 2 * 3_600_000;
    expect(row.deadline).toBe(new Date(expectedDeadline).toISOString());
    expect(row.deadlineKind).toBe("quota_reset");
    // Rescheduled through the window picker: dispatched only if the picker
    // chose the current hour, never against the stale deadline.
    // The ledger is shared with the schedule_task test above; the mock
    // curve can put its task in the current hour (02:xx UTC), and this
    // tick then runs it. Only this test's task matters here.
    if (row.status === "scheduled") {
      expect(Date.parse(row.scheduledFor!)).toBeGreaterThan(now - 3_600_000);
      expect(dispatched).not.toContain("weekly sweep");
    }
    expect(store.getMeta("last_tick_at")).toBeDefined();
    store.close();
  });

  it("check_queue_status marks a viewed finished task read and reports last_tick_at", async () => {
    const store = new TaskStore({ dbPath });
    store.upsert({
      taskId: "done-v",
      status: "completed",
      enqueuedAt: "2026-10-10T00:00:00.000Z",
      completedAt: "2026-10-10T01:00:00.000Z",
      region: "GB",
      title: "Done task",
      result: { text: "answer" },
    });
    const list = (await tool("check_queue_status").execute({}, { dbPath })) as {
      last_tick_at: string | null;
      tasks: Array<{ task_id: string; title: string | null }>;
    };
    expect(list.tasks.find((t) => t.task_id === "done-v")?.title).toBe("Done task");
    expect("last_tick_at" in list).toBe(true);
    expect(store.get("done-v")!.readAt).toBeUndefined();
    const one = (await tool("check_queue_status").execute(
      { task_id: "done-v" },
      { dbPath },
    )) as { readAt?: string; title?: string };
    expect(one.title).toBe("Done task");
    expect(one.readAt).toBeDefined();
    expect(store.get("done-v")!.readAt).toBeDefined();
    store.close();
  });

  it("check_queue_status shows the stored prompt without control characters", async () => {
    const store = new TaskStore({ dbPath });
    store.upsert({
      taskId: "queued-p",
      status: "scheduled",
      enqueuedAt: new Date().toISOString(),
      region: "DE",
      bodyJson: JSON.stringify({
        type: "provider_call",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        prompt: "Line one\n\u001b[31mred\u001b[0m",
      }),
    });
    store.close();
    const one = (await tool("check_queue_status").execute(
      { task_id: "queued-p" },
      { dbPath },
    )) as { prompt?: string; bodyJson?: string };
    expect(one.prompt).toBe("Line one\n[31mred[0m");
    expect(one.bodyJson).toBeUndefined();
  });

  it("update_deadline turns a quota_reset task into an absolute one", async () => {
    const store = new TaskStore({ dbPath });
    store.upsert({
      taskId: "quota-move",
      status: "scheduled",
      enqueuedAt: new Date().toISOString(),
      scheduledFor: new Date(Date.now() + 3_600_000).toISOString(),
      region: "DE",
      bodyJson: JSON.stringify({
        type: "provider_call",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        prompt: "move me",
      }),
      deadline: deadlineISO(48),
      deadlineKind: "quota_reset",
      quotaProvider: "claude",
    });
    await tool("update_deadline").execute(
      { task_id: "quota-move", deadline: deadlineISO(12) },
      { dbPath },
    );
    const row = store.get("quota-move")!;
    expect(row.deadlineKind).toBe("absolute");
    expect(row.quotaProvider).toBeUndefined();
    store.close();
  });
});

describe("Tidegap OpenClaw plugin — jobs (schedule_task repeat)", () => {
  let tmp: string;
  let dbPath: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "tidegap-plugin-jobs-"));
    dbPath = join(tmp, "queue.db");
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  type JobReply = { job_id: string; guarantee: string; first_task_id: string; scheduled_for: string | null };

  it("repeat daily + window creates a prompt job whose first run is bounded by deadline", async () => {
    const res = (await tool("schedule_task").execute(
      { prompt: "nightly news digest", deadline: deadlineISO(30), repeat: "daily", window: "00:00-08:00", time_zone: "UTC" },
      { dbPath },
    )) as JobReply & { next_step: string };
    expect(res.job_id).toMatch(/^job-[0-9a-f]{8}$/);
    expect(res.guarantee).toBe("runs every day between 00:00 and 08:00");
    expect(res.first_task_id).toBe(`${res.job_id}~1`);
    expect(res.next_step).toContain("cancel_task series=true");
    const store = new TaskStore({ dbPath });
    const job = store.getJob(res.job_id)!;
    expect(job.originHost).toBe("openclaw");
    expect(job.template).toMatchObject({ runner: "prompt", prompt: "nightly news digest", tools: "none" });
    expect(store.get(res.first_task_id)!.jobId).toBe(res.job_id);
    store.close();
  });

  it.each(["command", "cmd", "shell", "script"])(
    "a %s argument is rejected with the tidegap jobs add sentence",
    async (key) => {
      await expect(
        tool("schedule_task").execute(
          { prompt: "logs", deadline: deadlineISO(), repeat: "daily", [key]: "ssh host tail" },
          { dbPath },
        ),
      ).rejects.toThrow(new RegExp(`cannot create command jobs \\(got "${key}"\\).*tidegap jobs add --command`));
    },
  );

  it("a command argument is rejected on a one-off call too", async () => {
    await expect(
      tool("schedule_task").execute({ prompt: "logs", deadline: deadlineISO(), command: "ssh host tail" }, { dbPath }),
    ).rejects.toThrow(/cannot create command jobs/);
  });

  it("every_n_hours needs every_hours; delivery options are rejected with a job", async () => {
    await expect(
      tool("schedule_task").execute({ prompt: "poll", deadline: deadlineISO(), repeat: "every_n_hours" }, { dbPath }),
    ).rejects.toThrow(/needs every_hours/);
    await expect(
      tool("schedule_task").execute(
        { prompt: "poll", deadline: deadlineISO(), repeat: "daily", deliver: ["chat"] },
        { dbPath },
      ),
    ).rejects.toThrow(/deliver cannot be used with a job repeat/);
  });

  it.each<[string, unknown]>([
    ["region", "GB"],
    ["carbon_budget_g", 5],
    ["candidates", ["anthropic:claude-sonnet-4-5"]],
    ["route_weights", { carbon: 1 }],
    ["deliver", ["chat"]],
    ["webhook_url", "https://example.com/hook"],
    ["file_path", "/tmp/report.md"],
    ["file_format", "md"],
  ])("per-task option %s is rejected by name with a job repeat", async (key, value) => {
    await expect(
      tool("schedule_task").execute({ prompt: "poll", deadline: deadlineISO(), repeat: "daily", [key]: value }, { dbPath }),
    ).rejects.toThrow(`${key} cannot be used with a job repeat`);
  });

  it("refuses region on a job with the same sentence as MCP", async () => {
    await expect(
      tool("schedule_task").execute({ prompt: "poll", deadline: deadlineISO(), repeat: "daily", region: "GB" }, { dbPath }),
    ).rejects.toThrow("schedule_task rejected: region cannot be used with a job repeat; omit it");
  });

  it("check_queue_status lists jobs; cancel_task skips a run, series=true ends the job", async () => {
    const res = (await tool("schedule_task").execute(
      { prompt: "weekly report", deadline: deadlineISO(30), repeat: "weekly", days: ["mon"] },
      { dbPath },
    )) as JobReply;
    const list = (await tool("check_queue_status").execute({}, { dbPath })) as {
      tasks: Array<{ task_id: string; job_id?: string }>;
      jobs: Array<{ job_id: string; guarantee: string; next_run: string | null; status: string }>;
    };
    const job = list.jobs.find((j) => j.job_id === res.job_id)!;
    expect(job.status).toBe("active");
    expect(job.guarantee).toBe("runs once every Mon, any time of day");
    expect(job.next_run).toBeTruthy();
    expect(list.tasks.find((t) => t.task_id === res.first_task_id)?.job_id).toBe(res.job_id);

    const skipped = (await tool("cancel_task").execute({ task_id: res.first_task_id }, { dbPath })) as {
      status: string;
      job_ended?: boolean;
    };
    expect(skipped.status).toBe("cancelled");
    expect(skipped.job_ended).toBeUndefined();
    let store = new TaskStore({ dbPath });
    expect(store.getJob(res.job_id)!.status).toBe("active");
    store.close();

    const ended = (await tool("cancel_task").execute({ task_id: res.first_task_id, series: true }, { dbPath })) as {
      job_id: string;
      job_ended: boolean;
    };
    expect(ended).toMatchObject({ job_id: res.job_id, job_ended: true });
    store = new TaskStore({ dbPath });
    expect(store.getJob(res.job_id)!.status).toBe("removed");
    store.close();
  });
});
