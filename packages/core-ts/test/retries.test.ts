/**
 * The retry funnel: every failed run of a provider-call row ends in one
 * place, which queues another attempt by the retry policy (a one-off row
 * goes back to `scheduled` with an `attempt_failed` event) or fails for
 * good, and the job sweep's retry rows per slot.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  NonRetryableError,
  ProviderRefusalError,
  permanentError,
  runLimitSettingsFromValues,
  sweepJobs,
  type ProviderAdapter,
  type ProviderCallSpec,
} from "../src/index.js";
import { H, MIN, PROMPT_JOB, T0, at, harness, job, type Harness } from "./jobs-harness.js";

/** An adapter for `provider` that throws `errors` in turn, then answers. */
function failing(provider: string, errors: unknown[]): ProviderAdapter & { calls: number } {
  const adapter = {
    provider,
    ready: true,
    calls: 0,
    async dispatch(model: string) {
      const err = errors[adapter.calls++];
      if (err) throw err;
      return { text: "ok", model, provider, raw: null };
    },
  };
  return adapter;
}

const timeout = () => new NonRetryableError("stopped: command time limit 30m", { steps: ["command"], stopped_by: "command_timeout" });

describe("the retry funnel", () => {
  let h: Harness;
  let config: Record<string, string>;
  let dir: string;
  beforeEach(() => {
    config = {};
    h = harness(undefined, { runLimits: () => runLimitSettingsFromValues(config) });
    dir = mkdtempSync(join(tmpdir(), "tidegap-retries-"));
  });
  afterEach(() => {
    h.done();
    rmSync(dir, { recursive: true, force: true });
  });

  async function command(deadlineH = 4, caps?: ProviderCallSpec["caps"]): Promise<string> {
    const row = await h.s.enqueueCommandTask({ run: "./deploy-check", cwd: dir, ...(caps ? { caps } : {}) }, { deadline: new Date(T0 + deadlineH * H) });
    h.s.runNow(row.taskId);
    return row.taskId;
  }

  async function model(provider: ProviderCallSpec["provider"], extra: Partial<ProviderCallSpec> = {}, deadlineH = 4): Promise<string> {
    const row = await h.s.enqueueProviderCall(
      { type: "provider_call", provider, model: "m", prompt: "p", ...extra },
      { deadline: new Date(T0 + deadlineH * H) },
    );
    h.s.runNow(row.taskId);
    return row.taskId;
  }

  const events = (id: string, kind: string) => h.store.listTaskEvents(id).filter((e) => e.kind === kind);

  it("with retries 0 a first failure is final, as before retries existed", async () => {
    config = { TIDEGAP_RETRIES_COMMAND: "0" };
    const id = await command();
    const result = await h.s.tick({ command: failing("command", [timeout()]) });
    expect(result).toMatchObject({ failed: 1, retrying: 0 });
    expect(h.store.get(id)).toMatchObject({ status: "failed", error: "stopped: command time limit 30m" });
    expect(events(id, "attempt_failed")).toHaveLength(0);
    expect(events(id, "failed")[0]!.details).toMatchObject({ attempts: 1, failure_class: "timeout", stopped_by: "command_timeout" });
  });

  it("covers AE1: two timeouts give one attempt_failed, then one final failure after 2 attempts", async () => {
    const id = await command();
    const adapter = failing("command", [timeout(), timeout()]);
    const first = await h.s.tick({ command: adapter });
    expect(first.results).toEqual([
      { taskId: id, status: "retrying", retryAt: new Date(T0 + 30 * MIN).toISOString(), error: "stopped: command time limit 30m" },
    ]);
    const queued = h.store.get(id)!;
    expect(queued).toMatchObject({ status: "scheduled", notBefore: new Date(T0 + 30 * MIN).toISOString(), completedAt: undefined, error: undefined });
    expect(Date.parse(queued.scheduledFor!)).toBeGreaterThanOrEqual(T0 + 30 * MIN);
    expect(Date.parse(queued.scheduledFor!)).toBeLessThanOrEqual(T0 + 4 * H);
    expect(queued.deadline).toBe(new Date(T0 + 4 * H).toISOString());
    expect(events(id, "attempt_failed").map((e) => e.details)).toEqual([
      expect.objectContaining({
        attempt: 1,
        failure_class: "timeout",
        error: "stopped: command time limit 30m",
        retry_at: new Date(T0 + 30 * MIN).toISOString(),
        stopped_by: "command_timeout",
      }),
    ]);
    // Nothing waits on the attempt: the row has no completion time, so no notice, wake or result file.
    expect(events(id, "failed")).toHaveLength(0);

    at(Date.parse(queued.scheduledFor!) + MIN);
    const second = await h.s.tick({ command: adapter });
    expect(second).toMatchObject({ failed: 1, retrying: 0 });
    expect(h.store.get(id)).toMatchObject({ status: "failed", error: "stopped: command time limit 30m (after 2 attempts)" });
    expect(events(id, "failed")).toHaveLength(1);
    expect(events(id, "failed")[0]!.details).toMatchObject({ attempts: 2, failure_class: "timeout" });
    expect(adapter.calls).toBe(2);
  });

  it("covers AE6: a failure 20 minutes before the deadline with a 30 minute delay is final at once", async () => {
    const id = await model("gemini", {}, 1);
    at(T0 + 40 * MIN);
    await h.s.tick({ gemini: failing("gemini", [new Error("Gemini API 503: busy")]) });
    expect(h.store.get(id)).toMatchObject({ status: "failed", error: "Gemini API 503: busy (no time left before the deadline for a retry)" });
    expect(events(id, "failed")[0]!.details).toMatchObject({ attempts: 1, failure_class: "transient" });
  });

  it("a rejected request, a refusal, missing setup and a budget stop never retry", async () => {
    const cases: [string, unknown, string][] = [
      ["401", Object.assign(new Error("invalid x-api-key"), { status: 401 }), "permanent"],
      ["refusal", new ProviderRefusalError("anthropic", "m", null), "permanent"],
      ["setup", permanentError("AnthropicAdapter: no API key."), "permanent"],
      ["budget", new NonRetryableError("stopped: budget 1 USD", { stopped_by: "budget" }), "permanent"],
    ];
    for (const [name, err, cls] of cases) {
      const id = await model("anthropic");
      await h.s.tick({ anthropic: failing("anthropic", [err]) });
      expect(h.store.get(id)!.status, name).toBe("failed");
      expect(events(id, "attempt_failed"), name).toHaveLength(0);
      expect(events(id, "failed")[0]!.details.failure_class, name).toBe(cls);
    }
  });

  it("an unmarked error, a non-zero Claude Code exit and a command exit each retry once", async () => {
    const claude = await model("claude-code");
    await h.s.tick({ "claude-code": failing("claude-code", [Object.assign(new Error("claude-code: exit 1"), { exit: true })]) });
    expect(events(claude, "attempt_failed")[0]!.details.failure_class).toBe("exit");
    const cmd = await command();
    await h.s.tick({ command: failing("command", [new NonRetryableError("command exited with code 1", { steps: ["command"] })]) });
    expect(events(cmd, "attempt_failed")[0]!.details.failure_class).toBe("exit");
    const api = await model("openai");
    await h.s.tick({ openai: failing("openai", [new Error("socket hang up")]) });
    expect(events(api, "attempt_failed")[0]!.details.failure_class).toBe("transient");
    for (const id of [claude, cmd, api]) expect(h.store.get(id)!.status).toBe("scheduled");
  });

  it("a command's LLM step failing after the command ran never retries", async () => {
    const id = await command();
    await h.s.tick({ command: failing("command", [new NonRetryableError("summarize: boom", { steps: ["command", "prompt"] })]) });
    expect(h.store.get(id)!.status).toBe("failed");
    expect(events(id, "failed")[0]!.details.failure_class).toBe("after_command");
  });

  it("the task's own retries, the runner setting and the delay setting apply; retry k waits twice the one before", async () => {
    config = { TIDEGAP_RETRIES_ANTHROPIC: "2", TIDEGAP_RETRY_DELAY: "10m" };
    const id = await model("anthropic", {}, 6);
    const adapter = failing("anthropic", [new Error("a"), new Error("b"), new Error("c")]);
    await h.s.tick({ anthropic: adapter });
    expect(h.store.get(id)!.notBefore).toBe(new Date(T0 + 10 * MIN).toISOString());
    at(Date.parse(h.store.get(id)!.scheduledFor!) + 1);
    const failedAt = Date.now();
    await h.s.tick({ anthropic: adapter });
    expect(h.store.get(id)!.notBefore).toBe(new Date(failedAt + 20 * MIN).toISOString());
    at(Date.parse(h.store.get(id)!.scheduledFor!) + 1);
    await h.s.tick({ anthropic: adapter });
    expect(h.store.get(id)).toMatchObject({ status: "failed", error: "c (after 3 attempts)" });
    const own = await model("anthropic", { caps: { retries: 0 } }, 6);
    await h.s.tick({ anthropic: failing("anthropic", [new Error("once")]) });
    expect(h.store.get(own)!.status).toBe("failed");
  });

  it("a repeating one-off rolls its series once, at the final outcome", async () => {
    const row = await h.s.enqueueProviderCall(
      { type: "provider_call", provider: "anthropic", model: "m", prompt: "p" },
      { deadline: new Date(T0 + 4 * H), repeat: "daily" },
    );
    h.s.runNow(row.taskId);
    const adapter = failing("anthropic", [new Error("a"), new Error("b")]);
    await h.s.tick({ anthropic: adapter });
    expect(h.store.list({ seriesId: row.seriesId! })).toHaveLength(1);
    at(Date.parse(h.store.get(row.taskId)!.scheduledFor!) + 1);
    await h.s.tick({ anthropic: adapter });
    expect(h.store.get(row.taskId)!.status).toBe("failed");
    expect(h.store.list({ seriesId: row.seriesId! })).toHaveLength(2);
  });

  it("a cancel between attempts ends the task cancelled with no further attempt", async () => {
    const id = await model("anthropic");
    const adapter = failing("anthropic", [new Error("a")]);
    await h.s.tick({ anthropic: adapter });
    h.s.cancelTask(id);
    at(Date.parse(h.store.get(id)!.notBefore!) + 2 * MIN);
    await h.s.tick({ anthropic: adapter });
    expect(h.store.get(id)!.status).toBe("cancelled");
    expect(adapter.calls).toBe(1);
  });

  it("run now on a queued attempt runs it at once and counts it", async () => {
    const id = await model("anthropic");
    const adapter = failing("anthropic", [new Error("a"), new Error("b")]);
    await h.s.tick({ anthropic: adapter });
    // The queued attempt drops the run-now mark of the first run, so the picker plans it.
    expect(h.store.get(id)!.intensitySource).toBeUndefined();
    h.s.runNow(id);
    await h.s.tick({ anthropic: adapter });
    expect(adapter.calls).toBe(2);
    expect(h.store.get(id)).toMatchObject({ status: "failed", error: "b (after 2 attempts)" });
  });

  it("the retry write is a compare-and-set on running: a row cancelled during the call keeps the cancel", async () => {
    const id = await model("anthropic");
    const adapter: ProviderAdapter = {
      provider: "anthropic",
      ready: true,
      async dispatch() {
        h.store.transitionIf({ ...h.store.get(id)!, status: "cancelled", completedAt: new Date().toISOString() }, ["running"]);
        throw new Error("late");
      },
    };
    const result = await h.s.tick({ anthropic: adapter });
    expect(h.store.get(id)!.status).toBe("cancelled");
    expect(result.retrying).toBe(0);
    expect(events(id, "attempt_failed")).toHaveLength(0);
  });
});

describe("job retries per slot", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });
  afterEach(() => h.done());

  async function failPending(jobId: string): Promise<string> {
    const id = h.store.getJob(jobId)!.pendingTaskId!;
    h.s.runNow(id);
    await h.s.tick({ anthropic: failing("anthropic", [new Error("boom")]) });
    expect(h.store.get(id)!.status).toBe("failed");
    return id;
  }

  it("retries 3 gives retry rows r, r2 and r3 with a doubling delay, then the slot fails", async () => {
    const j = await job(h.s, { deadline: new Date(T0 + 12 * H), caps: { retries: 3, retryDelayMs: 10 * MIN } });
    const ids: string[] = [];
    for (let k = 0; k < 3; k++) {
      await failPending(j.jobId);
      const swept = await sweepJobs(h.s);
      ids.push(...swept.retried);
      const retry = h.store.get(swept.retried[0]!)!;
      expect(Date.parse(retry.notBefore!) - Date.now()).toBe(10 * MIN * 2 ** k);
      at(Date.parse(retry.notBefore!) + MIN);
    }
    expect(ids).toEqual([`${j.jobId}~1r`, `${j.jobId}~1r2`, `${j.jobId}~1r3`]);
    expect(h.store.getJob(j.jobId)).toMatchObject({ retryUsed: 3, consecutiveFailures: 0 });
    await failPending(j.jobId);
    const last = await sweepJobs(h.s);
    expect(last.retried).toEqual([]);
    expect(last.materialized).toEqual([`${j.jobId}~2`]);
    expect(h.store.getJob(j.jobId)).toMatchObject({ retryUsed: 0, consecutiveFailures: 1 });
  });

  it("a job with retries 0 never makes a retry row", async () => {
    const j = await job(h.s, { deadline: new Date(T0 + 12 * H), caps: { retries: 0 } });
    await failPending(j.jobId);
    const swept = await sweepJobs(h.s);
    expect(swept.retried).toEqual([]);
    expect(h.store.getJob(j.jobId)!.consecutiveFailures).toBe(1);
  });

  it("covers AE7: a permanent failure (a missing secret) fails once with no attempt_failed and no retry run", async () => {
    const j = await job(h.s, { deadline: new Date(T0 + 12 * H) });
    const id = h.store.getJob(j.jobId)!.pendingTaskId!;
    h.s.runNow(id);
    await h.s.tick({ anthropic: failing("anthropic", [permanentError("secret API_TOKEN is not set; run: tidegap jobs secrets set API_TOKEN")]) });
    expect(h.store.listTaskEvents(id).some((e) => e.kind === "attempt_failed")).toBe(false);
    const swept = await sweepJobs(h.s);
    expect(swept.retried).toEqual([]);
    expect(h.store.getJob(j.jobId)).toMatchObject({ consecutiveFailures: 1, lastOutcome: "failed" });
  });

  it("a legacy job row with retry_used 1 reads as one retry used", async () => {
    const j = await job(h.s, { deadline: new Date(T0 + 12 * H) });
    const current = h.store.getJob(j.jobId)!;
    expect(h.store.updateJobIf({ ...current, retryUsed: 1 }, current.revision)).toBe(true);
    await failPending(j.jobId);
    expect((await sweepJobs(h.s)).retried).toEqual([]);
    expect(PROMPT_JOB.title).toBe("Mail digest");
  });
});
