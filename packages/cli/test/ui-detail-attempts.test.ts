/** The task detail's attempts and run limits (limits plan U12, R5, R9). */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { attemptLines, limitRows } from "../ui/detail.js";
import { eventLine } from "../ui/dom.js";

const failed = (at: string, attempt: number, retryAt: string) => ({
  at, kind: "attempt_failed", actor: "tick",
  details: { attempt, failure_class: "exit", error: "command exited with code 1", retry_at: retryAt },
});

describe("attempts", () => {
  it("a detail with two attempt_failed events shows both attempts and the next attempt time", () => {
    const t = {
      attempt: 3,
      next_attempt_at: "2026-11-08T14:00:00.000Z",
      events: [
        { at: "2026-11-08T10:00:00.000Z", kind: "created", actor: "cli", details: {} },
        failed("2026-11-08T11:00:00.000Z", 1, "2026-11-08T11:30:00.000Z"),
        failed("2026-11-08T12:00:00.000Z", 2, "2026-11-08T13:00:00.000Z"),
      ],
    };
    expect(attemptLines(t)).toEqual([
      "Attempt 1 failed 2026-11-08T11:00:00.000Z (exit): command exited with code 1",
      "Attempt 2 failed 2026-11-08T12:00:00.000Z (exit): command exited with code 1",
      "Attempt 3 from 2026-11-08T14:00:00.000Z",
    ]);
  });

  it("a manual retry starts a new count; a task with no failed attempt has no lines", () => {
    const t = {
      attempt: 1,
      next_attempt_at: null,
      events: [failed("2026-11-08T11:00:00.000Z", 1, "x"), { at: "2026-11-08T12:00:00.000Z", kind: "rescheduled", actor: "page", details: { reason: "retry" } }],
    };
    expect(attemptLines(t)).toEqual([]);
    expect(attemptLines({ events: [] })).toEqual([]);
  });

  it("the events list names the attempt, its class, the error and the next attempt", () => {
    expect(eventLine(failed("x", 1, "y"))).toBe("x attempt_failed by tick - attempt 1 (exit); command exited with code 1; next attempt from y");
  });

  it("the run limits show each value with its source", () => {
    const t = {
      limits_from: "now",
      limits: {
        command_timeout: { value_s: "none", source: "setting" },
        retries: { value: 2, source: "task" },
        retry_delay: { value_s: 1800, source: "default" },
      },
    };
    expect(limitRows(t)).toEqual([
      ["time limits", "command none (setting), if it ran now"],
      ["retries", "2 after 30m, doubling (task), if it ran now"],
    ]);
    expect(limitRows({})).toEqual([]);
  });

  it("the task's Retry is its own action: the plain retry action reloads the list after a load error and sends nothing", () => {
    const read = (f: string) => readFileSync(new URL(`../ui/${f}`, import.meta.url), "utf8");
    const app = read("app.js");
    expect(read("detail.js")).toMatch(/btn\("retry-task", "Retry"/);
    expect(app).toMatch(/case "retry-task":\s*return a\.retry \? void retryTask\(task\)/);
    expect(app).toMatch(/retry: \(\) => act\("retry-task", id\)/);
    expect(app).not.toMatch(/case "retry":/);
  });
});
