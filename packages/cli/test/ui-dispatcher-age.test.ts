/** The dispatcher pill's "ran N min ago" does not count time the machine slept. */

import { describe, expect, it } from "vitest";

import { agoAwake } from "../ui/dom.js";
import { installFakeDom } from "./fixtures/fake-dom.js";

installFakeDom();

const last = Date.parse("2026-10-22T11:05:00Z");
const now = last + 60 * 60_000;
const ticker = (over: Record<string, unknown> = {}) => ({ last_tick_at: new Date(last).toISOString(), slept_s: 0, ...over });

describe("agoAwake", () => {
  it("is the wall-clock age without a sleep", () => {
    expect(agoAwake(last, ticker(), now)).toBe("1 h ago");
    expect(agoAwake(last, undefined, now)).toBe("1 h ago");
  });

  it("subtracts the sleep of the same tick", () => {
    expect(agoAwake(last, ticker({ slept_s: 55 * 60 }), now)).toBe("5 min ago");
  });

  it("ignores a sleep reading that belongs to another tick", () => {
    expect(agoAwake(last, ticker({ slept_s: 55 * 60, last_tick_at: new Date(last - 60_000).toISOString() }), now)).toBe("1 h ago");
  });

  it("never shows a negative age", () => {
    expect(agoAwake(last, ticker({ slept_s: 3 * 3600 }), now)).toBe("just now");
  });
});
