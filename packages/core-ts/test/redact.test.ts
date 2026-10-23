import { describe, expect, it } from "vitest";

import { scrubCutEdges, scrubValues } from "../src/index.js";

describe("scrubValues", () => {
  it("replaces an exact value", () => {
    expect(scrubValues("token=abcd1234", ["abcd1234"])).toBe("token=[redacted]");
  });

  it("matches a value with regex metacharacters literally", () => {
    const value = "a.b*c+(d)$";
    expect(scrubValues(`x ${value} y axbxc`, [value])).toBe("x [redacted] y axbxc");
  });

  it("leaves values shorter than 4 characters alone", () => {
    expect(scrubValues("abc abcd", ["abc"])).toBe("abc abcd");
  });

  it("replaces the longest value first and every occurrence", () => {
    expect(scrubValues("pass1234 pass1234-extra pass1234", ["pass1234", "pass1234-extra"])).toBe(
      "[redacted] [redacted] [redacted]",
    );
  });
});

describe("scrubCutEdges", () => {
  const value = "pw-4f9KqZ";

  it("redacts the head of a value left at a cut end", () => {
    expect(scrubCutEdges("log: pw-4f9", [value], { end: true })).toBe("log: [redacted]");
  });

  it("redacts the tail of a value left at a cut start", () => {
    expect(scrubCutEdges("KqZ done", [value], { start: true })).toBe("[redacted] done");
  });

  it("drops the U+FFFD a cut inside a UTF-8 sequence leaves", () => {
    expect(scrubCutEdges("log: pw-4\uFFFD", [value], { end: true })).toBe("log: [redacted]");
  });

  it("leaves an uncut edge and unrelated text alone", () => {
    expect(scrubCutEdges("log: pw-4f9", [value], {})).toBe("log: pw-4f9");
    expect(scrubCutEdges("all fine", [value], { start: true, end: true })).toBe("all fine");
  });

  it("takes the longest fragment over all values", () => {
    expect(scrubCutEdges("x pw-4f9K", ["9K-other", value], { end: true })).toBe("x [redacted]");
  });
});
