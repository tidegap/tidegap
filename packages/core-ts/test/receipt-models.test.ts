/**
 * Per-model billing of a multi-model run (KTD5-KTD9), the single-model count
 * rule and the signed `tokenCounts` marker (batch 27, KTD1-KTD3).
 *
 * The billing vectors in `test/fixtures/model-usage-billing-vectors.json`
 * are read by this suite and by
 * `packages/core-py/tests/test_model_usage_billing.py`: both cores must
 * produce the same numbers for the same input.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { billModelUsage, gramsForIntensity, singleModelCounts, type RunUsage } from "../src/energy.js";
import { Scheduler, TaskStore } from "../src/index.js";
import { verifyReceipt } from "../src/sign.js";
import type { DispatchResult, ModelUsage, ProviderAdapter } from "../src/providers/base.js";
import type { CarbonReceipt, GridFeed, GridForecast, ReceiptModelEntry, TokenCounts } from "../src/types.js";

interface BillingVector {
  description: string;
  intensityGCo2PerKwh: number | null;
  /** An absent, null or non-number count is unreported (KTD6). */
  modelUsage: Array<{ model: string; inputTokens?: unknown; outputTokens?: unknown; partialInputTokens?: unknown }>;
  expected: {
    carbonGCo2: number | null;
    model: string;
    /** null: no billed entry reported a count, so the bill has no total. */
    totalTokens: number | null;
    energySource: string;
    energyResolution: string;
    models: ReceiptModelEntry[];
    /** null: every billed count was reported, so the bill has no marker. */
    tokenCounts: TokenCounts | null;
  } | null;
}

interface SingleModelVector {
  description: string;
  intensityGCo2PerKwh: number;
  model: string;
  usage: Record<string, unknown>;
  expected: { carbonGCo2: number; totalTokens: number | null; tokenCounts: TokenCounts | null };
}

const billing = JSON.parse(
  readFileSync(new URL("./fixtures/model-usage-billing-vectors.json", import.meta.url), "utf8"),
) as { vectors: BillingVector[]; singleModel: SingleModelVector[] };

/** The fixture spells non-finite counts as strings, as JSON has no NaN or Infinity; any other value stands for itself. */
const count = (v: unknown): unknown => (v === "NaN" ? Number.NaN : v === "Infinity" ? Number.POSITIVE_INFINITY : v);

const usageOf = (v: BillingVector): ModelUsage[] =>
  v.modelUsage.map(
    (u) =>
      ({
        model: u.model,
        inputTokens: count(u.inputTokens),
        outputTokens: count(u.outputTokens),
        ...("partialInputTokens" in u ? { partialInputTokens: count(u.partialInputTokens) } : {}),
      }) as ModelUsage,
  );

describe("billModelUsage (shared vectors)", () => {
  it("has a vector for every rule", () => {
    expect(billing.vectors.length).toBeGreaterThanOrEqual(14);
  });

  for (const v of billing.vectors) {
    it(v.description, () => {
      const bill = billModelUsage(v.intensityGCo2PerKwh ?? undefined, usageOf(v));
      if (v.expected === null) {
        expect(bill).toBeUndefined();
        return;
      }
      expect(bill).toBeDefined();
      // Strict: an unreported count is left out of the entry, not set to undefined.
      expect(bill!.models).toStrictEqual(v.expected.models);
      expect(bill!.model).toBe(v.expected.model);
      // A total no entry reported is left out, not set to undefined.
      expect("totalTokens" in bill!).toBe(v.expected.totalTokens !== null);
      expect(bill!.totalTokens).toBe(v.expected.totalTokens ?? undefined);
      expect(bill!.energySource).toBe(v.expected.energySource);
      expect(bill!.energyResolution).toBe(v.expected.energyResolution);
      // A fully reported bill has no marker key at all.
      expect("tokenCounts" in bill!).toBe(v.expected.tokenCounts !== null);
      expect(bill!.tokenCounts).toBe(v.expected.tokenCounts ?? undefined);
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

  it("a total that overflows to Infinity is left out, so the receipt can still be signed", () => {
    const bill = billModelUsage(300, [
      { model: "claude-sonnet-5", inputTokens: 0, outputTokens: 1e308 },
      { model: "claude-haiku-5-5", inputTokens: 0, outputTokens: 1e308 },
    ]);
    expect(bill).toBeDefined();
    expect("totalTokens" in bill!).toBe(false);
    expect("tokenCounts" in bill!).toBe(false);
    expect(Number.isFinite(bill!.carbonGCo2)).toBe(true);
  });
});

describe("singleModelCounts (shared vectors)", () => {
  it("has a vector for every rule", () => {
    expect(billing.singleModel.length).toBeGreaterThanOrEqual(11);
  });

  for (const v of billing.singleModel) {
    it(v.description, () => {
      const usage = Object.fromEntries(Object.entries(v.usage).map(([k, c]) => [k, count(c)])) as RunUsage;
      const counts = singleModelCounts(usage);
      // Strict: an unreported total or a fully reported run leaves the key out.
      expect("totalTokens" in counts).toBe(v.expected.totalTokens !== null);
      expect(counts.totalTokens).toBe(v.expected.totalTokens ?? undefined);
      expect("tokenCounts" in counts).toBe(v.expected.tokenCounts !== null);
      expect(counts.tokenCounts).toBe(v.expected.tokenCounts ?? undefined);
      const grams = gramsForIntensity(v.intensityGCo2PerKwh, {
        model: v.model,
        inputTokens: counts.inputTokens,
        outputTokens: counts.outputTokens,
      });
      expect(Number.isFinite(grams)).toBe(true);
      expect(grams).toBeCloseTo(v.expected.carbonGCo2, 9);
    });
  }

  it("a run that gives no total shows none, even with both counts (Python sums them; not unified)", () => {
    expect(singleModelCounts({ inputTokens: 1200, outputTokens: 300 })).toStrictEqual({ inputTokens: 1200, outputTokens: 300 });
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
    const entry = r.models[1]!;
    entry.inputTokens = entry.inputTokens! + 1;
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

/** A feed at one intensity every hour; later calls throw once `failAfterCalls` is used up. */
function flatFeed(intensity: number, failAfterCalls?: number): GridFeed {
  let calls = 0;
  return {
    source: "mock",
    async fetchForecast(region: string): Promise<GridForecast> {
      calls += 1;
      if (failAfterCalls !== undefined && calls > failAfterCalls) throw new Error("feed down");
      const now = Date.now();
      return {
        region,
        source: "mock",
        generatedAt: new Date(now).toISOString(),
        entries: Array.from({ length: 6 }, (_, h) => ({
          datetime: new Date(now + h * 3_600_000).toISOString(),
          carbonIntensityGCo2PerKwh: intensity,
          band: "clean" as const,
        })),
      };
    },
  };
}

/** An adapter that reports the given usage and per-model list. */
function reporting(result: Partial<DispatchResult>): ProviderAdapter {
  return {
    provider: "anthropic",
    ready: true,
    async dispatch(model) {
      return { text: "ok", model, provider: "anthropic", raw: null, ...result };
    },
  };
}

const OPUS_AND_HAIKU: ModelUsage[] = [
  { model: "claude-haiku-5-5", inputTokens: 500, outputTokens: 120 },
  { model: "claude-opus-5-5", inputTokens: 4030, outputTokens: 900 },
];

describe("a multi-model dispatch (U7)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-receipt-models-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function dispatchOne(s: Scheduler, adapter: ProviderAdapter): Promise<CarbonReceipt> {
    const rec = await s.enqueueProviderCall(
      { type: "provider_call", provider: "anthropic", model: "claude-opus-5-5", prompt: "hi" },
      { deadline: new Date(Date.now() + 3_600_000), region: "FR" },
    );
    const entry = await s.expediteTask(rec.taskId, { anthropic: adapter });
    expect(entry.status).toBe("completed");
    return s.getTask(rec.taskId)!.receipt!;
  }

  it("bills every model, orders the list and signs it", async () => {
    const s = new Scheduler({ feed: flatFeed(180), signing: { keyPath: join(dir, "signing.key") } });
    const receipt = await dispatchOne(
      s,
      reporting({ model: "claude-opus-5-5", usage: { inputTokens: 4530, outputTokens: 1020, totalTokens: 5550 }, modelUsage: OPUS_AND_HAIKU }),
    );
    // opus 4030 x 0.003 + 900 x 0.015 Wh, haiku (family) 500 x 0.0003 + 120 x 0.0015 Wh; x 1.15 / 1000 x 180.
    expect(receipt.actualCarbonGCo2).toBe(5.4);
    expect(receipt.totalTokens).toBe(5550);
    expect(receipt.model).toBe("claude-opus-5-5");
    expect(receipt.energySource).toBe("estimated");
    expect(receipt.energyResolution).toBe("family-fallback");
    expect(receipt.models).toEqual([
      { model: "claude-opus-5-5", inputTokens: 4030, outputTokens: 900, carbonGCo2: 5.3, energySource: "estimated", energyResolution: "exact" },
      { model: "claude-haiku-5-5", inputTokens: 500, outputTokens: 120, carbonGCo2: 0.07, energySource: "estimated", energyResolution: "family-fallback" },
    ]);
    expect(verifyReceipt(receipt).outcome).toBe("valid");
    s.shutdown();
  });

  it("one billed model in the list gives the single-model receipt", async () => {
    const usage = { inputTokens: 4030, outputTokens: 900, totalTokens: 4930 };
    const s = new Scheduler({ feed: flatFeed(180), signing: false });
    const listed = await dispatchOne(
      s,
      reporting({
        model: "claude-opus-5-5",
        usage,
        modelUsage: [{ model: "claude-opus-5-5", inputTokens: 4030, outputTokens: 900 }, { model: "claude-haiku-5-5", inputTokens: 0, outputTokens: 0 }],
      }),
    );
    const plain = await dispatchOne(s, reporting({ model: "claude-opus-5-5", usage }));
    expect(listed.models).toBeUndefined();
    const billed = (r: CarbonReceipt) => [r.actualCarbonGCo2, r.totalTokens, r.model, r.energySource, r.energyResolution];
    expect(billed(listed)).toEqual(billed(plain));
    expect(billed(plain)).toEqual([5.3, 4930, "claude-opus-5-5", "estimated", "exact"]);
    s.shutdown();
  });

  it("without the receipt-side intensity, entries carry no grams and the receipt still signs", async () => {
    const s = new Scheduler({ feed: flatFeed(180, 1), signing: { keyPath: join(dir, "signing.key") } });
    const receipt = await dispatchOne(
      s,
      reporting({ model: "claude-opus-5-5", usage: { inputTokens: 4530, outputTokens: 1020, totalTokens: 5550 }, modelUsage: OPUS_AND_HAIKU }),
    );
    expect(receipt.intensityGCo2PerKwh).toBeUndefined();
    expect(receipt.actualCarbonGCo2).toBe(receipt.estimatedCarbonGCo2);
    expect(receipt.models?.map((m) => m.model)).toEqual(["claude-opus-5-5", "claude-haiku-5-5"]);
    expect(receipt.models?.some((m) => "carbonGCo2" in m)).toBe(false);
    expect(verifyReceipt(receipt).outcome).toBe("valid");
    s.shutdown();
  });

  it("a multi-model receipt with an unreported count signs and verifies valid", async () => {
    const s = new Scheduler({ feed: flatFeed(180), signing: { keyPath: join(dir, "signing.key") } });
    const receipt = await dispatchOne(
      s,
      reporting({
        model: "claude-haiku-5-5",
        usage: { inputTokens: 4530, outputTokens: 120 },
        modelUsage: [{ model: "claude-opus-5-5", inputTokens: 4030 }, { model: "claude-haiku-5-5", inputTokens: 500, outputTokens: 120 }],
      }),
    );
    // opus 4030 x 0.003 + 500 (typical output) x 0.015 Wh, haiku (family) 500 x 0.0003 + 120 x 0.0015 Wh; x 1.15 / 1000 x 180.
    expect(receipt.actualCarbonGCo2).toBe(4.1);
    // The reported counts only: opus's output is not in the sum.
    expect(receipt.totalTokens).toBe(4650);
    // An unreported output counts as 0 for the order.
    expect(receipt.model).toBe("claude-haiku-5-5");
    expect(receipt.models).toStrictEqual([
      { model: "claude-haiku-5-5", inputTokens: 500, outputTokens: 120, carbonGCo2: 0.07, energySource: "estimated", energyResolution: "family-fallback" },
      { model: "claude-opus-5-5", inputTokens: 4030, carbonGCo2: 4.06, energySource: "estimated", energyResolution: "exact" },
    ]);
    expect(verifyReceipt(receipt).outcome).toBe("valid");
    s.shutdown();
  });

  it("a completed record with models round-trips through the store", async () => {
    const dbPath = join(dir, "queue.db");
    const s = new Scheduler({ feed: flatFeed(180), dbPath, signing: { keyPath: join(dir, "signing.key") } });
    const receipt = await dispatchOne(
      s,
      reporting({ model: "claude-opus-5-5", usage: { inputTokens: 4530, outputTokens: 1020, totalTokens: 5550 }, modelUsage: OPUS_AND_HAIKU }),
    );
    s.shutdown();
    const store = new TaskStore({ dbPath });
    const stored = store.list().find((r) => r.receipt?.models)?.receipt;
    store.close();
    expect(stored).toEqual(JSON.parse(JSON.stringify(receipt)));
    expect(verifyReceipt(stored!).outcome).toBe("valid");
  });
});

describe("a shared ledger (U8)", () => {
  it("a Python-written receipt with models (snake_case keys) reads back from the Node store and verifies", () => {
    const dir = mkdtempSync(join(tmpdir(), "tidegap-receipt-models-"));
    try {
      const camel = modelsVector!.signedReceipt;
      // Python's CarbonReceipt.to_dict(): snake_case top-level keys; models, tools and session as they are.
      const snake = Object.fromEntries(
        Object.entries(camel).map(([k, v]) => [k.replace(/([A-Z])/g, "_$1").toLowerCase(), v]),
      );
      const store = new TaskStore({ dbPath: join(dir, "queue.db") });
      store.upsert({
        taskId: "py-models",
        status: "completed",
        enqueuedAt: "2026-10-28T03:00:00.000Z",
        region: "FR",
        receipt: snake as unknown as CarbonReceipt,
      });
      const read = store.get("py-models")?.receipt as unknown as Record<string, unknown>;
      store.close();
      expect(read.models).toEqual(camel.models);
      expect(verifyReceipt(read).outcome).toBe("valid");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const vectorFor = (taskId: string): Record<string, unknown> => {
  const v = signing.vectors.find((x) => (x.signedReceipt.taskId ?? x.signedReceipt.task_id) === taskId);
  expect(v, taskId).toBeDefined();
  return structuredClone(v!.signedReceipt);
};

describe("the signed `tokenCounts` marker (batch 27, KTD1)", () => {
  it("the shared vectors cover typical, partial with models, and the Python rendering", () => {
    expect(vectorFor("vec-tokens-typical").tokenCounts).toBe("typical");
    expect(vectorFor("vec-tokens-partial-models").tokenCounts).toBe("partial");
    expect(vectorFor("vec-tokens-partial-py").token_counts).toBe("partial");
    for (const id of ["vec-tokens-typical", "vec-tokens-partial-models", "vec-tokens-partial-py"]) {
      expect(verifyReceipt(vectorFor(id)).outcome, id).toBe("valid");
    }
  });

  it("changing the marker is tampering", () => {
    const r = vectorFor("vec-tokens-typical");
    r.tokenCounts = "partial";
    expect(verifyReceipt(r).outcome).toBe("tampered");
    const py = vectorFor("vec-tokens-partial-py");
    py.token_counts = "typical";
    expect(verifyReceipt(py).outcome).toBe("tampered");
  });

  it("deleting the marker is tampering", () => {
    const r = vectorFor("vec-tokens-partial-models");
    delete r.tokenCounts;
    expect(verifyReceipt(r).outcome).toBe("tampered");
    const py = vectorFor("vec-tokens-partial-py");
    delete py.token_counts;
    expect(verifyReceipt(py).outcome).toBe("tampered");
  });

  it("adding a marker to a fully reported receipt is tampering, in either key form", () => {
    for (const [id, key] of [
      ["vec-models-v2", "tokenCounts"],
      ["vec-models-v2", "token_counts"],
      ["vec-3-py-snake", "token_counts"],
      ["vec-3-py-snake", "tokenCounts"],
    ] as const) {
      const r = vectorFor(id);
      expect("tokenCounts" in r || "token_counts" in r, id).toBe(false);
      expect(verifyReceipt(r).outcome, id).toBe("valid");
      r[key] = "partial";
      expect(verifyReceipt(r).outcome, `${id} + ${key}`).toBe("tampered");
    }
  });

  it("a second rendering of the marker is tampering", () => {
    const py = vectorFor("vec-tokens-partial-py");
    py.tokenCounts = "partial";
    expect(verifyReceipt(py).outcome).toBe("tampered");
    const camel = vectorFor("vec-tokens-typical");
    camel.token_counts = "typical";
    expect(verifyReceipt(camel).outcome).toBe("tampered");
  });

  it("a Python receipt with token_counts reads back from the Node store as tokenCounts and verifies", () => {
    const dir = mkdtempSync(join(tmpdir(), "tidegap-receipt-tokens-"));
    try {
      const snake = vectorFor("vec-tokens-partial-py");
      const store = new TaskStore({ dbPath: join(dir, "queue.db") });
      store.upsert({
        taskId: "py-tokens",
        status: "completed",
        enqueuedAt: "2026-10-30T05:00:00.000Z",
        region: "SE",
        receipt: snake as unknown as CarbonReceipt,
      });
      const read = store.get("py-tokens")?.receipt;
      const stored = store.storedReceipt("py-tokens");
      store.close();
      expect(read?.tokenCounts).toBe("partial");
      expect(verifyReceipt(read as unknown as Record<string, unknown>).outcome).toBe("valid");
      expect(verifyReceipt(stored!).outcome).toBe("valid");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** A Batch-capable adapter whose one completed result reports `usage`. */
function batchReporting(usage: Record<string, unknown>): ProviderAdapter {
  return {
    provider: "anthropic",
    ready: true,
    async dispatch(model) {
      return { text: "sync", model, provider: "anthropic", raw: null };
    },
    async dispatchBatch(_model, prompts) {
      return { batchId: "batch-tokens", provider: "anthropic", size: prompts.length };
    },
    async retrieveBatch() {
      return { status: "completed", results: [{ text: "batch-result", model: "claude-sonnet-5", usage }] };
    },
  } as ProviderAdapter;
}

describe("tokenCounts on provider-call receipts (U2)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-receipt-tokens-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function dispatchOne(s: Scheduler, adapter: ProviderAdapter): Promise<CarbonReceipt> {
    const rec = await s.enqueueProviderCall(
      { type: "provider_call", provider: "anthropic", model: "claude-opus-5-5", prompt: "hi" },
      { deadline: new Date(Date.now() + 3_600_000), region: "FR" },
    );
    const entry = await s.expediteTask(rec.taskId, { anthropic: adapter });
    expect(entry.status).toBe("completed");
    const receipt = s.getTask(rec.taskId)!.receipt;
    expect(receipt).toBeDefined();
    return receipt!;
  }

  it("an absent input is billed at 500 and the receipt says partial, with no total (AE1)", async () => {
    const s = new Scheduler({ feed: flatFeed(180), signing: { keyPath: join(dir, "signing.key") } });
    const receipt = await dispatchOne(s, reporting({ model: "claude-opus-5-5", usage: { outputTokens: 120 } }));
    // opus 500 (typical input) x 0.003 + 120 x 0.015 Wh; x 1.15 / 1000 x 180.
    expect(receipt.actualCarbonGCo2).toBe(0.7);
    expect(receipt.tokenCounts).toBe("partial");
    expect(receipt.totalTokens).toBeUndefined();
    expect(verifyReceipt(receipt).outcome).toBe("valid");
    s.shutdown();
  });

  it("a run that reports every count has no tokenCounts key, in memory and in the ledger", async () => {
    const dbPath = join(dir, "queue.db");
    const s = new Scheduler({ feed: flatFeed(180), dbPath, signing: { keyPath: join(dir, "signing.key") } });
    const receipt = await dispatchOne(
      s,
      reporting({ model: "claude-opus-5-5", usage: { inputTokens: 4030, outputTokens: 900, totalTokens: 4930 } }),
    );
    s.shutdown();
    expect("tokenCounts" in receipt).toBe(false);
    expect(receipt.totalTokens).toBe(4930);
    const store = new TaskStore({ dbPath });
    const stored = store.storedReceipt(receipt.taskId);
    store.close();
    expect(stored && "tokenCounts" in stored).toBe(false);
  });

  it("a negative input is billed at 500, says partial, and a receipt is still written (AE3)", async () => {
    const s = new Scheduler({ feed: flatFeed(180), signing: { keyPath: join(dir, "signing.key") } });
    const receipt = await dispatchOne(
      s,
      reporting({ model: "claude-opus-5-5", usage: { inputTokens: -3000, outputTokens: 50, totalTokens: -2950 } }),
    );
    // opus 500 x 0.003 + 50 x 0.015 Wh; x 1.15 / 1000 x 180 = 0.46575.
    expect(receipt.actualCarbonGCo2).toBe(0.5);
    expect(receipt.tokenCounts).toBe("partial");
    expect(receipt.totalTokens).toBeUndefined();
    expect(verifyReceipt(receipt).outcome).toBe("valid");
    s.shutdown();
  });

  it("NaN and Infinity counts no longer drop the receipt: a typical call, typical", async () => {
    const s = new Scheduler({ feed: flatFeed(180), signing: { keyPath: join(dir, "signing.key") } });
    const receipt = await dispatchOne(
      s,
      reporting({
        model: "claude-opus-5-5",
        usage: { inputTokens: Number.NaN, outputTokens: Number.POSITIVE_INFINITY, totalTokens: Number.NaN },
      }),
    );
    // opus 500 x 0.003 + 500 x 0.015 Wh; x 1.15 / 1000 x 180 = 1.863.
    expect(receipt.actualCarbonGCo2).toBe(1.9);
    expect(receipt.tokenCounts).toBe("typical");
    expect(receipt.totalTokens).toBeUndefined();
    expect(verifyReceipt(receipt).outcome).toBe("valid");
    s.shutdown();
  });

  it("an input reported in part bills the larger of its parts and the typical count on the single-model path", async () => {
    const s = new Scheduler({ feed: flatFeed(180), signing: false });
    const above = await dispatchOne(
      s,
      reporting({ model: "claude-opus-5-5", usage: { partialInputTokens: 90000, outputTokens: 400 } }),
    );
    // opus 90000 x 0.003 + 400 x 0.015 Wh; x 1.15 / 1000 x 180 = 57.132.
    expect(above.actualCarbonGCo2).toBe(57.1);
    expect(above.tokenCounts).toBe("partial");
    const below = await dispatchOne(s, reporting({ model: "claude-opus-5-5", usage: { partialInputTokens: 4, outputTokens: 50 } }));
    // The typical 500 input, as AE3.
    expect(below.actualCarbonGCo2).toBe(0.5);
    expect(below.tokenCounts).toBe("partial");
    s.shutdown();
  });

  it("a multi-model receipt with an input reported in part bills it and says partial (AE2)", async () => {
    const s = new Scheduler({ feed: flatFeed(300), signing: { keyPath: join(dir, "signing.key") } });
    const receipt = await dispatchOne(
      s,
      reporting({
        model: "claude-sonnet-5",
        usage: { inputTokens: 300, outputTokens: 460 },
        modelUsage: [
          { model: "claude-sonnet-5", partialInputTokens: 90000, outputTokens: 400 },
          { model: "claude-haiku-5-5", inputTokens: 300, outputTokens: 60 },
        ],
      }),
    );
    expect(receipt.actualCarbonGCo2).toBe(31.8);
    expect(receipt.totalTokens).toBe(760);
    expect(receipt.tokenCounts).toBe("partial");
    expect(receipt.models?.[0]).toStrictEqual({
      model: "claude-sonnet-5",
      outputTokens: 400,
      carbonGCo2: 31.74,
      energySource: "estimated",
      energyResolution: "exact",
    });
    expect(verifyReceipt(receipt).outcome).toBe("valid");
    s.shutdown();
  });

  it("a Batch receipt whose result lacks an output count says partial", async () => {
    const s = new Scheduler({ feed: flatFeed(180), signing: { keyPath: join(dir, "signing.key") } });
    const adapter = batchReporting({ inputTokens: 300 });
    const rec = await s.enqueueProviderCall(
      { type: "provider_call", provider: "anthropic", model: "claude-sonnet-5", prompt: "hello" },
      { deadline: new Date(Date.now() + 60 * 3_600_000), region: "FR", taskId: "bt-tokens" },
    );
    expect((await s.tick({ anthropic: adapter })).batchSubmitted).toBe(1);
    await s.tick({ anthropic: adapter });
    const done = s.getTask(rec.taskId);
    expect(done?.status).toBe("completed");
    // sonnet 300 x 0.001 + 500 (typical output) x 0.005 Wh; x 1.15 / 1000 x 180 = 0.5796.
    expect(done?.receipt?.actualCarbonGCo2).toBe(0.6);
    expect(done?.receipt?.tokenCounts).toBe("partial");
    expect(done?.receipt?.totalTokens).toBeUndefined();
    expect(verifyReceipt(done!.receipt!).outcome).toBe("valid");
    s.shutdown();
  });

  it("an adapter total beside an unreported count is left out, on the sync and the Batch path", async () => {
    // Adapters add input and output after checking only `!== undefined`:
    // -3000 + 5000 gives 2000, a total that includes a rejected count.
    const usage = { inputTokens: -3000, outputTokens: 5000, totalTokens: 2000 };
    const s = new Scheduler({ feed: flatFeed(180), signing: false });
    const sync = await dispatchOne(s, reporting({ model: "claude-opus-5-5", usage }));
    expect(sync.tokenCounts).toBe("partial");
    expect(sync.totalTokens).toBeUndefined();
    const rec = await s.enqueueProviderCall(
      { type: "provider_call", provider: "anthropic", model: "claude-sonnet-5", prompt: "hello" },
      { deadline: new Date(Date.now() + 60 * 3_600_000), region: "FR", taskId: "bt-tokens-total" },
    );
    const adapter = batchReporting(usage);
    await s.tick({ anthropic: adapter });
    await s.tick({ anthropic: adapter });
    const batch = s.getTask(rec.taskId)?.receipt;
    expect(batch?.tokenCounts).toBe("partial");
    expect(batch?.totalTokens).toBeUndefined();
    s.shutdown();
  });

  it("a Batch receipt with every count reported has no tokenCounts key", async () => {
    const s = new Scheduler({ feed: flatFeed(180), signing: false });
    const adapter = batchReporting({ inputTokens: 300, outputTokens: 40, totalTokens: 340 });
    const rec = await s.enqueueProviderCall(
      { type: "provider_call", provider: "anthropic", model: "claude-sonnet-5", prompt: "hello" },
      { deadline: new Date(Date.now() + 60 * 3_600_000), region: "FR", taskId: "bt-tokens-full" },
    );
    await s.tick({ anthropic: adapter });
    await s.tick({ anthropic: adapter });
    const receipt = s.getTask(rec.taskId)?.receipt;
    expect(receipt?.totalTokens).toBe(340);
    expect(receipt && "tokenCounts" in receipt).toBe(false);
    s.shutdown();
  });

  it("a closure (defer) receipt has no tokenCounts", async () => {
    const s = new Scheduler({ feed: flatFeed(180), signing: false });
    await s.defer(async () => 42, { deadline: new Date(Date.now() + 200) });
    const receipt = s.listTasks()[0]?.receipt;
    expect(receipt).toBeDefined();
    expect("tokenCounts" in receipt!).toBe(false);
    s.shutdown();
  });
});
