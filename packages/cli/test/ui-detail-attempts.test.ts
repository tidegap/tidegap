/** The task detail's attempts and run limits (limits plan U12, R5, R9). */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { attachmentItems, attemptLines, limitRows, sizeText, summaryView } from "../ui/detail.js";
import { eventLine } from "../ui/dom.js";

const failed = (at: string, attempt: number, retryAt: string) => ({
  at, kind: "attempt_failed", actor: "tick",
  details: { attempt, failure_class: "exit", error: "command exited with code 1", retry_at: retryAt },
});

describe("summary", () => {
  it("a completed run with a summary shows it; a failed summary shows one line; a run without either shows nothing", () => {
    expect(summaryView({ status: "completed", summary_text: "All fine.\n\nMore.", summary_error: null })).toEqual({ text: "All fine.\n\nMore.", note: null });
    expect(summaryView({ status: "completed", summary_text: null, summary_error: `summarize: stopped: budget\nsecond line ${"x".repeat(200)}` })).toEqual({
      text: null,
      note: "No summary: summarize: stopped: budget",
    });
    expect(summaryView({ status: "completed", summary_text: null, summary_error: null })).toBeNull();
    expect(summaryView({ status: "failed", summary_text: "x", summary_error: null })).toBeNull();
  });

  it("the drawer puts the Summary section above the Result section", () => {
    const src = readFileSync(new URL("../ui/detail.js", import.meta.url), "utf8");
    expect(src.indexOf('section("Summary"')).toBeGreaterThan(0);
    expect(src.indexOf('section("Summary"')).toBeLessThan(src.indexOf('section("Result"'));
  });
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

describe("attachments", () => {
  it("an image is shown, a CSV is a download, an expired file is named only, a skipped file names its reason", () => {
    const t = {
      task_id: "job-3f9a1c2e~1",
      attachments: [
        { index: 1, name: "funnel.png", type: "image/png", bytes: 49152, expired: false },
        { index: 2, name: "weekly.csv", type: "text/csv", bytes: 2048, expired: false },
        { index: 3, name: "old.png", type: "image/png", bytes: 10, expired: true },
        { index: 4, name: "chart.svg", type: "image/svg+xml", bytes: 900, expired: false },
      ],
      attachments_skipped: [{ name: "huge.png", reason: "over 10 MB" }],
    };
    expect(attachmentItems(t)).toEqual([
      { key: "job-3f9a1c2e~1/1", label: "funnel.png (48 KB)", name: "funnel.png", path: "/api/tasks/job-3f9a1c2e~1/attachments/1", image: true },
      { key: "job-3f9a1c2e~1/2", label: "weekly.csv (2 KB)", name: "weekly.csv", path: "/api/tasks/job-3f9a1c2e~1/attachments/2", image: false },
      { key: "job-3f9a1c2e~1/3", label: "old.png (10 B, expired)", name: "old.png", path: null, image: false },
      { key: "job-3f9a1c2e~1/4", label: "chart.svg (900 B)", name: "chart.svg", path: "/api/tasks/job-3f9a1c2e~1/attachments/4", image: false },
      { key: null, label: "not attached: huge.png (over 10 MB)", name: "huge.png", path: null, image: false },
    ]);
    expect(attachmentItems({ task_id: "t" })).toEqual([]);
    expect(sizeText(1.5 * 1024 * 1024)).toBe("1.5 MB");
  });

  it("the drawer renders names as text and images through blob URLs, never as HTML", () => {
    const src = readFileSync(new URL("../ui/detail.js", import.meta.url), "utf8");
    // From the blob cache to the end of the drawer block: everything that turns an attachment into DOM.
    const start = src.indexOf("let blobs = new Map()");
    const block = src.slice(start, src.indexOf("\n}\n", src.indexOf("function attachmentsSection")));
    expect(start).toBeGreaterThan(0);
    expect(block).toContain('section("Attachments"');
    expect(block).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);
    expect(block).toContain("URL.createObjectURL(blob)");
  });
});
