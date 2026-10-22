import { describe, expect, it } from "vitest";

import { eventMessage, payloadFor } from "../src/index.js";
import type { ChannelEvent, TaskRecord } from "../src/index.js";

const NOW = new Date("2026-10-19T12:00:00Z");

function rec(over: Partial<TaskRecord<unknown>> & { spec?: Record<string, unknown> } = {}): TaskRecord<unknown> {
  const { spec, ...rest } = over;
  return {
    taskId: "t-1",
    status: "failed",
    enqueuedAt: "2026-10-17T10:00:00Z",
    completedAt: "2026-10-17T11:00:00Z",
    region: "DE",
    title: "Weekly digest",
    error: "boom",
    bodyJson: JSON.stringify({ type: "provider_call", provider: "anthropic", model: "m", prompt: "Weekly digest", ...spec }),
    ...rest,
  } as TaskRecord<unknown>;
}

describe("payloadFor", () => {
  it("task_failed → level error, text equals eventMessage text, task facts", () => {
    const event: ChannelEvent = { kind: "task_failed", task: rec() };
    const p = payloadFor(event, NOW);
    expect(p).toEqual({
      event: "task_failed",
      level: "error",
      title: "Failed: Weekly digest",
      text: eventMessage(event, NOW).text,
      at: "2026-10-17T11:00:00Z",
      task: { id: "t-1", title: "Weekly digest", status: "failed" },
    });
  });

  it("task_done carries the receipt's grams, actual over estimated", () => {
    const receipt = { taskId: "t-1", ranAt: "2026-10-17T11:00:00Z", region: "DE", estimatedCarbonGCo2: 0.5, actualCarbonGCo2: 0.25 };
    const p = payloadFor({ kind: "task_done", task: rec({ status: "completed", receipt, result: { text: "ok" } }) }, NOW);
    expect(p.level).toBe("success");
    expect(p.task?.grams).toBe(0.25);
  });

  it("a redacted task has no result preview", () => {
    const task = rec({ status: "completed", result: { text: "secret output" }, spec: { redactInReceipt: ["secret"] } });
    const p = payloadFor({ kind: "task_done", task }, NOW);
    expect(p.text).not.toContain("secret output");
    expect(p.text).toContain("The result is not sent here");
  });

  it("clean_window, not_ready and digest get their level, title and time", () => {
    const window = payloadFor({ kind: "clean_window", window: { start: "2026-10-19T13:00:00Z", end: "2026-10-19T15:00:00Z" } }, NOW);
    expect(window).toMatchObject({ level: "info", title: "Clean window starting", at: "2026-10-19T13:00:00Z" });
    expect(window.task).toBeUndefined();
    const notReady = payloadFor({ kind: "not_ready", problems: [{ code: "no_runner", message: "No runner.", fix: "tidegap install" }] }, NOW);
    expect(notReady).toMatchObject({ level: "warning", title: "Tidegap: queued tasks cannot run.", at: NOW.toISOString() });
    const recovered = payloadFor({ kind: "not_ready", problems: [], recovered: true }, NOW);
    expect(recovered).toMatchObject({ event: "not_ready", level: "success", title: "Tidegap: the tick daemon is running again.", recovered: true });
    expect(notReady).not.toHaveProperty("recovered");
    const digest = payloadFor({ kind: "digest", title: "Tidegap daily summary", text: "2 finished, 1 failed." }, NOW);
    expect(digest).toEqual({ event: "digest", level: "info", title: "Tidegap daily summary", text: "Tidegap daily summary\n2 finished, 1 failed.", at: NOW.toISOString() });
  });
});
