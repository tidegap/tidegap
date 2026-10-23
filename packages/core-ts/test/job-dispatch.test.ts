/**
 * How the scheduler dispatches job occurrences (U6, KTD6-KTD8): caps and
 * the working directory reach the adapter, a job row never gets a session
 * origin, a non-retryable error runs once, run details land on the
 * terminal event, a command occurrence never goes to a Batch API, and the
 * API adapters turn a budget into a token ceiling.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AnthropicAdapter,
  BudgetExceededError,
  budgetMaxTokens,
  DEFAULT_JOB_CAPS,
  NonRetryableError,
  ProviderDeferError,
  retryWithBackoff,
} from "../src/index.js";
import type { DispatchOptions, ProviderAdapter } from "../src/index.js";
import { DAY, H, T0, harness, job, type Harness } from "./jobs-harness.js";

const COMMAND_JOB = {
  title: "Disk check",
  template: { runner: "command" as const, command: "df -h", cwd: "/tmp", secrets: ["DISK_TOKEN"], summarize: { prompt: "anything odd?", provider: "anthropic" as const } },
};

/** A fake adapter that records each call's options and answers with `answer`. */
function recorder(provider: string, answer: () => Promise<unknown> | unknown = () => ({ text: "ok", model: "m", provider, raw: null })) {
  const calls: Array<{ model: string; prompt: string; options: DispatchOptions }> = [];
  const adapter: ProviderAdapter = {
    provider,
    ready: true,
    async dispatch(model, prompt, options = {}) {
      calls.push({ model, prompt, options });
      return (await answer()) as never;
    },
  };
  return { adapter, calls };
}

describe("job occurrence dispatch", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });
  afterEach(() => h.done());

  it("a prompt job's caps, cwd and job id reach the adapter; no session origin", async () => {
    const j = await job(h.s, {
      template: { runner: "prompt", prompt: "summarize the notes", provider: "anthropic", cwd: "/tmp/notes", tools: "files" },
      caps: { llmTimeoutMs: 120_000, maxBudgetUsd: 0.25 },
    });
    const id = h.store.getJob(j.jobId)!.pendingTaskId!;
    h.s.runNow(id);
    const { adapter, calls } = recorder("anthropic");
    await h.s.tick({ anthropic: adapter });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options).toMatchObject({ timeoutMs: 120_000, maxBudgetUsd: 0.25, cwd: "/tmp/notes", jobId: j.jobId });
    expect(calls[0]!.options.origin).toBeUndefined();
    expect(calls[0]!.options.command).toBeUndefined();
  });

  it("a command occurrence hands its shell and summarize steps and caps to the command adapter", async () => {
    const j = await job(h.s, COMMAND_JOB);
    const id = h.store.getJob(j.jobId)!.pendingTaskId!;
    h.s.runNow(id);
    const { adapter, calls } = recorder("command", () => ({
      text: "fine",
      model: "claude-sonnet-5",
      provider: "anthropic",
      raw: null,
      details: { steps: ["command", "prompt"], truncated: true },
    }));
    await h.s.tick({ command: adapter });
    expect(calls[0]!.prompt).toBe("anything odd?");
    expect(calls[0]!.options).toMatchObject({
      jobId: j.jobId,
      command: { run: "df -h", cwd: "/tmp", secrets: ["DISK_TOKEN"] },
      summarize: { provider: "anthropic" },
      caps: DEFAULT_JOB_CAPS,
    });
    const completed = h.s.listTaskEvents(id).find((e) => e.kind === "completed")!;
    expect(completed.details).toMatchObject({ steps: ["command", "prompt"], truncated: true });
  });

  it("a NonRetryableError runs once even with a retryable status, and its details go on the failed event", async () => {
    const j = await job(h.s, COMMAND_JOB);
    const id = h.store.getJob(j.jobId)!.pendingTaskId!;
    h.s.runNow(id);
    const { adapter, calls } = recorder("command", () => {
      throw Object.assign(new NonRetryableError("stopped: command time limit 5 min", { steps: ["command"], stopped_by: "command_timeout" }), {
        status: 503,
      });
    });
    await h.s.tick({ command: adapter });
    expect(calls).toHaveLength(1);
    expect(h.store.get(id)).toMatchObject({ status: "failed", error: "stopped: command time limit 5 min" });
    const failed = h.s.listTaskEvents(id).find((e) => e.kind === "failed")!;
    expect(failed.details).toMatchObject({ steps: ["command"], stopped_by: "command_timeout" });
  });

  it("covers AE10: a command occurrence with a 7-day deadline never goes to a Batch API; a prompt one does", async () => {
    const cmd = await job(h.s, { ...COMMAND_JOB, deadline: new Date(Date.now() + 7 * DAY) });
    const prompt = await job(h.s, { title: "Week notes", deadline: new Date(Date.now() + 7 * DAY) });
    const submitted: string[] = [];
    const batch: ProviderAdapter = {
      provider: "anthropic",
      ready: true,
      async dispatch() {
        throw new Error("not expected");
      },
      async dispatchBatch(model, prompts) {
        submitted.push(prompts[0]!);
        return { batchId: `b${submitted.length}`, provider: "anthropic", size: 1 };
      },
    };
    const { adapter } = recorder("command");
    await h.s.tick({ anthropic: batch, command: adapter });
    expect(h.store.get(h.store.getJob(prompt.jobId)!.pendingTaskId!)!.status).toBe("submitted");
    expect(h.store.get(h.store.getJob(cmd.jobId)!.pendingTaskId!)!.status).toBe("scheduled");
    expect(submitted).toEqual(["check my mail and tell me what matters"]);
  });

  it("a usage limit hit by a command job's summarize step defers the later calls to that provider", async () => {
    // The earlier deadline dispatches first, so its deferral is seen by the prompt job.
    const withSummary = await job(h.s, { ...COMMAND_JOB, deadline: new Date(T0 + H) });
    const prompt = await job(h.s, { template: { runner: "prompt", prompt: "news?", provider: "anthropic", cwd: "/tmp", tools: "none" } });
    for (const j of [withSummary, prompt]) h.s.runNow(h.store.getJob(j.jobId)!.pendingTaskId!);
    const command: ProviderAdapter = {
      provider: "command",
      ready: true,
      async dispatch() {
        throw new ProviderDeferError("anthropic: usage limit", new Date(T0 + DAY));
      },
    };
    const { adapter, calls } = recorder("anthropic");
    await h.s.tick({ command, anthropic: adapter });
    expect(calls).toHaveLength(0);
  });
});

describe("retryWithBackoff and the non-retryable marker", () => {
  it("does not retry a NonRetryableError", async () => {
    let n = 0;
    await expect(
      retryWithBackoff(async () => {
        n += 1;
        throw Object.assign(new NonRetryableError("once"), { status: 500 });
      }),
    ).rejects.toThrow("once");
    expect(n).toBe(1);
  });
});

describe("budgetMaxTokens (KTD8)", () => {
  it("leaves maxTokens alone without a budget", () => {
    expect(budgetMaxTokens("claude-sonnet-5", "hi", { maxTokens: 500 })).toBe(500);
  });

  it("caps the adapter default with what the budget leaves after the input", () => {
    // claude-sonnet-5: 2 USD in, 10 USD out per million. 0.001 USD buys 100 output tokens.
    expect(budgetMaxTokens("claude-sonnet-5", "x".repeat(4), { maxBudgetUsd: 0.001 }, 4096)).toBe(99);
    expect(budgetMaxTokens("claude-sonnet-5", "hi", { maxBudgetUsd: 1 }, 4096)).toBe(4096);
  });

  it("throws BudgetExceededError with stopped_by budget when the input alone costs more", () => {
    let err: unknown;
    try {
      budgetMaxTokens("claude-sonnet-5", "x".repeat(4_000_000), { maxBudgetUsd: 1 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect((err as BudgetExceededError).details).toEqual({ stopped_by: "budget" });
  });

  it("a model without a price keeps the given maxTokens", () => {
    expect(budgetMaxTokens("some-unpriced-model", "hi", { maxBudgetUsd: 0.0001, maxTokens: 77 })).toBe(77);
  });

  it("the Anthropic adapter fails before sending when the input is over budget, and sends the ceiling otherwise", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const client = {
      messages: {
        create: async (params: Record<string, unknown>) => {
          sent.push(params);
          return { content: [{ type: "text", text: "ok" }], model: "claude-sonnet-5", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
        },
      },
    };
    const a = new AnthropicAdapter({ client });
    await expect(a.dispatch("claude-sonnet-5", "x".repeat(4_000_000), { maxBudgetUsd: 1 })).rejects.toBeInstanceOf(BudgetExceededError);
    expect(sent).toHaveLength(0);
    await a.dispatch("claude-sonnet-5", "x".repeat(4), { maxBudgetUsd: 0.001 });
    expect(sent[0]!.max_tokens).toBe(99);
  });
});

