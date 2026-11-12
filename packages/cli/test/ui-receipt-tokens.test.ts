/**
 * The page's receipt "tokens" row names the token-count marker in the words
 * the CLI and MCP use (batch 27, R6).
 */
import { readFileSync } from "node:fs";

import { TOKEN_COUNTS_PARTIAL_TEXT, TOKEN_COUNTS_TYPICAL_TEXT } from "@tidegap/core";
import { describe, expect, it } from "vitest";

import { receiptTokens, tokenCountsText } from "../ui/detail.js";

describe("the page's token-count words", () => {
  it("names each marker value and nothing for an absent field", () => {
    expect(tokenCountsText("partial")).toBe(TOKEN_COUNTS_PARTIAL_TEXT);
    expect(tokenCountsText("typical")).toBe(TOKEN_COUNTS_TYPICAL_TEXT);
    expect(tokenCountsText(undefined)).toBeNull();
    expect(tokenCountsText("something-else")).toBeNull();
  });

  it("the tokens row shows the total, the marker, or both", () => {
    expect(receiptTokens({ totalTokens: 1500 })).toBe("1500");
    expect(receiptTokens({ totalTokens: 760, tokenCounts: "partial" })).toBe(`760 · ${TOKEN_COUNTS_PARTIAL_TEXT}`);
    expect(receiptTokens({ tokenCounts: "typical" })).toBe(TOKEN_COUNTS_TYPICAL_TEXT);
    expect(receiptTokens({})).toBeNull();
  });

  it("detail.js carries the core's words verbatim (the page cannot import the core)", () => {
    const source = readFileSync(new URL("../ui/detail.js", import.meta.url), "utf8");
    expect(source).toContain(`"${TOKEN_COUNTS_PARTIAL_TEXT}"`);
    expect(source).toContain(`"${TOKEN_COUNTS_TYPICAL_TEXT}"`);
  });
});
