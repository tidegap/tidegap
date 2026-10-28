/**
 * Per-model inference energy estimation.
 *
 * Replaces the v0.1–v0.9 flat `ENERGY_KWH_PER_TASK = 0.0015` placeholder
 * with cited per-model Wh/token coefficients drawn from public research.
 *
 * The flat constant is preserved as the backwards-compatible fallback
 * for callers that have no model information (closure-based `defer`,
 * pre-v0.10 telemetry replays, etc.). Callers that provide a `model`
 * name plus optional input/output token counts get calibrated math.
 *
 * ## Sources
 *
 * - **Patterson et al. 2021.** "Carbon Emissions and Large Neural
 *   Network Training." arXiv:2104.10350. Per-model training energy
 *   for GPT-3 / T5 / Meena / GShard / Switch. PUE 1.1 reference.
 * - **Luccioni, Jernite, Strubell 2024.** "Power Hungry Processing:
 *   Watts Driving the Cost of AI Deployment." FAccT 2024.
 *   arXiv:2311.16863. The first systematic per-task inference
 *   energy measurement across 88 models and 10 task classes.
 *   This is the primary source for the open-weight coefficients below.
 * - **Hugging Face AI Energy Score** (2024–). Living benchmark of
 *   measured Wh/query across hundreds of open-weight models.
 *   https://huggingface.co/AIEnergyScore
 *
 * ## Closed-model caveat
 *
 * For closed models (Anthropic Claude family, OpenAI GPT-4 family,
 * Google Gemini family) the per-token coefficients are **estimated**
 * — inferred from public parameter-count disclosures (where any
 * exist) and scaled along the Luccioni curve. They may be off by
 * ±50%. The `source` field on each entry records the confidence
 * tier so downstream UIs can communicate uncertainty.
 *
 * ## Power Usage Effectiveness (PUE)
 *
 * The published coefficients reflect chip-level draw. To get
 * grid-level energy you multiply by data-centre PUE. Tidegap uses
 * `DEFAULT_PUE = 1.15` (industry average for hyperscalers; Google
 * reports 1.10, AWS ~1.15, Azure ~1.18). Callers can override.
 */

import {
  DEFAULT_PUE as DEFAULT_PUE_DATA,
  ENERGY_SOURCES as ENERGY_SOURCES_DATA,
  LEGACY_KWH_PER_TASK as LEGACY_KWH_PER_TASK_DATA,
  MODEL_ENERGY_COEFFICIENTS as MODEL_ENERGY_COEFFICIENTS_DATA,
  MODEL_FAMILIES as MODEL_FAMILIES_DATA,
  TYPICAL_INPUT_TOKENS,
  TYPICAL_OUTPUT_TOKENS,
} from "./data/tables.generated.js";
import type { ModelUsage } from "./providers/base.js";
import type { ReceiptModelEntry } from "./types.js";

/** Confidence tier for a coefficient entry. */
export type EnergySourceTier = "measured" | "estimated" | "fallback";

/**
 * How a coefficient was resolved for a given model id (v0.13+). This is
 * the receipt's `energyResolution` provenance — orthogonal to the
 * `EnergySourceTier` confidence of the number itself:
 *
 *   - `exact`          — the id matched a table key verbatim (case-folded).
 *   - `normalized`     — matched after stripping dated / provider / order
 *                        variance (see `normalizeModelName`).
 *   - `family-fallback`— the id is unknown but its family is known, so a
 *                        family representative's coefficients were used.
 *   - `default`        — fully unrecognized; the flat legacy constant.
 */
export type EnergyResolutionTier =
  | "exact"
  | "normalized"
  | "family-fallback"
  | "default";

/** Lifecycle flag on a coefficient row (absent = current). */
export type ModelLifecycleStatus = "retired" | "deprecated";

/** Per-model inference energy coefficients (chip-level Wh, no PUE applied). */
export interface ModelEnergyCoefficients {
  /** Wh consumed per input (prompt) token. */
  whPerInputToken: number;
  /** Wh consumed per output (completion) token. */
  whPerOutputToken: number;
  /** Approximate total parameter count in billions (for context). */
  paramsB?: number;
  /** Provenance of the numbers. */
  source: EnergySourceTier;
  /**
   * Vendor lifecycle stage, when not current. `retired`: shut down, kept so
   * past receipts still resolve, never priced. `deprecated`: shutdown
   * announced, still callable and priced.
   */
  status?: ModelLifecycleStatus;
}

/**
 * A family-fallback rule. When a model id is unknown but recognizably a
 * member of a family, the family's `representative` supplies coefficients.
 * Sourced from the JSON SSOT; a rule matches when every present condition
 * (`contains` / `prefix` / `regex`) holds against the normalized id.
 */
export interface ModelFamily {
  id: string;
  representative: string;
  contains?: readonly string[];
  prefix?: string;
  regex?: string;
}

/** The outcome of resolving a model id to coefficients + a provenance tier. */
export interface ResolvedModelEnergy {
  coeffs: ModelEnergyCoefficients;
  tier: EnergyResolutionTier;
}

/** Industry-average Power Usage Effectiveness for hyperscaler data centres. */
export const DEFAULT_PUE = DEFAULT_PUE_DATA;

/** Backwards-compatible flat estimate. Used when no model is provided. */
export const LEGACY_KWH_PER_TASK = LEGACY_KWH_PER_TASK_DATA;

/**
 * Per-model coefficient table. Keys are canonical lowercase names
 * (no version-date suffixes; see `normalizeModelName`). Sourced from the
 * JSON SSOT via the generated data module.
 */
export const MODEL_ENERGY_COEFFICIENTS = MODEL_ENERGY_COEFFICIENTS_DATA;

/** Ordered family-fallback rules (from the JSON SSOT). */
export const MODEL_FAMILIES = MODEL_FAMILIES_DATA;

/**
 * Citation metadata for the coefficient table. Exported so dashboards
 * and receipts can render attribution alongside numbers.
 */
export const ENERGY_SOURCES = ENERGY_SOURCES_DATA;

const FALLBACK_COEFFICIENTS: ModelEnergyCoefficients = {
  whPerInputToken: LEGACY_KWH_PER_TASK * 1000 / (TYPICAL_INPUT_TOKENS + TYPICAL_OUTPUT_TOKENS),
  whPerOutputToken: LEGACY_KWH_PER_TASK * 1000 / (TYPICAL_INPUT_TOKENS + TYPICAL_OUTPUT_TOKENS),
  source: "fallback",
};

/**
 * Strip provider prefixes, version-date suffixes and normalise punctuation
 * and word order so callers can pass `"claude-sonnet-4-5-20251022"`,
 * `"anthropic/claude-3.5-sonnet"`, `"gpt-4o-2024-11-20"` or
 * `"us.anthropic.claude-opus-4-7-v1:0"` and still hit the canonical entry.
 */
export function normalizeModelName(model: string): string {
  let name = model.trim().toLowerCase();
  // Strip a path-style provider prefix ("anthropic/…", "meta-llama/…").
  if (name.includes("/")) name = name.slice(name.lastIndexOf("/") + 1);
  // Strip a Bedrock vendor prefix, with or without a region / global
  // inference-profile scope ("us.anthropic.…", "global.anthropic.…",
  // "anthropic.…").
  name = name.replace(
    /^(?:(?:us|eu|apac|global)\.)?(?:anthropic|meta|amazon|cohere|mistral|ai21|stability)\./,
    "",
  );
  // Strip a Bedrock trailing version tag (":0", ":1").
  name = name.replace(/:\d+$/, "");
  // Replace dots with dashes (`gpt-3.5-turbo` → `gpt-3-5-turbo`).
  name = name.replace(/\./g, "-");
  // Strip Anthropic / OpenAI dated suffix (-YYYYMMDD or -YYYY-MM-DD).
  name = name.replace(/-\d{4}-?\d{2}-?\d{2}$/, "");
  // Strip generic vendor suffixes (-latest, -preview, -v\d+, -\d{3,4}).
  name = name.replace(/-(latest|preview)$/, "");
  name = name.replace(/-v\d+$/, "");
  name = name.replace(/-\d{3,4}$/, "");
  // Canonicalize Claude word order: "claude-3-5-sonnet" → "claude-sonnet-3-5".
  const reordered = name.match(
    /^claude-(\d+(?:-\d+)*)-(opus|sonnet|haiku|fable|mythos)(-.*)?$/,
  );
  if (reordered) {
    name = `claude-${reordered[2]}-${reordered[1]}${reordered[3] ?? ""}`;
  }
  return name;
}

/**
 * Return the coefficients of the family representative for a normalized
 * model id, or `undefined` if no family rule matches. The first matching
 * rule (in `MODEL_FAMILIES` order) wins.
 */
function familyRepresentative(
  normalized: string,
): ModelEnergyCoefficients | undefined {
  for (const fam of MODEL_FAMILIES) {
    if (fam.prefix !== undefined && !normalized.startsWith(fam.prefix)) continue;
    if (fam.contains && !fam.contains.every((t) => normalized.includes(t))) {
      continue;
    }
    if (fam.regex !== undefined && !new RegExp(fam.regex).test(normalized)) {
      continue;
    }
    return MODEL_ENERGY_COEFFICIENTS[fam.representative];
  }
  return undefined;
}

/**
 * Resolve a (possibly messy) model id to coefficients plus the provenance
 * tier describing *how* the match was made. See {@link EnergyResolutionTier}.
 */
export function resolveModelEnergy(model?: string): ResolvedModelEnergy {
  if (!model) return { coeffs: FALLBACK_COEFFICIENTS, tier: "default" };
  const exact = MODEL_ENERGY_COEFFICIENTS[model.trim().toLowerCase()];
  if (exact) return { coeffs: exact, tier: "exact" };
  const normalized = normalizeModelName(model);
  const norm = MODEL_ENERGY_COEFFICIENTS[normalized];
  if (norm) return { coeffs: norm, tier: "normalized" };
  const family = familyRepresentative(normalized);
  if (family) return { coeffs: family, tier: "family-fallback" };
  return { coeffs: FALLBACK_COEFFICIENTS, tier: "default" };
}

/** Look up coefficients for a (possibly suffixed) model name. */
export function lookupModelEnergy(model?: string): ModelEnergyCoefficients {
  return resolveModelEnergy(model).coeffs;
}

export interface EstimateEnergyOpts {
  /** Provider model identifier; e.g. "claude-sonnet-5", "gpt-6-sol". */
  model?: string;
  /** Prompt tokens. If omitted with a known model, `TYPICAL_INPUT_TOKENS` is used. */
  inputTokens?: number;
  /** Completion tokens. If omitted with a known model, `TYPICAL_OUTPUT_TOKENS` is used. */
  outputTokens?: number;
  /** Override PUE. Defaults to `DEFAULT_PUE` (1.15). */
  pue?: number;
}

/**
 * Estimate the grid-level energy (kWh) for an inference call.
 *
 * Resolution order:
 *   1. No arguments at all → `LEGACY_KWH_PER_TASK` (0.0015 kWh). The
 *      v0.1–v0.9 flat estimate, preserved bit-exactly for backwards
 *      compatibility with closure-based `defer` and replays of
 *      pre-v0.10 telemetry.
 *   2. Unknown model name → same fallback.
 *   3. Known model, no token counts → typical-task estimate
 *      (`TYPICAL_INPUT_TOKENS` + `TYPICAL_OUTPUT_TOKENS`) times the
 *      model's coefficients, times PUE.
 *   4. Known model + token counts → exact per-token math, times PUE.
 */
export function estimateEnergyKwh(opts: EstimateEnergyOpts = {}): number {
  const { model, inputTokens, outputTokens, pue = DEFAULT_PUE } = opts;

  // Path 1: backwards-compat zero-knowledge call.
  if (
    model === undefined &&
    inputTokens === undefined &&
    outputTokens === undefined
  ) {
    return LEGACY_KWH_PER_TASK;
  }

  const { coeffs, tier } = resolveModelEnergy(model);

  // Path 2: fully-unrecognized model with no token counts → legacy flat.
  // The fallback entry intentionally encodes the same total energy as
  // `LEGACY_KWH_PER_TASK` when summed across typical token counts; this
  // keeps "unknown model" identical to "no model" so dashboards don't
  // accidentally show a behavioural change for unmodelled traffic. A
  // *family-recognized* unknown (tier "family-fallback") instead uses the
  // family representative's coefficients — the §1.8 family fallback.
  if (tier === "default" && inputTokens === undefined && outputTokens === undefined) {
    return LEGACY_KWH_PER_TASK;
  }

  const ins = inputTokens ?? TYPICAL_INPUT_TOKENS;
  const outs = outputTokens ?? TYPICAL_OUTPUT_TOKENS;

  const chipWh = ins * coeffs.whPerInputToken + outs * coeffs.whPerOutputToken;
  const gridWh = chipWh * pue;
  return gridWh / 1000;
}

/**
 * Grams CO2-equivalent for one inference call at a given grid intensity.
 * Convenience helper used by the scheduler scoring path.
 *
 * @param gCo2PerKwh  Grid carbon intensity at the dispatch hour.
 * @param opts        Per-model + token args, same shape as `estimateEnergyKwh`.
 */
export function gramsForIntensity(
  gCo2PerKwh: number,
  opts: EstimateEnergyOpts = {},
): number {
  return estimateEnergyKwh(opts) * gCo2PerKwh;
}

/** The bill of a run with two or more billed models (KTD7). */
export interface ModelUsageBill {
  /** Unrounded grams over every entry; undefined without an intensity. */
  carbonGCo2?: number;
  /**
   * The billed entries: reported output tokens descending (an unreported
   * output counts as 0), then model id ascending. An entry leaves out a
   * count its model did not report.
   */
  models: ReceiptModelEntry[];
  /** The first entry's model: the one with the most reported output tokens. */
  model: string;
  /**
   * The reported input and output tokens over every entry; undefined when
   * no entry reported a count, as the single-model path leaves it out.
   */
  totalTokens?: number;
  /** The weakest `energySource` across the entries. */
  energySource: EnergySourceTier;
  /** The weakest `energyResolution` across the entries. */
  energyResolution: EnergyResolutionTier;
}

/** Strongest last, so a lower rank is weaker. */
const SOURCE_RANK: Record<EnergySourceTier, number> = { fallback: 0, estimated: 1, measured: 2 };
const RESOLUTION_RANK: Record<EnergyResolutionTier, number> = {
  default: 0,
  "family-fallback": 1,
  normalized: 2,
  exact: 3,
};

/** A token count the bill can use: `canonicalize` throws on a non-finite number. */
const isCount = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;

/** The count when the model reported a usable one; otherwise undefined, an unreported count. */
const reported = (n: unknown): number | undefined => (isCount(n) ? n : undefined);

/**
 * Bill each model of a run with its own coefficients at one grid intensity
 * (KTD7). A count that is absent, not a number, negative or not finite is
 * unreported: it is billed at the typical count, as `estimateEnergyKwh`
 * does on the single-model path, and the entry and `totalTokens` leave it
 * out. When no entry reports a count, the bill has no `totalTokens`. An
 * entry that reports both counts as 0 is not billed. Returns undefined when
 * fewer than two entries are left: the caller then bills the run as one
 * model. Each entry's grams are rounded half up to 0.01 g; the total stays
 * unrounded.
 */
export function billModelUsage(
  intensityGCo2PerKwh: number | undefined,
  usage: readonly ModelUsage[],
): ModelUsageBill | undefined {
  const billed = usage
    .map((u) => ({ model: u.model, inputTokens: reported(u.inputTokens), outputTokens: reported(u.outputTokens) }))
    .filter((u) => !(u.inputTokens === 0 && u.outputTokens === 0))
    .sort(
      (a, b) =>
        (b.outputTokens ?? 0) - (a.outputTokens ?? 0) || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0),
    );
  if (billed.length < 2) return undefined;
  let carbonGCo2: number | undefined;
  let totalTokens: number | undefined;
  let energySource: EnergySourceTier = "measured";
  let energyResolution: EnergyResolutionTier = "exact";
  const models = billed.map(({ model, inputTokens, outputTokens }): ReceiptModelEntry => {
    const { coeffs, tier } = resolveModelEnergy(model);
    if (inputTokens !== undefined || outputTokens !== undefined) {
      totalTokens = (totalTokens ?? 0) + (inputTokens ?? 0) + (outputTokens ?? 0);
    }
    if (SOURCE_RANK[coeffs.source] < SOURCE_RANK[energySource]) energySource = coeffs.source;
    if (RESOLUTION_RANK[tier] < RESOLUTION_RANK[energyResolution]) energyResolution = tier;
    const grams =
      intensityGCo2PerKwh === undefined
        ? undefined
        : gramsForIntensity(intensityGCo2PerKwh, { model, inputTokens, outputTokens });
    if (grams !== undefined) carbonGCo2 = (carbonGCo2 ?? 0) + grams;
    return {
      model,
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(grams !== undefined ? { carbonGCo2: Math.round(grams * 100) / 100 } : {}),
      energySource: coeffs.source,
      energyResolution: tier,
    };
  });
  return {
    ...(carbonGCo2 !== undefined ? { carbonGCo2 } : {}),
    models,
    model: billed[0]!.model,
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    energySource,
    energyResolution,
  };
}
