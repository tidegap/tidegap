/** The `usage/v1` document's spend and Codex blocks and the summary form (U3, KTD10). */

import { describe, expect, it } from "vitest";

import { buildUsageDocument, summaryLimits, type ClaudeLimitState } from "../src/usage/index.js";

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
      expect(summaryLimits(unavailable, NOW)).toMatchObject({ line: "Claude: limits unavailable (no_data)", pct: null });
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });
});
