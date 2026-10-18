/** The `usage/v1` document's spend and Codex blocks and the summary form (U3, KTD10). */

import { describe, expect, it } from "vitest";

import { buildUsageDocument, deadlineReader, summaryLimits, type ClaudeLimitState } from "../src/usage/index.js";

const NOW = new Date("2026-10-17T12:00:00.000Z");
const ok: ClaudeLimitState = {
  status: "ok",
  source: "statusline",
  stale: false,
  five_hour: { pct: 72, resets_at: "2026-10-17T16:30:00.000Z" },
  seven_day: { pct: 40, resets_at: "2026-10-20T09:00:00.000Z" },
  scoped: [],
};

describe("usage/v1 document", () => {
  it("carries codex and claude_spend only when the host read them", () => {
    expect(Object.keys(buildUsageDocument(ok, NOW))).not.toContain("codex");
    const doc = buildUsageDocument(ok, NOW, { codex: { status: "not_found" } });
    expect(doc.codex).toEqual({ status: "not_found" });
    expect(doc).not.toHaveProperty("claude_spend");
  });

  it("summary limits: the line and the window it names", () => {
    const tz = process.env.TZ;
    process.env.TZ = "UTC";
    try {
      expect(summaryLimits(ok, NOW)).toEqual({
        line: "Claude 5h: 72%, resets 16:30",
        status: "ok",
        window: "five_hour",
        pct: 72,
        resets_at: "2026-10-17T16:30:00.000Z",
      });
      expect(summaryLimits({ status: "disabled", stale: false, scoped: [] }, NOW)).toEqual({
        line: "",
        status: "disabled",
        window: null,
        pct: null,
        resets_at: null,
      });
      const unavailable: ClaudeLimitState = {
        status: "unavailable",
        stale: false,
        scoped: [],
        error: { cause: "no_data", message: "no statusline reading yet" },
      };
      // No reading ever: an empty line; another cause is named.
      expect(summaryLimits(unavailable, NOW)).toMatchObject({ line: "", status: "unavailable", pct: null });
      const expired = { ...unavailable, error: { cause: "token_expired" as const, message: "expired" } };
      expect(summaryLimits(expired, NOW)).toMatchObject({ line: "Claude: limits unavailable (token_expired)" });
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });
});

describe("deadlineReader (the /api/summary read)", () => {
  const later = <T>(value: T, ms: number) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

  it("one read in flight; past the deadline the last result, before any result a rejection", async () => {
    let calls = 0;
    let delay = 0;
    const read = deadlineReader(() => (calls++, later(`r${calls}`, delay)), 30);
    expect(await read()).toBe("r1");
    delay = 200;
    const [a, b] = await Promise.all([read(), read()]);
    expect([a, b, calls]).toEqual(["r1", "r1", 2]);
    await later(null, 250);
    delay = 0;
    expect(await read()).toBe("r3");

    const cold = deadlineReader(() => later("x", 200), 30);
    await expect(cold()).rejects.toThrow("timed out");
  });

  it("a failed read falls back to the last result", async () => {
    let fail = false;
    const read = deadlineReader(() => (fail ? Promise.reject(new Error("boom")) : Promise.resolve("ok")), 50);
    expect(await read()).toBe("ok");
    fail = true;
    expect(await read()).toBe("ok");
  });
});
