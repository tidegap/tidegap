import { describe, expect, it } from "vitest";

import { scrubCutEdges, scrubValues } from "../src/index.js";
import { DEFAULT_REDACTION_PATTERNS, redactPrompt, VENDOR_KEY_PREFIXES } from "../src/redact.js";

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

describe("scrubCutEdges: vendor key shapes at a cut (KTD13)", () => {
  // Each key at the shortest length its full pattern matches. Built at run
  // time: no key-shaped literal in the repo.
  const F = "Fixture0";
  const SAMPLES: Record<string, string> = {
    "sk-": `sk-${F.repeat(3).slice(0, 20)}`,
    // Same prefix, its own pattern; checked under "sk-" below.
    "sk-proj-": `sk-proj-${F.repeat(3).slice(0, 20)}`,
    "Bearer\\s+": `Bearer ${F.repeat(3).slice(0, 20)}`,
    AKIA: `AKIA${F.toUpperCase().repeat(2)}`,
    "gh[pousr]_": `ghp_${F.repeat(5).slice(0, 36)}`,
    github_pat_: `github_pat_${F.repeat(3).slice(0, 22)}`,
    AIza: `AIza${F.repeat(5).slice(0, 35)}`,
    xox: `xoxb-${F.repeat(2).slice(0, 10)}`,
    eyJ: `eyJ${F.repeat(2).slice(0, 10)}.eyJ${F.repeat(2).slice(0, 10)}.${F.repeat(2).slice(0, 10)}`,
  };

  it("every prefix has a sample key that its full pattern redacts, and every pattern has a sample", () => {
    for (const { prefix } of VENDOR_KEY_PREFIXES) {
      expect(SAMPLES[prefix], `sample for ${prefix}`).toBeDefined();
      expect(redactPrompt(SAMPLES[prefix]!, undefined)).toBe("[REDACTED]");
    }
    for (const pattern of DEFAULT_REDACTION_PATTERNS) {
      const hit = Object.values(SAMPLES).some((s) => new RegExp(pattern.source, pattern.flags).test(s));
      expect(hit, `a sample for ${pattern.source}`).toBe(true);
    }
  });

  it.each(VENDOR_KEY_PREFIXES.map(({ prefix }) => prefix))("a %s key cut one character short at the end is [redacted]", (prefix) => {
    const cut = SAMPLES[prefix]!.slice(0, -1);
    // The full pattern no longer matches the cut key.
    expect(redactPrompt(cut, undefined)).toBe(cut);
    expect(scrubCutEdges(`key: ${cut}`, [], { end: true })).toBe("key: [redacted]");
    expect(scrubCutEdges(`key: ${cut}�`, [], { end: true })).toBe("key: [redacted]");
  });

  it("a cut start that begins with 20 token characters of a key drops them", () => {
    const tail = SAMPLES["sk-"]!.slice(-20);
    expect(scrubCutEdges(`${tail} failed`, [], { start: true })).toBe("[redacted] failed");
  });

  it("a key tail at a cut start is dropped even when a secret value ends with its first character", () => {
    const tail = SAMPLES["sk-"]!.slice(-20);
    // The one-character value fragment must not stand in for the longer token.
    expect(scrubCutEdges(`${tail} failed`, [`hunter-secret-${tail[0]}`], { start: true })).toBe("[redacted] failed");
  });

  it("a short ordinary word at a cut edge is kept", () => {
    expect(scrubCutEdges("done in 3 steps", [], { start: true, end: true })).toBe("done in 3 steps");
    expect(scrubCutEdges("fifteen_chars_x rest", [], { start: true })).toBe("fifteen_chars_x rest");
  });

  it("a prefix with no key body after it leaves nothing to drop", () => {
    expect(scrubCutEdges("ask-", [], { end: true })).toBe("ask-");
  });

  // The trailing-key search reads the last 8 KiB of a cut end. Written here, not imported,
  // so a changed window fails: an exact-window key is found, one a character longer is not.
  const WINDOW = 8 * 1024;
  const before = `${"plain log text ".repeat(70_000).slice(0, 1024 * 1024)} `;
  const keyOf = (prefix: string, length: number) => prefix + F.repeat(Math.ceil(length / F.length)).slice(0, length - prefix.length);

  it("an sk- key that fills the window exactly at a cut end is [redacted]; the text before it stays", () => {
    const key = keyOf("sk-", WINDOW);
    expect(key).toHaveLength(WINDOW);
    expect(scrubCutEdges(before + key, [], { end: true })).toBe(`${before}[redacted]`);
  });

  it("an sk- key whose prefix sits one character before the window is left as it is", () => {
    const key = keyOf("sk-", WINDOW + 1);
    // The window starts at the "k" of "sk-": no other prefix is in it.
    expect(key.slice(-WINDOW).startsWith("k-")).toBe(true);
    expect(scrubCutEdges(before + key, [], { end: true })).toBe(before + key);
  });

  it("a ghp_ key that fills the window exactly is [redacted]: the word-boundary lookbehind holds at the window start", () => {
    const key = keyOf("ghp_", WINDOW);
    expect(key).toHaveLength(WINDOW);
    expect(scrubCutEdges(before + key, [], { end: true })).toBe(`${before}[redacted]`);
  });
});
