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
import { verifyReceipt } from "../src/sign.js";
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

interface SignedVector {
  description: string;
  signedReceipt: Record<string, unknown>;
}

const signing = JSON.parse(
  readFileSync(new URL("./fixtures/cross-lang-receipt-vectors.json", import.meta.url), "utf8"),
) as { vectors: SignedVector[] };

const modelsVector = signing.vectors.find((v) => Array.isArray(v.signedReceipt.models));

describe("the signed `models` list (KTD5)", () => {
  it("the shared vectors include a multi-model receipt", () => {
    expect(modelsVector).toBeDefined();
    expect(verifyReceipt(modelsVector!.signedReceipt).outcome).toBe("valid");
  });

  const signed = (): Record<string, unknown> & { models: ReceiptModelEntry[] } =>
    structuredClone(modelsVector!.signedReceipt) as Record<string, unknown> & { models: ReceiptModelEntry[] };

  it("changing one entry's grams is tampering", () => {
    const r = signed();
    r.models[1]!.carbonGCo2 = 0.08;
    expect(verifyReceipt(r).outcome).toBe("tampered");
  });

  it("changing one entry's tokens is tampering", () => {
    const r = signed();
    r.models[1]!.inputTokens += 1;
    expect(verifyReceipt(r).outcome).toBe("tampered");
  });

  it("a second rendering of a field, at the top or in an entry, is tampering", () => {
    // Normalization keeps the last of two renderings, so without the check
    // the receipt shows the edited value and verifies against the other.
    const top = signed();
    top.actual_carbon_gCo2 = top.actualCarbonGCo2;
    top.actualCarbonGCo2 = 0.5;
    const entry = signed();
    (entry.models[0] as unknown as Record<string, unknown>).carbon_gCo2 = entry.models[0]!.carbonGCo2;
    entry.models[0]!.carbonGCo2 = 0.01;
    for (const r of [top, entry]) {
      const res = verifyReceipt(r);
      expect(res.outcome).toBe("tampered");
      expect(res.reason).toContain("two renderings");
    }
  });

  it("swapping two entries is tampering", () => {
    const r = signed();
    r.models = [r.models[1]!, r.models[0]!];
    expect(verifyReceipt(r).outcome).toBe("tampered");
  });

  it("deleting the list is tampering", () => {
    const r = signed();
    delete (r as Record<string, unknown>).models;
    expect(verifyReceipt(r).outcome).toBe("tampered");
  });
});
