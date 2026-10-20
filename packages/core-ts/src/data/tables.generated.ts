/**
 * GENERATED — DO NOT EDIT.
 *
 * Produced by scripts/gen-data.mjs from packages/core-ts/src/data/*.json.
 * Edit those JSON files and run 'pnpm gen:data' to regenerate. CI fails
 * on drift ('pnpm gen:data:check').
 */
import type { ModelEnergyCoefficients, ModelFamily } from "../energy.js";
import type { ModelPrice } from "../routing.js";
import type { RegionCatalogEntry } from "../region.js";
import type { GridForecastEntry } from "../types.js";

/** Industry-average Power Usage Effectiveness for hyperscaler data centres. */
export const DEFAULT_PUE = 1.15;

/** Backwards-compatible flat estimate. Used when no model is provided. */
export const LEGACY_KWH_PER_TASK = 0.0015;

/** Typical token shape used when a caller names a model but no token counts. */
export const TYPICAL_INPUT_TOKENS = 500;
export const TYPICAL_OUTPUT_TOKENS = 500;

/** Per-model coefficient table. Keys are canonical lowercase names. */
export const MODEL_ENERGY_COEFFICIENTS: Readonly<
  Record<string, ModelEnergyCoefficients>
> = Object.freeze({
  "claude-fable-5-1": { whPerInputToken: 0.003, whPerOutputToken: 0.015, source: "estimated" },
  "claude-fable-5": { whPerInputToken: 0.003, whPerOutputToken: 0.015, source: "estimated" },
  "claude-opus-5-5": { whPerInputToken: 0.003, whPerOutputToken: 0.015, source: "estimated" },
  "claude-opus-5": { whPerInputToken: 0.003, whPerOutputToken: 0.015, source: "estimated" },
  "claude-opus-4-8": { whPerInputToken: 0.003, whPerOutputToken: 0.015, source: "estimated" },
  "claude-opus-4": { whPerInputToken: 0.003, whPerOutputToken: 0.015, paramsB: 400, source: "estimated", status: "deprecated" },
  "claude-opus-4-7": { whPerInputToken: 0.003, whPerOutputToken: 0.015, paramsB: 400, source: "estimated" },
  "claude-opus-4-6": { whPerInputToken: 0.003, whPerOutputToken: 0.015, paramsB: 400, source: "estimated" },
  "claude-opus-4-5": { whPerInputToken: 0.003, whPerOutputToken: 0.015, source: "estimated" },
  "claude-opus-4-1": { whPerInputToken: 0.003, whPerOutputToken: 0.015, paramsB: 400, source: "estimated", status: "retired" },
  "claude-opus-3": { whPerInputToken: 0.003, whPerOutputToken: 0.015, paramsB: 400, source: "estimated", status: "retired" },
  "claude-sonnet-5": { whPerInputToken: 0.001, whPerOutputToken: 0.005, source: "estimated" },
  "claude-sonnet-4": { whPerInputToken: 0.001, whPerOutputToken: 0.005, paramsB: 70, source: "estimated", status: "deprecated" },
  "claude-sonnet-4-6": { whPerInputToken: 0.001, whPerOutputToken: 0.005, paramsB: 70, source: "estimated" },
  "claude-sonnet-4-5": { whPerInputToken: 0.001, whPerOutputToken: 0.005, paramsB: 70, source: "estimated" },
  "claude-sonnet-3-7": { whPerInputToken: 0.001, whPerOutputToken: 0.005, paramsB: 70, source: "estimated", status: "retired" },
  "claude-sonnet-3-5": { whPerInputToken: 0.001, whPerOutputToken: 0.005, paramsB: 70, source: "estimated", status: "retired" },
  "claude-sonnet-3": { whPerInputToken: 0.001, whPerOutputToken: 0.005, paramsB: 70, source: "estimated", status: "retired" },
  "claude-haiku-4-5": { whPerInputToken: 0.0003, whPerOutputToken: 0.0015, paramsB: 13, source: "estimated" },
  "claude-haiku-3-5": { whPerInputToken: 0.0003, whPerOutputToken: 0.0015, paramsB: 13, source: "estimated", status: "retired" },
  "claude-haiku-3": { whPerInputToken: 0.0003, whPerOutputToken: 0.0015, paramsB: 13, source: "estimated", status: "retired" },
  "gpt-6-astra": { whPerInputToken: 0.003, whPerOutputToken: 0.015, source: "estimated" },
  "gpt-6-sol": { whPerInputToken: 0.001, whPerOutputToken: 0.005, source: "estimated" },
  "gpt-6-luna": { whPerInputToken: 0.0003, whPerOutputToken: 0.0015, source: "estimated" },
  "gpt-5": { whPerInputToken: 0.003, whPerOutputToken: 0.015, source: "estimated" },
  "gpt-5-mini": { whPerInputToken: 0.0006, whPerOutputToken: 0.003, source: "estimated" },
  "gpt-5-nano": { whPerInputToken: 0.0003, whPerOutputToken: 0.0015, source: "estimated" },
  "gpt-4o": { whPerInputToken: 0.002, whPerOutputToken: 0.01, paramsB: 200, source: "estimated" },
  "gpt-4o-mini": { whPerInputToken: 0.0006, whPerOutputToken: 0.003, paramsB: 30, source: "estimated" },
  "gpt-4-1": { whPerInputToken: 0.002, whPerOutputToken: 0.01, source: "estimated" },
  "gpt-4-1-mini": { whPerInputToken: 0.0006, whPerOutputToken: 0.003, source: "estimated" },
  "gpt-4-1-nano": { whPerInputToken: 0.0003, whPerOutputToken: 0.0015, source: "estimated" },
  "gpt-4-turbo": { whPerInputToken: 0.003, whPerOutputToken: 0.015, paramsB: 400, source: "estimated", status: "deprecated" },
  "gpt-4": { whPerInputToken: 0.005, whPerOutputToken: 0.025, paramsB: 1000, source: "estimated", status: "deprecated" },
  "gpt-3-5-turbo": { whPerInputToken: 0.0003, whPerOutputToken: 0.0015, paramsB: 20, source: "estimated" },
  "o1": { whPerInputToken: 0.003, whPerOutputToken: 0.015, paramsB: 400, source: "estimated" },
  "o1-mini": { whPerInputToken: 0.0006, whPerOutputToken: 0.003, paramsB: 30, source: "estimated", status: "retired" },
  "o3": { whPerInputToken: 0.003, whPerOutputToken: 0.015, paramsB: 400, source: "estimated" },
  "o3-mini": { whPerInputToken: 0.0006, whPerOutputToken: 0.003, paramsB: 30, source: "estimated", status: "deprecated" },
  "gemini-3-1-pro": { whPerInputToken: 0.002, whPerOutputToken: 0.01, source: "estimated" },
  "gemini-3-8-flash": { whPerInputToken: 0.0003, whPerOutputToken: 0.0015, source: "estimated" },
  "gemini-3-5-flash-lite": { whPerInputToken: 0.0003, whPerOutputToken: 0.0015, source: "estimated" },
  "gemini-1-5-pro": { whPerInputToken: 0.002, whPerOutputToken: 0.01, paramsB: 200, source: "estimated", status: "retired" },
  "gemini-1-5-flash": { whPerInputToken: 0.0003, whPerOutputToken: 0.0015, paramsB: 20, source: "estimated", status: "retired" },
  "gemini-2-0-flash": { whPerInputToken: 0.0003, whPerOutputToken: 0.0015, paramsB: 20, source: "estimated", status: "retired" },
  "gemini-2-0-pro": { whPerInputToken: 0.002, whPerOutputToken: 0.01, paramsB: 200, source: "estimated", status: "retired" },
  "llama-3-1-405b": { whPerInputToken: 0.005, whPerOutputToken: 0.025, paramsB: 405, source: "measured" },
  "llama-3-1-70b": { whPerInputToken: 0.001, whPerOutputToken: 0.005, paramsB: 70, source: "measured" },
  "llama-3-1-8b": { whPerInputToken: 0.0002, whPerOutputToken: 0.001, paramsB: 8, source: "measured" },
  "llama-3-70b": { whPerInputToken: 0.001, whPerOutputToken: 0.005, paramsB: 70, source: "measured" },
  "llama-3-8b": { whPerInputToken: 0.0002, whPerOutputToken: 0.001, paramsB: 8, source: "measured" },
  "llama-4-scout": { whPerInputToken: 0.0006, whPerOutputToken: 0.003, source: "estimated" },
  "llama-4-maverick": { whPerInputToken: 0.001, whPerOutputToken: 0.005, source: "estimated" },
  "mistral-small-4": { whPerInputToken: 0.0006, whPerOutputToken: 0.003, source: "estimated" },
  "mistral-medium-3-5": { whPerInputToken: 0.001, whPerOutputToken: 0.005, source: "estimated" },
  "mistral-large-3": { whPerInputToken: 0.003, whPerOutputToken: 0.015, source: "estimated" },
  "mistral-7b": { whPerInputToken: 0.0002, whPerOutputToken: 0.001, paramsB: 7, source: "measured" },
  "mixtral-8x7b": { whPerInputToken: 0.0006, whPerOutputToken: 0.003, paramsB: 47, source: "measured" },
  "mixtral-8x22b": { whPerInputToken: 0.0015, whPerOutputToken: 0.0075, paramsB: 141, source: "measured" },
});

/**
 * Ordered family-fallback rules. The first rule whose conditions all hold
 * (see familyRepresentative in energy.ts) supplies coefficients for an
 * otherwise-unknown model id in that family.
 */
export const MODEL_FAMILIES: readonly ModelFamily[] = Object.freeze([
  { id: "claude-fable", representative: "claude-fable-5-1", contains: ["fable"] },
  { id: "claude-mythos", representative: "claude-fable-5-1", contains: ["mythos"] },
  { id: "claude-opus", representative: "claude-opus-5", contains: ["opus"] },
  { id: "claude-sonnet", representative: "claude-sonnet-5", contains: ["sonnet"] },
  { id: "claude-haiku", representative: "claude-haiku-4-5", contains: ["haiku"] },
  { id: "gpt-6", representative: "gpt-6-sol", prefix: "gpt-6" },
  { id: "gpt-5", representative: "gpt-5", prefix: "gpt-5" },
  { id: "gpt-4o", representative: "gpt-4o", prefix: "gpt-4o" },
  { id: "gpt-4-1", representative: "gpt-4-1", prefix: "gpt-4-1" },
  { id: "gpt-4", representative: "gpt-4", prefix: "gpt-4" },
  { id: "gpt-3", representative: "gpt-3-5-turbo", prefix: "gpt-3" },
  { id: "openai-o", representative: "o3", regex: "^o[0-9]" },
  { id: "gemini-flash", representative: "gemini-3-8-flash", contains: ["flash"], prefix: "gemini" },
  { id: "gemini-pro", representative: "gemini-3-1-pro", prefix: "gemini" },
  { id: "mixtral", representative: "mixtral-8x7b", prefix: "mixtral" },
  { id: "mistral", representative: "mistral-7b", prefix: "mistral" },
  { id: "llama", representative: "llama-3-1-70b", prefix: "llama" },
]);

/** Citation metadata for the coefficient table. */
export const ENERGY_SOURCES = Object.freeze({
  "patterson2021": {
    "citation": "Patterson et al. 2021, 'Carbon Emissions and Large Neural Network Training'",
    "arxiv": "2104.10350"
  },
  "luccioni2024": {
    "citation": "Luccioni, Jernite, Strubell 2024, 'Power Hungry Processing'",
    "venue": "FAccT 2024",
    "arxiv": "2311.16863"
  },
  "huggingface": {
    "citation": "Hugging Face AI Energy Score",
    "url": "https://huggingface.co/AIEnergyScore"
  }
});

/** Synthetic-curve region midpoints (gCO2/kWh). */
export const REGION_FLOORS: Readonly<Record<string, number>> = Object.freeze({
  "US-CAL-CISO": 280,
  "US-TEX-ERCO": 340,
  "US-NE-ISNE": 320,
  "US-MIDA-PJM": 420,
  "GB": 220,
  "FR": 60,
  "DE": 380,
  "IE": 340,
  "NL": 350,
  "ES": 160,
  "BE": 140,
  "AT": 110,
  "PL": 650,
  "JP-TK": 470,
  "KR": 430,
  "SG": 420,
  "AU-NSW": 500,
  "CA-ON": 50,
  "US-NY-NYIS": 360,
  "US-MIDW-MISO": 460,
  "US-NW-BPAT": 110,
  "US-FLA-FPL": 400,
  "IT-NO": 320,
  "SE-SE3": 40,
  "NO-NO1": 30,
  "FI": 120,
  "DK-DK1": 180,
  "IN-WE": 700,
  "ZA": 700,
  "AE": 620,
  "NZ": 80,
});

/** Fallback midpoint for regions with no explicit floor. */
export const DEFAULT_REGION_FLOOR = 380;

/** Peak-to-trough half-swing of the synthetic curve (gCO2/kWh). */
export const SYNTHETIC_AMPLITUDE = 220;

/** Per-region UTC-hour offset applied to the synthetic curve's local trough. */
export const REGION_UTC_OFFSETS: Readonly<Record<string, number>> = Object.freeze({
  "US-CAL-CISO": -8,
  "US-TEX-ERCO": -6,
  "US-NE-ISNE": -5,
  "US-MIDA-PJM": -5,
  "GB": 0,
  "FR": 1,
  "DE": 1,
  "IE": 0,
  "NL": 1,
  "ES": 1,
  "BE": 1,
  "AT": 1,
  "PL": 1,
  "JP-TK": 9,
  "KR": 9,
  "SG": 8,
  "AU-NSW": 10,
  "CA-ON": -5,
  "US-NY-NYIS": -5,
  "US-MIDW-MISO": -6,
  "US-NW-BPAT": -8,
  "US-FLA-FPL": -5,
  "IT-NO": 1,
  "SE-SE3": 1,
  "NO-NO1": 1,
  "FI": 2,
  "DK-DK1": 1,
  "IN-WE": 5,
  "ZA": 2,
  "AE": 4,
  "NZ": 12,
});

/**
 * Supported grid zones for people: name, ISO country code, country name and
 * grid operator. Keys equal REGION_FLOORS and the website's zone list.
 */
export const REGION_CATALOG: Readonly<Record<string, RegionCatalogEntry>> = Object.freeze({
  "US-CAL-CISO": { name: "California", country: "US", countryName: "United States", operator: "California ISO (CAISO)" },
  "US-TEX-ERCO": { name: "Texas", country: "US", countryName: "United States", operator: "ERCOT" },
  "US-NE-ISNE": { name: "New England", country: "US", countryName: "United States", operator: "ISO New England" },
  "US-MIDA-PJM": { name: "PJM Mid-Atlantic", country: "US", countryName: "United States", operator: "PJM Interconnection" },
  "GB": { name: "Great Britain", country: "GB", countryName: "United Kingdom", operator: "National Energy System Operator (NESO)" },
  "FR": { name: "France", country: "FR", countryName: "France", operator: "RTE" },
  "DE": { name: "Germany", country: "DE", countryName: "Germany", operator: "50Hertz, Amprion, TenneT, TransnetBW" },
  "IE": { name: "Ireland", country: "IE", countryName: "Ireland", operator: "EirGrid" },
  "NL": { name: "Netherlands", country: "NL", countryName: "Netherlands", operator: "TenneT" },
  "ES": { name: "Spain", country: "ES", countryName: "Spain", operator: "Red Eléctrica (REE)" },
  "BE": { name: "Belgium", country: "BE", countryName: "Belgium", operator: "Elia" },
  "AT": { name: "Austria", country: "AT", countryName: "Austria", operator: "Austrian Power Grid (APG)" },
  "PL": { name: "Poland", country: "PL", countryName: "Poland", operator: "PSE" },
  "JP-TK": { name: "Tokyo", country: "JP", countryName: "Japan", operator: "TEPCO Power Grid" },
  "KR": { name: "South Korea", country: "KR", countryName: "South Korea", operator: "Korea Power Exchange (KPX)" },
  "SG": { name: "Singapore", country: "SG", countryName: "Singapore", operator: "Energy Market Authority (EMA)" },
  "AU-NSW": { name: "New South Wales", country: "AU", countryName: "Australia", operator: "AEMO" },
  "CA-ON": { name: "Ontario", country: "CA", countryName: "Canada", operator: "IESO" },
  "US-NY-NYIS": { name: "New York", country: "US", countryName: "United States", operator: "NYISO" },
  "US-MIDW-MISO": { name: "Midcontinent", country: "US", countryName: "United States", operator: "MISO" },
  "US-NW-BPAT": { name: "Pacific Northwest", country: "US", countryName: "United States", operator: "Bonneville Power Administration (BPA)" },
  "US-FLA-FPL": { name: "Florida", country: "US", countryName: "United States", operator: "Florida Power & Light (FPL)" },
  "IT-NO": { name: "Northern Italy", country: "IT", countryName: "Italy", operator: "Terna" },
  "SE-SE3": { name: "Central Sweden (SE3)", country: "SE", countryName: "Sweden", operator: "Svenska kraftnät" },
  "NO-NO1": { name: "Southeast Norway (NO1)", country: "NO", countryName: "Norway", operator: "Statnett" },
  "FI": { name: "Finland", country: "FI", countryName: "Finland", operator: "Fingrid" },
  "DK-DK1": { name: "West Denmark (DK1)", country: "DK", countryName: "Denmark", operator: "Energinet" },
  "IN-WE": { name: "Western India", country: "IN", countryName: "India", operator: "Grid Controller of India" },
  "ZA": { name: "South Africa", country: "ZA", countryName: "South Africa", operator: "Eskom" },
  "AE": { name: "United Arab Emirates", country: "AE", countryName: "United Arab Emirates", operator: "EWEC and DEWA" },
  "NZ": { name: "New Zealand", country: "NZ", countryName: "New Zealand", operator: "Transpower" },
});

/** Band thresholds (ascending). A value maps to the first band it is below. */
export const BAND_THRESHOLDS: readonly {
  maxExclusive: number;
  band: GridForecastEntry["band"];
}[] = Object.freeze([
  { maxExclusive: 100, band: "very_clean" },
  { maxExclusive: 250, band: "clean" },
  { maxExclusive: 450, band: "average" },
  { maxExclusive: 700, band: "dirty" },
]);

/** Band for values at or above every threshold. */
export const DEFAULT_BAND: GridForecastEntry["band"] = "very_dirty";

/** Month the price table figures were read (see prices.json). */
export const PRICES_AS_OF = "2026-09";

/**
 * Per-model public list prices (USD per million tokens), keyed by the same
 * canonical lowercase ids as MODEL_ENERGY_COEFFICIENTS. Ollama-routable
 * open-weight models are 0 (self-hosted). Used by cross-provider routing's
 * cost dimension. LIST prices, not the caller's negotiated rate.
 */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = Object.freeze({
  "claude-fable-5-1": { inUsdPerMtok: 10, outUsdPerMtok: 50, batchDiscount: 0.5, asOf: "2026-09", source: "Anthropic pricing (platform.claude.com/docs/en/about-claude/pricing)" },
  "claude-fable-5": { inUsdPerMtok: 10, outUsdPerMtok: 50, batchDiscount: 0.5, asOf: "2026-09", source: "Anthropic pricing (platform.claude.com/docs/en/about-claude/pricing)" },
  "claude-opus-5-5": { inUsdPerMtok: 4, outUsdPerMtok: 20, batchDiscount: 0.5, asOf: "2026-09", source: "Anthropic pricing (platform.claude.com/docs/en/about-claude/pricing)" },
  "claude-opus-5": { inUsdPerMtok: 5, outUsdPerMtok: 25, batchDiscount: 0.5, asOf: "2026-09", source: "Anthropic pricing (platform.claude.com/docs/en/about-claude/pricing)" },
  "claude-opus-4-8": { inUsdPerMtok: 5, outUsdPerMtok: 25, batchDiscount: 0.5, asOf: "2026-09", source: "Anthropic pricing (platform.claude.com/docs/en/about-claude/pricing)" },
  "claude-opus-4": { inUsdPerMtok: 15, outUsdPerMtok: 75, batchDiscount: 0.5, asOf: "2026-07", source: "Anthropic pricing (anthropic.com/pricing)" },
  "claude-opus-4-7": { inUsdPerMtok: 5, outUsdPerMtok: 25, batchDiscount: 0.5, asOf: "2026-09", source: "Anthropic pricing (platform.claude.com/docs/en/about-claude/pricing)" },
  "claude-opus-4-6": { inUsdPerMtok: 5, outUsdPerMtok: 25, batchDiscount: 0.5, asOf: "2026-09", source: "Anthropic pricing (platform.claude.com/docs/en/about-claude/pricing)" },
  "claude-sonnet-5": { inUsdPerMtok: 2, outUsdPerMtok: 10, batchDiscount: 0.5, asOf: "2026-09", source: "Anthropic pricing (platform.claude.com/docs/en/about-claude/pricing)" },
  "claude-sonnet-4": { inUsdPerMtok: 3, outUsdPerMtok: 15, batchDiscount: 0.5, asOf: "2026-07", source: "Anthropic pricing (anthropic.com/pricing)" },
  "claude-sonnet-4-6": { inUsdPerMtok: 3, outUsdPerMtok: 15, batchDiscount: 0.5, asOf: "2026-07", source: "Anthropic pricing (anthropic.com/pricing)" },
  "claude-sonnet-4-5": { inUsdPerMtok: 3, outUsdPerMtok: 15, batchDiscount: 0.5, asOf: "2026-07", source: "Anthropic pricing (anthropic.com/pricing)" },
  "claude-haiku-4-5": { inUsdPerMtok: 1, outUsdPerMtok: 5, batchDiscount: 0.5, asOf: "2026-07", source: "Anthropic pricing (anthropic.com/pricing)" },
  "gpt-6-astra": { inUsdPerMtok: 10, outUsdPerMtok: 50, batchDiscount: 0.5, asOf: "2026-09", source: "OpenAI API pricing (developers.openai.com/api/docs/pricing)" },
  "gpt-6-sol": { inUsdPerMtok: 2, outUsdPerMtok: 10, batchDiscount: 0.5, asOf: "2026-09", source: "OpenAI API pricing (developers.openai.com/api/docs/pricing)" },
  "gpt-6-luna": { inUsdPerMtok: 0.1, outUsdPerMtok: 0.5, batchDiscount: 0.5, asOf: "2026-09", source: "OpenAI API pricing (developers.openai.com/api/docs/pricing)" },
  "gpt-4o": { inUsdPerMtok: 2.5, outUsdPerMtok: 10, batchDiscount: 0.5, asOf: "2026-07", source: "OpenAI API pricing (openai.com/api/pricing)" },
  "gpt-4o-mini": { inUsdPerMtok: 0.15, outUsdPerMtok: 0.6, batchDiscount: 0.5, asOf: "2026-07", source: "OpenAI API pricing (openai.com/api/pricing)" },
  "gpt-4-turbo": { inUsdPerMtok: 10, outUsdPerMtok: 30, batchDiscount: 0.5, asOf: "2026-07", source: "OpenAI API pricing (openai.com/api/pricing)" },
  "gpt-4": { inUsdPerMtok: 30, outUsdPerMtok: 60, batchDiscount: 0.5, asOf: "2026-07", source: "OpenAI API pricing (openai.com/api/pricing)" },
  "gpt-3-5-turbo": { inUsdPerMtok: 0.5, outUsdPerMtok: 1.5, batchDiscount: 0.5, asOf: "2026-07", source: "OpenAI API pricing (openai.com/api/pricing)" },
  "o1": { inUsdPerMtok: 15, outUsdPerMtok: 60, batchDiscount: 0.5, asOf: "2026-07", source: "OpenAI API pricing (openai.com/api/pricing)" },
  "o3": { inUsdPerMtok: 2, outUsdPerMtok: 8, batchDiscount: 0.5, asOf: "2026-07", source: "OpenAI API pricing (openai.com/api/pricing)" },
  "o3-mini": { inUsdPerMtok: 1.1, outUsdPerMtok: 4.4, batchDiscount: 0.5, asOf: "2026-07", source: "OpenAI API pricing (openai.com/api/pricing)" },
  "llama-3-1-405b": { inUsdPerMtok: 0, outUsdPerMtok: 0, asOf: "2026-07", source: "Ollama local (self-hosted; no per-token vendor price)" },
  "llama-3-1-70b": { inUsdPerMtok: 0, outUsdPerMtok: 0, asOf: "2026-07", source: "Ollama local (self-hosted; no per-token vendor price)" },
  "llama-3-1-8b": { inUsdPerMtok: 0, outUsdPerMtok: 0, asOf: "2026-07", source: "Ollama local (self-hosted; no per-token vendor price)" },
  "llama-3-70b": { inUsdPerMtok: 0, outUsdPerMtok: 0, asOf: "2026-07", source: "Ollama local (self-hosted; no per-token vendor price)" },
  "llama-3-8b": { inUsdPerMtok: 0, outUsdPerMtok: 0, asOf: "2026-07", source: "Ollama local (self-hosted; no per-token vendor price)" },
  "llama-4-scout": { inUsdPerMtok: 0, outUsdPerMtok: 0, asOf: "2026-09", source: "Ollama local (self-hosted; no per-token vendor price)" },
  "llama-4-maverick": { inUsdPerMtok: 0, outUsdPerMtok: 0, asOf: "2026-09", source: "Ollama local (self-hosted; no per-token vendor price)" },
  "mistral-small-4": { inUsdPerMtok: 0, outUsdPerMtok: 0, asOf: "2026-09", source: "Ollama local (self-hosted; no per-token vendor price)" },
  "mistral-medium-3-5": { inUsdPerMtok: 0, outUsdPerMtok: 0, asOf: "2026-09", source: "Ollama local (self-hosted; no per-token vendor price)" },
  "mistral-large-3": { inUsdPerMtok: 0, outUsdPerMtok: 0, asOf: "2026-09", source: "Ollama local (self-hosted; no per-token vendor price)" },
  "mistral-7b": { inUsdPerMtok: 0, outUsdPerMtok: 0, asOf: "2026-07", source: "Ollama local (self-hosted; no per-token vendor price)" },
  "mixtral-8x7b": { inUsdPerMtok: 0, outUsdPerMtok: 0, asOf: "2026-07", source: "Ollama local (self-hosted; no per-token vendor price)" },
  "mixtral-8x22b": { inUsdPerMtok: 0, outUsdPerMtok: 0, asOf: "2026-07", source: "Ollama local (self-hosted; no per-token vendor price)" },
});
