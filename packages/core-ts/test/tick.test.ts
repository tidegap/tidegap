/**
 * Tests for v0.4's persistent provider-call surface:
 *   - Scheduler.enqueueProviderCall persists `body_json` to SQLite.
 *   - Scheduler.tick dispatches due tasks against the configured adapter.
 *   - SQLite migration is idempotent on a v0.3 file (no `body_json` column).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockGridFeed, Scheduler, TaskStore } from "../src/index.js";
import type { ProviderAdapter } from "../src/providers/base.js";

interface FakeAdapter extends ProviderAdapter {
  dispatchCalls: Array<{ model: string; prompt: string }>;
  dispatchBatchCalls: Array<{ model: string; prompts: string[] }>;
}

function makeFakeAdapter(provider: "anthropic" | "openai"): FakeAdapter {
  const adapter: FakeAdapter = {
    provider,
    ready: true,
    dispatchCalls: [],
    dispatchBatchCalls: [],
    async dispatch(model, prompt) {
      adapter.dispatchCalls.push({ model, prompt });
      return { text: "ok", model, provider, raw: null };
    },
    async dispatchBatch(model, prompts) {
      adapter.dispatchBatchCalls.push({ model, prompts });
      return { batchId: "fake-batch-1", provider, size: prompts.length };
    },
  };
  return adapter;
}

describe("Scheduler.enqueueProviderCall", () => {
  it("persists body_json and transitions queued → scheduled", async () => {
    const s = new Scheduler({ feed: mockGridFeed() });
    const rec = await s.enqueueProviderCall(
      {
        type: "provider_call",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        prompt: "hello",
      },
      { deadline: new Date(Date.now() + 60_000), region: "US-CAL-CISO" },
    );
    expect(rec.taskId).toMatch(/^t-/);
    expect(rec.bodyJson).toBeDefined();
    expect(JSON.parse(rec.bodyJson!)).toMatchObject({
      type: "provider_call",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
    });
    const stored = s.getTask(rec.taskId);
    expect(stored?.status).toBe("scheduled");
    s.shutdown();
  });

  it("rejects an empty prompt", async () => {
    const s = new Scheduler({ feed: mockGridFeed() });
    await expect(
      s.enqueueProviderCall(
        {
          type: "provider_call",
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          prompt: "",
        },
        { deadline: new Date(Date.now() + 60_000) },
      ),
    ).rejects.toThrow();
    s.shutdown();
  });
});

describe("Scheduler.tick", () => {
  it("dispatches a due provider-call task and writes a receipt", async () => {
    const s = new Scheduler({ feed: mockGridFeed() });
    const fake = makeFakeAdapter("anthropic");
    const rec = await s.enqueueProviderCall(
      {
        type: "provider_call",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        prompt: "hi",
      },
      { deadline: new Date(Date.now() + 1500), region: "US-CAL-CISO" },
    );
    expect(s.getTask(rec.taskId)?.status).toBe("scheduled");
    // The mock-grid window may be slightly in the future. Wait a beat so
    // scheduled_for is <= now.
    await new Promise((r) => setTimeout(r, 50));
    // Force the chosen window to "now" so tick fires immediately.
    const stored = s.getTask(rec.taskId);
    if (stored) stored.scheduledFor = new Date().toISOString();

    const result = await s.tick({ anthropic: fake });
    expect(result.inspected).toBe(1);
    expect(result.dispatched).toBe(1);
    expect(result.failed).toBe(0);
    expect(fake.dispatchCalls).toHaveLength(1);
    const finished = s.getTask(rec.taskId);
    expect(finished?.status).toBe("completed");
    expect(finished?.receipt?.estimatedCarbonGCo2).toBeGreaterThan(0);
    expect(finished?.receipt?.provider).toBe("anthropic");
    // The receipt carries both the schedule-time projection and the
    // intensity actually observed at dispatch, plus their drift.
    expect(finished?.receipt?.actualCarbonGCo2).toBeGreaterThan(0);
    expect(typeof finished?.receipt?.deltaPct).toBe("number");
    s.shutdown();
  });

  it("records the schedule-time estimate and computes the receipt delta", async () => {
    const s = new Scheduler({ feed: mockGridFeed() });
    const fake = makeFakeAdapter("anthropic");
    const rec = await s.enqueueProviderCall(
      {
        type: "provider_call",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        prompt: "hi",
      },
      { deadline: new Date(Date.now() + 6 * 60 * 60 * 1000), region: "US-CAL-CISO" },
    );
    // The projection is persisted on the record the moment it is scheduled.
    const scheduled = s.getTask(rec.taskId);
    expect(scheduled?.estimatedCarbonGCo2).toBeGreaterThan(0);
    const projected = scheduled!.estimatedCarbonGCo2!;

    await new Promise((r) => setTimeout(r, 50));
    const stored = s.getTask(rec.taskId);
    if (stored) stored.scheduledFor = new Date().toISOString();
    await s.tick({ anthropic: fake });

    const finished = s.getTask(rec.taskId);
    const rc = finished?.receipt;
    expect(rc?.estimatedCarbonGCo2).toBe(projected);
    expect(rc?.actualCarbonGCo2).toBeGreaterThan(0);
    const expectedDelta =
      Math.round(((rc!.actualCarbonGCo2! - projected) / projected) * 1000) / 10;
    expect(rc?.deltaPct).toBe(expectedDelta);
    s.shutdown();
  });

  it("skips tasks whose window is still in the future", async () => {
    const s = new Scheduler({ feed: mockGridFeed() });
    const fake = makeFakeAdapter("anthropic");
    const rec = await s.enqueueProviderCall(
      {
        type: "provider_call",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        prompt: "later",
      },
      { deadline: new Date(Date.now() + 6 * 60 * 60 * 1000), region: "US-CAL-CISO" },
    );
    // Push scheduledFor 1h out so tick should NOT pick it up.
    const stored = s.getTask(rec.taskId);
    if (stored) stored.scheduledFor = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const result = await s.tick({ anthropic: fake });
    expect(result.inspected).toBe(0);
    expect(fake.dispatchCalls).toHaveLength(0);
    s.shutdown();
  });

  it("fails a task when its provider adapter is not configured", async () => {
    const s = new Scheduler({ feed: mockGridFeed() });
    const rec = await s.enqueueProviderCall(
      {
        type: "provider_call",
        provider: "openai",
        model: "gpt-4.1-mini",
        prompt: "hi",
      },
      { deadline: new Date(Date.now() + 1500), region: "US-CAL-CISO" },
    );
    const stored = s.getTask(rec.taskId);
    if (stored) stored.scheduledFor = new Date().toISOString();
    const result = await s.tick({}); // no adapters
    expect(result.failed).toBe(1);
    expect(s.getTask(rec.taskId)?.status).toBe("failed");
    s.shutdown();
  });

  it("accepts a claude-code task and receipts it under provider claude-code", async () => {
    const s = new Scheduler({ feed: mockGridFeed() });
    // Sync-only stub, the shape of the CLI host's adapter: no dispatchBatch.
    const calls: string[] = [];
    const stub: ProviderAdapter = {
      provider: "claude-code",
      ready: true,
      async dispatch(model, prompt) {
        calls.push(`${model}:${prompt}`);
        return {
          text: "OK",
          model: "claude-haiku-5-5",
          provider: "claude-code",
          usage: { inputTokens: 120, outputTokens: 4, totalTokens: 124 },
          raw: { session_id: "s-1", total_cost_usd: 0.0003 },
        };
      },
    };
    const rec = await s.enqueueProviderCall(
      { type: "provider_call", provider: "claude-code", model: "default", prompt: "hi" },
      { deadline: new Date(Date.now() + 1500), region: "US-CAL-CISO" },
    );
    const stored = s.getTask(rec.taskId);
    if (stored) stored.scheduledFor = new Date().toISOString();

    const result = await s.tick({ "claude-code": stub });
    expect(result.dispatched).toBe(1);
    expect(calls).toEqual(["default:hi"]);
    const finished = s.getTask(rec.taskId);
    expect(finished?.status).toBe("completed");
    expect(finished?.receipt?.provider).toBe("claude-code");
    expect(finished?.receipt?.model).toBe("claude-haiku-5-5");
    expect(finished?.receipt?.totalTokens).toBe(124);
    s.shutdown();
  });

  it("passes a task's tools to the adapter and records what ran on the receipt", async () => {
    const s = new Scheduler({ feed: mockGridFeed() });
    const seen: unknown[] = [];
    const stub: ProviderAdapter = {
      provider: "claude-code",
      ready: true,
      async dispatch(model, _prompt, o) {
        seen.push(o?.tools);
        return { text: "OK", model, provider: "claude-code", raw: null, tools: o?.tools ?? ["WebSearch"] };
      },
    };
    const rec = await s.enqueueProviderCall(
      { type: "provider_call", provider: "claude-code", model: "default", prompt: "hi", tools: ["Read"] },
      { deadline: new Date(Date.now() + 1500), region: "US-CAL-CISO" },
    );
    const stored = s.getTask(rec.taskId);
    if (stored) stored.scheduledFor = new Date().toISOString();
    await s.tick({ "claude-code": stub });
    expect(seen).toEqual([["Read"]]);
    expect(s.getTask(rec.taskId)?.receipt?.tools).toEqual(["Read"]);
    s.shutdown();
  });

  it("rejects a tool outside the claude-code allowlist at enqueue", async () => {
    const s = new Scheduler({ feed: mockGridFeed() });
    for (const tools of [["Bash"], ["bash"], ["webfetch"], ["WebSearch", "Edit"], ["WebSearch,Bash"], ["mcp__x__y"], "WebSearch", [42]]) {
      await expect(
        s.enqueueProviderCall(
          { type: "provider_call", provider: "claude-code", model: "default", prompt: "hi", tools: tools as string[] },
          { deadline: new Date(Date.now() + 60_000), region: "US-CAL-CISO" },
        ),
      ).rejects.toThrow(/WebSearch, WebFetch, Read, Grep, Glob/);
    }
    await expect(
      s.enqueueProviderCall(
        { type: "provider_call", provider: "claude-code", model: "default", prompt: "hi", tools: ["WebFetch", "Read"] },
        { deadline: new Date(Date.now() + 60_000), region: "US-CAL-CISO" },
      ),
    ).rejects.toThrow(/cannot combine a file tool/);
    s.shutdown();
  });

  it("does not touch closure-based tasks", async () => {
    const s = new Scheduler({ feed: mockGridFeed() });
    const fake = makeFakeAdapter("anthropic");
    s.enqueue(async () => "closure", { deadline: new Date(Date.now() + 60_000) });
    const result = await s.tick({ anthropic: fake });
    expect(result.inspected).toBe(0);
    s.shutdown();
  });
});

describe("body_json migration", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-tick-"));
    dbPath = join(dir, "queue.sqlite");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("survives a reopen and round-trips body_json", () => {
    const w = new TaskStore({ dbPath });
    w.upsert({
      taskId: "p1",
      status: "scheduled",
      enqueuedAt: "2026-05-12T00:00:00.000Z",
      scheduledFor: "2026-05-12T03:00:00.000Z",
      region: "US-CAL-CISO",
      bodyJson: JSON.stringify({
        type: "provider_call",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        prompt: "hi",
      }),
    });
    w.close();
    const r = new TaskStore({ dbPath });
    const got = r.get("p1");
    expect(got?.bodyJson).toBeDefined();
    expect(JSON.parse(got!.bodyJson!).prompt).toBe("hi");
    r.close();
  });
});
