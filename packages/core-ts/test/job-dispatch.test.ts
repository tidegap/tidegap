/**
 * How the scheduler dispatches job occurrences (U6, KTD6-KTD8): caps and
 * the working directory reach the adapter, a job row never gets a session
 * origin, a non-retryable error runs once, run details land on the
 * terminal event, a command occurrence never goes to a Batch API, and the
 * API adapters turn a budget into a token ceiling.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AnthropicAdapter,
  BudgetExceededError,
  budgetMaxTokens,
  DEFAULT_JOB_CAPS,
  NonRetryableError,
  ProviderDeferError,
  retryWithBackoff,
  runLimitSettingsFromValues,
  sweepJobs,
} from "../src/index.js";
import type { DispatchOptions, ProviderAdapter, ProviderCallSpec } from "../src/index.js";
import { DAY, H, MIN, T0, harness, job, type Harness } from "./jobs-harness.js";

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
    expect(calls[0]!.options.commandTimeoutMs).toBeUndefined();
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
      caps: { ...DEFAULT_JOB_CAPS, capsVersion: 2 },
      // The shell step's limit, and the summarize step's from its provider.
      commandTimeoutMs: 30 * MIN,
      timeoutMs: 10 * MIN,
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

describe("run time limits at dispatch", () => {
  let h: Harness;
  let config: Record<string, string>;
  let dir: string;
  beforeEach(() => {
    config = {};
    h = harness(undefined, { runLimits: () => runLimitSettingsFromValues(config) });
    dir = mkdtempSync(join(tmpdir(), "tidegap-limits-"));
  });
  afterEach(() => {
    h.done();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Queue a model call due now; returns its id. */
  async function oneOff(provider: ProviderCallSpec["provider"], caps?: ProviderCallSpec["caps"]): Promise<string> {
    const row = await h.s.enqueueProviderCall(
      { type: "provider_call", provider, model: "m", prompt: "p", ...(caps ? { caps } : {}) },
      { deadline: new Date(T0 + 3 * H) },
    );
    h.s.runNow(row.taskId);
    return row.taskId;
  }

  /** Queue a one-off command due now; returns its id. */
  async function command(caps?: ProviderCallSpec["caps"]): Promise<string> {
    const row = await h.s.enqueueCommandTask({ run: "make", cwd: dir, ...(caps ? { caps } : {}) }, { deadline: new Date(T0 + 3 * H) });
    h.s.runNow(row.taskId);
    return row.taskId;
  }

  /** The time limits a run's `dispatched` event records (its retry settings are checked on their own). */
  function limitsOf(id: string): unknown {
    const { retries: _r, retry_delay: _d, ...time } = allLimitsOf(id);
    return time;
  }

  function allLimitsOf(id: string): Record<string, unknown> {
    return h.s.listTaskEvents(id).find((e) => e.kind === "dispatched")!.details.limits as Record<string, unknown>;
  }

  it("a one-off command gets 30 minutes by default, the setting when there is one, and no timer for none", async () => {
    const { adapter, calls } = recorder("command");
    const first = await command();
    await h.s.tick({ command: adapter });
    expect(calls[0]!.options.commandTimeoutMs).toBe(30 * MIN);
    expect(limitsOf(first)).toEqual({ command_timeout: { value_s: 1800, source: "default" } });
    expect(allLimitsOf(first)).toMatchObject({ retries: { value: 1, source: "default" }, retry_delay: { value_s: 1800, source: "default" } });
    config = { TIDEGAP_COMMAND_TIMEOUT: "2m" };
    await command();
    await h.s.tick({ command: adapter });
    expect(calls[1]!.options.commandTimeoutMs).toBe(2 * MIN);
    config = { TIDEGAP_COMMAND_TIMEOUT: "none" };
    const third = await command();
    await h.s.tick({ command: adapter });
    expect(calls[2]!.options.commandTimeoutMs).toBe("none");
    expect(limitsOf(third)).toEqual({ command_timeout: { value_s: "none", source: "setting" } });
  });

  it("a claude-code one-off gets 30 minutes, and none from its runner setting", async () => {
    const { adapter, calls } = recorder("claude-code");
    await oneOff("claude-code");
    await h.s.tick({ "claude-code": adapter });
    expect(calls[0]!.options.timeoutMs).toBe(30 * MIN);
    config = { TIDEGAP_LLM_TIMEOUT_CLAUDE_CODE: "none" };
    const second = await oneOff("claude-code");
    await h.s.tick({ "claude-code": adapter });
    expect(calls[1]!.options.timeoutMs).toBe("none");
    expect(limitsOf(second)).toEqual({ llm_timeout: { value_s: "none", source: "setting:claude-code" } });
  });

  it("an anthropic one-off gets 10 minutes, and a Gemini one-off gets a limit too", async () => {
    const anthropic = recorder("anthropic");
    const gemini = recorder("gemini");
    await oneOff("anthropic");
    await oneOff("gemini");
    await h.s.tick({ anthropic: anthropic.adapter, gemini: gemini.adapter });
    expect(anthropic.calls[0]!.options.timeoutMs).toBe(10 * MIN);
    expect(gemini.calls[0]!.options.timeoutMs).toBe(10 * MIN);
  });

  it("covers AE3: the four sources, read from the dispatched event", async () => {
    config = { TIDEGAP_LLM_TIMEOUT: "20m", TIDEGAP_LLM_TIMEOUT_CLAUDE_CODE: "1h" };
    const own = await oneOff("claude-code", { llmTimeoutMs: 5 * MIN });
    const runner = await oneOff("claude-code");
    const all = await oneOff("anthropic");
    await h.s.tick({ "claude-code": recorder("claude-code").adapter, anthropic: recorder("anthropic").adapter });
    expect(limitsOf(own)).toEqual({ llm_timeout: { value_s: 300, source: "task" } });
    expect(limitsOf(runner)).toEqual({ llm_timeout: { value_s: 3600, source: "setting:claude-code" } });
    expect(limitsOf(all)).toEqual({ llm_timeout: { value_s: 1200, source: "setting" } });
    config = {};
    const fallback = await oneOff("anthropic");
    await h.s.tick({ anthropic: recorder("anthropic").adapter });
    expect(limitsOf(fallback)).toEqual({ llm_timeout: { value_s: 600, source: "default" } });
  });

  it("a task queued with its own 5 minutes keeps them under a 1 hour setting", async () => {
    config = { TIDEGAP_COMMAND_TIMEOUT: "1h" };
    const { adapter, calls } = recorder("command");
    const id = await command({ commandTimeoutMs: 5 * MIN });
    expect(JSON.parse(h.store.get(id)!.bodyJson!).caps).toEqual({ commandTimeoutMs: 5 * MIN, capsVersion: 2 });
    await h.s.tick({ command: adapter });
    expect(calls[0]!.options.commandTimeoutMs).toBe(5 * MIN);
    expect(limitsOf(id)).toEqual({ command_timeout: { value_s: 300, source: "task" } });
  });

  it("covers AE9: a job stored before this change with the old 5 minute default follows the setting", async () => {
    config = { TIDEGAP_COMMAND_TIMEOUT: "1h" };
    const j = await job(h.s, { template: { runner: "command", command: "df -h", cwd: "/tmp", secrets: [] } });
    const legacy = { commandTimeoutMs: 300_000, llmTimeoutMs: 600_000, maxBudgetUsd: 1, outputCapBytes: 10 * 1024 * 1024, summarizeInputCapBytes: 200 * 1024 };
    const stored = h.store.getJob(j.jobId)!;
    expect(h.store.updateJobIf({ ...stored, caps: legacy }, stored.revision)).toBe(true);
    // Skip the occurrence made with the new caps; the next one carries the stored ones.
    h.s.cancelTask(stored.pendingTaskId!);
    await sweepJobs(h.s);
    const id = h.store.getJob(j.jobId)!.pendingTaskId!;
    expect(JSON.parse(h.store.get(id)!.bodyJson!).caps).toEqual(legacy);
    h.s.runNow(id);
    const { adapter, calls } = recorder("command");
    await h.s.tick({ command: adapter });
    expect(calls[0]!.options.commandTimeoutMs).toBe(H);
    expect(limitsOf(id)).toEqual({ command_timeout: { value_s: 3600, source: "setting" } });
  });

  it("a settings change between two ticks applies to the second run with no restart", async () => {
    const { adapter, calls } = recorder("anthropic");
    await oneOff("anthropic");
    await h.s.tick({ anthropic: adapter });
    config = { TIDEGAP_LLM_TIMEOUT_ANTHROPIC: "45m" };
    await oneOff("anthropic");
    await h.s.tick({ anthropic: adapter });
    expect(calls.map((c) => c.options.timeoutMs)).toEqual([10 * MIN, 45 * MIN]);
  });

  it("a one-off model call stores only the time limit its caller set; any other cap is refused", async () => {
    const id = await oneOff("anthropic", { llmTimeoutMs: "none" });
    expect(JSON.parse(h.store.get(id)!.bodyJson!).caps).toEqual({ llmTimeoutMs: "none", capsVersion: 2 });
    await expect(oneOff("anthropic", { maxBudgetUsd: 1 })).rejects.toThrow('enqueueProviderCall: unknown cap "maxBudgetUsd"');
    await expect(oneOff("anthropic", { llmTimeoutMs: 0 })).rejects.toThrow("0 is not a time limit; use none for no time limit.");
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

