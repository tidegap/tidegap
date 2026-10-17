import { describe, expect, it } from "vitest";

import { callbackFits, notReadyMessage, queueMessage, resultMessages, splitMessage, taskDoneMessage, taskFailedMessage, TELEGRAM_MESSAGE_MAX } from "../src/index.js";
import type { TaskRecord } from "../src/index.js";

function rec(over: Partial<TaskRecord<unknown>> & { spec?: Record<string, unknown> } = {}): TaskRecord<unknown> {
  const { spec, ...rest } = over;
  return {
    taskId: "t-1",
    status: "completed",
    enqueuedAt: "2026-10-17T10:00:00Z",
    completedAt: "2026-10-17T11:00:00Z",
    region: "DE",
    title: "Weekly digest",
    bodyJson: JSON.stringify({ type: "provider_call", provider: "anthropic", model: "m", prompt: "Weekly digest", ...spec }),
    ...rest,
  } as TaskRecord<unknown>;
}

describe("channel texts", () => {
  it("a 5000-character result previews 600 characters", () => {
    const text = "a".repeat(5000);
    const msg = taskDoneMessage(rec({ result: { text } }));
    expect(msg.text).toContain(`${"a".repeat(600)}…`);
    expect(msg.text).not.toContain("a".repeat(601));
    expect(msg.buttons).toEqual([[{ text: "Result", data: "r:t-1" }]]);
  });

  it("a redactInReceipt task has no preview", () => {
    const msg = taskDoneMessage(rec({ result: { text: "secret output" }, spec: { redactInReceipt: ["secret"] } }));
    expect(msg.text).not.toContain("secret output");
    expect(msg.text).toContain("tidegap queue show t-1");
  });

  it("/result for a redactInReceipt task sends no result text", () => {
    const out = resultMessages(rec({ result: { text: "secret output" }, spec: { redactInReceipt: ["x"] } }));
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toContain("This task is redacted; run `tidegap queue show t-1`");
    expect(out[0]!.text).not.toContain("secret output");
  });

  it("/result splits at 4096 characters into at most 4 messages, then points to queue show", () => {
    const out = resultMessages(rec({ result: { text: "b".repeat(20_000) } }));
    expect(out).toHaveLength(5);
    expect(out.every((m) => m.text.length <= TELEGRAM_MESSAGE_MAX)).toBe(true);
    expect(out[4]!.text).toContain("tidegap queue show t-1");
  });

  it("a failed task shows the first error line and no buttons", () => {
    const msg = taskFailedMessage(rec({ status: "failed", error: "rate limited\nstack..." }));
    expect(msg.text).toContain("Failed: Weekly digest");
    expect(msg.text).toContain("rate limited");
    expect(msg.text).not.toContain("stack");
    expect(msg.buttons).toBeUndefined();
  });

  it("not ready names the daemon for ticker problems", () => {
    const msg = notReadyMessage([{ code: "daemon_stale", message: "Tasks may not run: the tick daemon last ran 11 minutes ago.", fix: "tidegap install" }]);
    expect(msg.text).toBe("Tidegap: the tick daemon is not running.\nTasks may not run: the tick daemon last ran 11 minutes ago. Run `tidegap install`.");
  });

  it("the queue numbers tasks and gives each a row of allowed buttons", () => {
    const pending = rec({ status: "scheduled", completedAt: undefined, scheduledFor: "2099-01-01T10:00:00Z" });
    const running = rec({ taskId: "t-2", status: "running", completedAt: undefined, title: "Running one" });
    const msg = queueMessage([pending, running]);
    expect(msg.ids).toEqual(["t-1", "t-2"]);
    expect(msg.text).toContain("1. Weekly digest");
    expect(msg.text).toContain("2. Running one · running");
    expect(msg.buttons).toEqual([
      [
        { text: "1 Later ▾", data: "l:t-1" },
        { text: "1 Run now", data: "x:t-1" },
        { text: "1 Cancel", data: "c:t-1" },
      ],
      [{ text: "2 Cancel", data: "c:t-2" }],
    ]);
  });

  it("splitMessage keeps every part within the limit", () => {
    expect(splitMessage("x".repeat(10), 4)).toEqual(["xxxx", "xxxx", "xx"]);
    expect(splitMessage("", 4)).toEqual([""]);
  });
});

describe("callbackFits", () => {
  it("accepts default ids and refuses ids that would overflow 64 bytes or break parsing", () => {
    expect(callbackFits("t-0f8e7c1a-2b3d-4e5f-8a9b-0c1d2e3f4a5b")).toBe(true);
    expect(callbackFits("series-1~12")).toBe(true);
    expect(callbackFits("x".repeat(70))).toBe(false);
    expect(callbackFits("has:colon")).toBe(false);
  });
});
