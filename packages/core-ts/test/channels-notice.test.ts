import { describe, expect, it } from "vitest";

import { NOTICE_EMOJI, noticeStatus, structureSummary } from "../src/index.js";
import type { TaskRecord } from "../src/index.js";

function rec(over: Partial<TaskRecord<unknown>> = {}): TaskRecord<unknown> {
  return {
    taskId: "job-1~1",
    status: "completed",
    enqueuedAt: "2026-11-14T10:00:00Z",
    completedAt: "2026-11-14T10:05:00Z",
    region: "DE",
    title: "Signup funnel monitor",
    bodyJson: JSON.stringify({ type: "command", command: "./monitor.sh" }),
    ...over,
  } as TaskRecord<unknown>;
}

describe("NOTICE_EMOJI", () => {
  it("one emoji per status", () => {
    expect(NOTICE_EMOJI).toEqual({ ok: "✅", attention: "⚠️", done: "☑️", failed: "❌", ended: "🏁" });
  });
});

describe("structureSummary", () => {
  it("the requested shape: a status word, the verdict, the dash lines", () => {
    const reply = [
      "ATTENTION: Referral share dropped; the rest is normal.",
      "- Checked: visits, signups, referral share, coupons and server errors over 24 hours.",
      "- Changed: referral share is 9.1% against 11.8% over 7 days, past the 15% limit.",
      "- Action: check the referral widget on the checkout page.",
    ].join("\n");
    expect(structureSummary(reply)).toEqual({
      status: "attention",
      verdict: "Referral share dropped; the rest is normal.",
      bullets: [
        "Checked: visits, signups, referral share, coupons and server errors over 24 hours.",
        "Changed: referral share is 9.1% against 11.8% over 7 days, past the 15% limit.",
        "Action: check the referral widget on the checkout page.",
      ],
    });
  });

  it("a verdict and a paragraph: no status, one bullet per sentence", () => {
    const reply =
      "Referral share dropped; the rest is normal.\n\nReferral share fell to 9.1% from its 7-day level of 11.8%, past the 15% alert limit. Visits, signups, coupons and server errors are in their usual range. Check the referral widget on the checkout page.";
    expect(structureSummary(reply)).toEqual({
      verdict: "Referral share dropped; the rest is normal.",
      bullets: [
        "Referral share fell to 9.1% from its 7-day level of 11.8%, past the 15% alert limit.",
        "Visits, signups, coupons and server errors are in their usual range.",
        "Check the referral widget on the checkout page.",
      ],
    });
  });

  it.each([
    ["ok: fine", "ok", "fine"],
    ["[ATTENTION] - x", "attention", "x"],
    ["Attention — x", "attention", "x"],
    ["OK. All checks passed.", "ok", "All checks passed."],
    ["OKAY then", undefined, "OKAY then"],
    ["Okay, fine", undefined, "Okay, fine"],
    ["OK-ish result", undefined, "OK-ish result"],
    ["Attention-grabbing drop in signups", undefined, "Attention-grabbing drop in signups"],
    ["OK - fine", "ok", "fine"],
    ["OK—fine", "ok", "fine"],
    ["The job is fine. ATTENTION: none", undefined, "The job is fine. ATTENTION: none"],
  ])("status word of %j", (reply, status, verdict) => {
    const out = structureSummary(reply);
    expect(out.status).toBe(status);
    expect(out.verdict).toBe(verdict);
  });

  it("markdown: emphasis, list marks, a heading, a code fence and a table rule are removed", () => {
    const reply = ["**ATTENTION**: x", "# Heading", "1. a", "```", "2) b", "|---|---|", "* c", "---"].join("\n");
    expect(structureSummary(reply)).toEqual({ status: "attention", verdict: "x", bullets: ["a", "b", "c"] });
  });

  it("quote marks go and a link becomes text (url)", () => {
    expect(structureSummary("> OK: fine\n> - see [the board](https://example.com/b)").bullets).toEqual(["see the board (https://example.com/b)"]);
  });

  it("leading pictographs are removed from the verdict and from a bullet; the status still comes from the word", () => {
    expect(structureSummary("⚠️ ✅ OK: x\n- 🔥 hot path")).toEqual({ status: "ok", verdict: "x", bullets: ["hot path"] });
  });

  it("caps: six bullets give four lines, the last …; a 300-character bullet is cut to 200", () => {
    const six = structureSummary(["OK: x", "- 1", "- 2", "- 3", "- 4", "- 5", "- 6"].join("\n"));
    expect(six.bullets).toEqual(["1", "2", "3", "…"]);
    const long = structureSummary(`OK: x\n- ${"b".repeat(300)}`).bullets[0]!;
    expect(long).toBe(`${"b".repeat(199)}…`);
  });

  it("a 150-character verdict is cut to 120; the rest of its line is the first bullet", () => {
    const out = structureSummary(`OK: ${"v".repeat(119)}${"r".repeat(31)}\n- next`);
    expect(out.verdict).toBe(`${"v".repeat(119)}…`);
    expect(out.bullets).toEqual(["r".repeat(31), "next"]);
  });

  it("bidirectional and zero-width characters are removed", () => {
    expect(structureSummary("OK: a‮b​c").verdict).toBe("abc");
    expect(structureSummary("OK: visits\t18911").verdict).toBe("visits 18911");
    expect(structureSummary("OK: a\r- b").verdict).toBe("a - b");
    expect(structureSummary("OK: \u2800\u3164\nreal verdict").verdict).toBe("real verdict");
    expect(structureSummary("🇺🇸 OK: x").verdict).toBe("x");
  });

  it("caps count code points: an emoji at the edge is kept whole or cut whole", () => {
    const verdict = structureSummary(`OK: ${"v".repeat(118)}😀`).verdict;
    expect(verdict).toBe(`${"v".repeat(118)}😀`);
    const cut = structureSummary(`OK: ${"v".repeat(118)}😀😀😀\n- ${"b".repeat(198)}😀😀😀`);
    expect(Array.from(cut.verdict)).toHaveLength(120);
    expect(cut.verdict).toBe(`${"v".repeat(118)}😀…`);
    expect(cut.bullets[1]).toBe(`${"b".repeat(198)}😀…`);
    expect(/[\uD800-\uDFFF]/u.test(cut.bullets.join(""))).toBe(false);
  });

  it("adversarial sizes stay fast and within the caps; whitespace only is no verdict", () => {
    const started = Date.now();
    expect(structureSummary(" ".repeat(200_000)).verdict).toBe("");
    expect(structureSummary(`${" ".repeat(100_000)}x`).verdict).toBe("");
    expect(structureSummary("[".repeat(100_000) + "](x").verdict.length).toBeLessThanOrEqual(120);
    const many = structureSummary(`OK: x\n${"a. ".repeat(200_000)}`);
    expect(many.bullets).toEqual(["a.", "a.", "a.", "…"]);
    expect(structureSummary(`OK: ${"x".repeat(5000)}`).verdict).toBe(`${"x".repeat(119)}…`);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("a status word alone takes the next line as the verdict", () => {
    expect(structureSummary("OK:\nAll checks passed.")).toEqual({ status: "ok", verdict: "All checks passed.", bullets: [] });
  });

  it("only marks and blank lines: no verdict", () => {
    expect(structureSummary("\n- \n**\n---\n```\n")).toEqual({ verdict: "", bullets: [] });
  });

  it("a bullet continued on the next line without a mark is one bullet", () => {
    expect(structureSummary("OK: x\n- first part\n  second part\n- other").bullets).toEqual(["first part second part", "other"]);
  });
});

describe("noticeStatus", () => {
  it("failed, the summary's status word, else done", () => {
    expect(noticeStatus(rec({ status: "failed", error: "boom" }))).toBe("failed");
    expect(noticeStatus(rec({ result: { text: "r", summary: "OK: fine" } }))).toBe("ok");
    expect(noticeStatus(rec({ result: { text: "r", summary: "ATTENTION: look" } }))).toBe("attention");
    expect(noticeStatus(rec({ result: { text: "r", summary: "fine" } }))).toBe("done");
    expect(noticeStatus(rec({ result: { text: "OK: raw" } }))).toBe("done");
    expect(noticeStatus(rec({ result: { text: "r", summary: "OK:" } }))).toBe("done");
  });

  it("a redacted run is done whatever its summary says", () => {
    const bodyJson = JSON.stringify({ type: "command", command: "x", redactInReceipt: ["s"] });
    expect(noticeStatus(rec({ bodyJson, result: { text: "r", summary: "ATTENTION: s" } }))).toBe("done");
  });
});
