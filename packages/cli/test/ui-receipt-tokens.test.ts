/**
 * The page's receipt "tokens" row names the token-count marker in the words
 * the CLI and MCP use (batch 27, R6).
 */
import { describe, expect, it } from "vitest";

import { receiptTokens, tokenCountsText } from "../ui/detail.js";

describe("the page's token-count words", () => {
  it("names each marker value and nothing for an absent field", () => {
    expect(tokenCountsText("partial")).toBe("partial (a token count was not reported; billed at the typical count)");
    expect(tokenCountsText("typical")).toBe("typical (no token count reported; billed as a typical call)");
    expect(tokenCountsText(undefined)).toBeNull();
    expect(tokenCountsText("something-else")).toBeNull();
  });

  it("the tokens row shows the total, the marker, or both", () => {
    expect(receiptTokens({ totalTokens: 1500 })).toBe("1500");
    expect(receiptTokens({ totalTokens: 760, tokenCounts: "partial" })).toBe(
      "760 · partial (a token count was not reported; billed at the typical count)",
    );
    expect(receiptTokens({ tokenCounts: "typical" })).toBe("typical (no token count reported; billed as a typical call)");
    expect(receiptTokens({})).toBeNull();
  });
});
