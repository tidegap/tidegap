import { describe, expect, it } from "vitest";
import { SlidingWindowLimiter } from "../src/ui/rate-limit.js";

describe("SlidingWindowLimiter", () => {
  it("counts per key and frees a slot when the oldest call leaves the window", () => {
    const limiter = new SlidingWindowLimiter(2, 10_000);
    expect(limiter.check("a", 0)).toBeUndefined();
    expect(limiter.check("a", 1_000)).toBeUndefined();
    expect(limiter.check("a", 2_000)).toBe(8);
    expect(limiter.check("b", 2_000)).toBeUndefined();
    expect(limiter.check("a", 10_000)).toBeUndefined();
  });

  it("drops idle keys once many are held", () => {
    const limiter = new SlidingWindowLimiter(1, 1_000);
    for (let i = 0; i < 300; i++) limiter.check(`k${i}`, 0);
    limiter.check("fresh", 5_000);
    const held = (limiter as unknown as { calls: Map<string, number[]> }).calls;
    expect([...held.keys()]).toEqual(["fresh"]);
  });
});
