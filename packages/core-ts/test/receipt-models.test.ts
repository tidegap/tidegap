/**
 * Per-model billing of a multi-model run (KTD5-KTD9).
 *
 * The billing vectors in `test/fixtures/model-usage-billing-vectors.json`
 * are read by this suite and by
 * `packages/core-py/tests/test_model_usage_billing.py`: both cores must
 * produce the same numbers for the same input.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { billModelUsage } from "../src/energy.js";
import type { ModelUsage } from "../src/providers/base.js";
import type { ReceiptModelEntry } from "../src/types.js";

interface BillingVector {
  description: string;
  intensityGCo2PerKwh: number | null;
  modelUsage: Array<{ model: string; inputTokens: number | string; outputTokens: number | string }>;
  expected: {
    carbonGCo2: number | null;
    model: string;
    totalTokens: number;
    energySource: string;
    energyResolution: string;
    models: ReceiptModelEntry[];
  } | null;
}

const billing = JSON.parse(
  readFileSync(new URL("./fixtures/model-usage-billing-vectors.json", import.meta.url), "utf8"),
) as { vectors: BillingVector[] };

/** The fixture spells non-finite counts as strings; JSON has no NaN or Infinity. */
const count = (v: number | string): number =>
  typeof v === "number" ? v : v === "NaN" ? Number.NaN : v === "Infinity" ? Number.POSITIVE_INFINITY : Number(v);

const usageOf = (v: BillingVector): ModelUsage[] =>
  v.modelUsage.map((u) => ({ model: u.model, inputTokens: count(u.inputTokens), outputTokens: count(u.outputTokens) }));

describe("billModelUsage (shared vectors)", () => {
  it("has a vector for every rule", () => {
    expect(billing.vectors.length).toBeGreaterThanOrEqual(8);
  });

  for (const v of billing.vectors) {
    it(v.description, () => {
      const bill = billModelUsage(v.intensityGCo2PerKwh ?? undefined, usageOf(v));
      if (v.expected === null) {
        expect(bill).toBeUndefined();
        return;
      }
      expect(bill).toBeDefined();
      expect(bill!.models).toEqual(v.expected.models);
      expect(bill!.model).toBe(v.expected.model);
      expect(bill!.totalTokens).toBe(v.expected.totalTokens);
      expect(bill!.energySource).toBe(v.expected.energySource);
      expect(bill!.energyResolution).toBe(v.expected.energyResolution);
      if (v.expected.carbonGCo2 === null) {
        expect(bill!.carbonGCo2).toBeUndefined();
      } else {
        expect(bill!.carbonGCo2).toBeCloseTo(v.expected.carbonGCo2, 9);
      }
    });
  }

  it("does not reorder the caller's list", () => {
    const usage: ModelUsage[] = [
      { model: "claude-sonnet-5", inputTokens: 1, outputTokens: 1 },
      { model: "claude-opus-5-5", inputTokens: 1, outputTokens: 9 },
    ];
    billModelUsage(400, usage);
    expect(usage.map((u) => u.model)).toEqual(["claude-sonnet-5", "claude-opus-5-5"]);
  });
});
