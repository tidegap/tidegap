import { describe, expect, it } from "vitest";

import { callbackFits, jobPausedMessage, telegramCommands, notReadyMessage, queueMessage, resultMessages, splitMessage, taskDoneMessage, taskFailedMessage, TELEGRAM_MESSAGE_MAX } from "../src/index.js";
import type { RunSession, TaskRecord } from "../src/index.js";

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

  describe("where a claude-code task ran (R12)", () => {
    const receipt = (session: RunSession) => ({ taskId: "t-1", ranAt: "2026-10-17T11:00:00Z", region: "DE", estimatedCarbonGCo2: 0.1, session });
    const ORIGIN = "d76db676-78da-4dca-b20e-1328074e7009";

    it("a fork names the short session id and the directory's last segment only", () => {
      const msg = taskDoneMessage(
        rec({
          originCwd: "/Users/someone/work/app",
          originSessionId: ORIGIN,
          receipt: receipt({ mode: "fork", sessionId: "f1a2b3c4-0000-4000-8000-000000000000", originSessionId: ORIGIN }),
          result: { text: "done" },
        }),
      );
      expect(msg.text).toContain("Ran in a copy of session d76db676 (app)");
      expect(msg.text).not.toContain("/Users/someone");
    });

    it("a fresh run names the reason", () => {
      const msg = taskDoneMessage(rec({ receipt: receipt({ mode: "fresh", reason: "too-large", contextTokens: 620_000 }) }));
      expect(msg.text).toContain("Ran in a fresh session: session too large");
    });

    it("a receipt without a session adds no line", () => {
      const before = taskDoneMessage(rec({ result: { text: "x" } })).text;
      const msg = taskDoneMessage(rec({ result: { text: "x" }, receipt: { taskId: "t-1", ranAt: "2026-10-17T11:00:00Z", region: "DE", estimatedCarbonGCo2: 0.1 } }));
      expect(msg.text).toBe(before);
      expect(msg.text).not.toContain("Ran in");
    });
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

  it("a recovery heads the message 'running again' and keeps any open problem", () => {
    expect(notReadyMessage([], true).text).toBe("Tidegap: the tick daemon is running again.");
    const msg = notReadyMessage([{ code: "no_runner", message: "Tasks will not run: 1 openai task has no runner.", fix: "add OPENAI_API_KEY to ~/.config/tidegap/env" }], true);
    expect(msg.text.split("\n")[0]).toBe("Tidegap: the tick daemon is running again.");
    expect(msg.text.split("\n")).toHaveLength(2);
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

describe("telegramCommands", () => {
  it("parses HELP_TEXT into Bot API valid commands", () => {
    const cmds = telegramCommands();
    expect(cmds.length).toBeGreaterThan(0);
    for (const c of cmds) {
      expect(c.command).toMatch(/^[a-z0-9_]{1,32}$/);
      expect(c.description.length).toBeGreaterThan(0);
      expect(c.description.length).toBeLessThanOrEqual(256);
    }
  });

  it("skips malformed lines", () => {
    const help = ["/ok - fine", "no slash - x", "/Bad - upper", "/x", "/a-b - dash", "/later <n> - with args"].join("\n");
    expect(telegramCommands(help)).toEqual([
      { command: "ok", description: "fine" },
      { command: "later", description: "with args" },
    ]);
  });
});

describe("job occurrence messages (jobs R22, KTD10)", () => {
  const now = new Date("2026-10-17T12:00:00Z");

  it("done: '<job title>: <result>' on the first line; a short one-line result is not repeated below", () => {
    const msg = taskDoneMessage(rec({ result: { text: "3 messages need a reply" } }), now, "Mail triage");
    expect(msg.text.split("\n")[0]).toBe("Mail triage: 3 messages need a reply");
    expect(msg.text.match(/3 messages need a reply/g)).toHaveLength(1);
    expect(msg.buttons).toBeDefined();
  });

  it("done with a multi-line result: the first line flattened, then the preview", () => {
    const msg = taskDoneMessage(rec({ result: { text: "line one\nline two" } }), now, "Mail triage");
    expect(msg.text.split("\n")[0]).toBe("Mail triage: line one line two");
    expect(msg.text).toContain("\n\nline one\nline two");
  });

  it("done for a redacted task: no result text, the title says done", () => {
    const msg = taskDoneMessage(rec({ result: { text: "secret output" }, spec: { redactInReceipt: ["secret"] } }), now, "Mail triage");
    expect(msg.text.split("\n")[0]).toBe("Mail triage: done");
    expect(msg.text).not.toContain("secret output");
  });

  it("failed: '<job title>: failed' and the first error line", () => {
    const msg = taskFailedMessage(rec({ status: "failed", error: "ssh: connect timed out\nmore" }), now, "Deploy logs");
    expect(msg.text.split("\n")).toEqual(expect.arrayContaining(["Deploy logs: failed", "ssh: connect timed out"]));
  });

  it("the pause notice names the job, the count and the reason, then how to resume", () => {
    const notice = { jobId: "job-1", title: "deploy logs", reason: "ssh: connect timed out" };
    expect(jobPausedMessage(notice).text).toBe("job 'deploy logs' paused after 3 failures: ssh: connect timed out\nResume it: tidegap jobs resume job-1");
  });
});
