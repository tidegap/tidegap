/** KTD5 target rule and the KTD10 line. */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildUsageDocument, formatLine, resolveResetTarget } from "../src/usage/index.js";
import type { ClaudeLimitState } from "../src/usage/index.js";

const NOW = new Date("2026-10-17T12:00:00.000Z");
const R5 = "2026-10-17T16:30:00.000Z";
const R7 = "2026-10-20T09:00:00.000Z";

function state(five: number, seven: number, extra: Partial<ClaudeLimitState> = {}): ClaudeLimitState {
  return {
    status: "ok",
    source: "statusline",
    fetched_at: "2026-10-17T11:59:00.000Z",
    age_s: 60,
    stale: false,
    five_hour: { pct: five, resets_at: R5 },
    seven_day: { pct: seven, resets_at: R7 },
    scoped: [],
    ...extra,
  };
}

describe("resolveResetTarget (KTD5)", () => {
  it("5h at 100, 7d at 40: the 5h reset", async () => {
    const r = await resolveResetTarget(state(100, 40), { now: NOW });
    expect(r).toEqual({ ok: true, target: { at: new Date(R5), window: "five_hour", exhausted: true, pct: 100 } });
  });
  it("both at 100: the later reset", async () => {
    const r = await resolveResetTarget(state(100, 100), { now: NOW });
    expect(r.ok && r.target.at.toISOString()).toBe(R7);
  });
  it("5h at 72, 7d at 80: the 7d reset, not exhausted", async () => {
    const r = await resolveResetTarget(state(72, 80), { now: NOW });
    expect(r.ok && [r.target.window, r.target.exhausted]).toEqual(["seven_day", false]);
  });
  it("a tie goes to the 5h window", async () => {
    const r = await resolveResetTarget(state(50, 50), { now: NOW });
    expect(r.ok && r.target.window).toBe("five_hour");
  });
  it("no state: no target, with the cause", async () => {
    const r = await resolveResetTarget(
      { status: "unavailable", stale: false, scoped: [], error: { cause: "no_data", message: "no statusline reading yet" } },
      { now: NOW },
    );
    expect(r).toEqual({ ok: false, reason: "limit state unavailable: no statusline reading yet" });
  });
  it("a past reset re-reads once; still past gives now", async () => {
    let reads = 0;
    const past = state(100, 10, { five_hour: { pct: 100, resets_at: "2026-10-17T11:00:00.000Z" }, seven_day: { pct: 10, resets_at: "2026-10-17T10:00:00.000Z" } });
    const r = await resolveResetTarget(past, { now: NOW, reread: async () => ((reads += 1), past) });
    expect(reads).toBe(1);
    expect(r.ok && r.target.at.toISOString()).toBe(NOW.toISOString());
  });
  it("a scoped window counts only for its model", async () => {
    const s = state(30, 40, { scoped: [{ model: "Fable", pct: 100, resets_at: "2026-10-19T18:00:00.000Z" }] });
    const fable = await resolveResetTarget(s, { now: NOW, model: "fable" });
    expect(fable.ok && [fable.target.window, fable.target.exhausted]).toEqual(["Fable", true]);
    const sonnet = await resolveResetTarget(s, { now: NOW, model: "sonnet" });
    expect(sonnet.ok && sonnet.target.exhausted).toBe(false);
  });
});

describe("line and document (KTD10)", () => {
  let tz: string | undefined;
  beforeEach(() => {
    tz = process.env.TZ;
    process.env.TZ = "UTC";
  });
  afterEach(() => {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  });

  it("names the highest window with its local reset clock", () => {
    expect(formatLine(state(72, 40), NOW)).toBe("Claude 5h: 72%, resets 16:30");
    expect(formatLine(state(10, 40), NOW)).toBe("Claude 7d: 40%, resets Tue 09:00");
  });
  it("a stale value appends (as of HH:MM)", () => {
    expect(formatLine(state(72, 40, { stale: true, fetched_at: "2026-10-17T11:05:00.000Z" }), NOW)).toBe(
      "Claude 5h: 72%, resets 16:30 (as of 11:05)",
    );
  });
  it("a passed window is left out; disabled is empty; unavailable names the cause", () => {
    const passed = state(90, 40, { five_hour: { pct: 90, resets_at: "2026-10-17T11:00:00.000Z" } });
    expect(formatLine(passed, NOW)).toBe("Claude 7d: 40%, resets Tue 09:00");
    expect(formatLine({ status: "disabled", stale: false, scoped: [] }, NOW)).toBe("");
    expect(
      formatLine({ status: "unavailable", stale: false, scoped: [], error: { cause: "token_expired", message: "x" } }, NOW),
    ).toBe("Claude: limits unavailable (token_expired)");
  });
  it("the document carries schema, the state, the target and the line", () => {
    const doc = buildUsageDocument(state(72, 40), NOW);
    expect(doc).toMatchObject({
      schema: "usage/v1",
      generated_at: NOW.toISOString(),
      target_reset: { at: R5, window: "five_hour", exhausted: false },
      line: "Claude 5h: 72%, resets 16:30",
    });
    expect(doc.claude.five_hour?.pct).toBe(72);
  });
});
