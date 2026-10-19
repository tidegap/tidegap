#!/usr/bin/env node
/**
 * Single source of truth → generated data modules.
 *
 * Reads the hand-edited JSON tables under
 * `packages/core-ts/src/data/*.json` (the SSOT: per-model energy
 * coefficients + family fallbacks, synthetic grid-curve params, band
 * thresholds) and regenerates:
 *
 *   - packages/core-ts/src/data/tables.generated.ts  (TypeScript)
 *   - packages/core-py/src/tidegap/_data.py           (Python)
 *
 * Both outputs are marked GENERATED — DO NOT EDIT. Edit the JSON and run
 * `pnpm gen:data`. CI (`pnpm gen:data:check`) fails if the committed
 * generated files drift from what this script produces.
 *
 * The script is dependency-free (Node built-ins only) and deterministic:
 * key order follows the JSON files, and numbers are emitted as their
 * canonical `String(n)` form so the TS and PY literals are byte-identical.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { validateTables } from "./gen-data-validate.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const dataDir = join(repo, "packages", "core-ts", "src", "data");
const tsOut = join(dataDir, "tables.generated.ts");
const pyOut = join(repo, "packages", "core-py", "src", "tidegap", "_data.py");

const readJson = (name) =>
  JSON.parse(readFileSync(join(dataDir, name), "utf8"));

const energy = readJson("energy.json");
const regions = readJson("regions.json");
const bands = readJson("bands.json");
const prices = readJson("prices.json");

// ---- validation -----------------------------------------------------------
// Zones the website lists (apps/web/src/lib/regions.ts): the catalog must
// name exactly these, so the site and the CLI offer the same regions.
const webRegionsSource = readFileSync(
  join(repo, "apps", "web", "src", "lib", "regions.ts"),
  "utf8",
);
const webZones = [...webRegionsSource.matchAll(/^\s*zone:\s*"([^"]+)"/gm)].map((m) => m[1]);

validateTables({ energy, prices, regions, webZones });

// ---- shared numeric emission ----------------------------------------------
// `String(n)` gives the same decimal text for both languages for every
// magnitude used here (>= 1e-4, no scientific notation).
const num = (n) => String(n);

// ============================================================================
// TypeScript
// ============================================================================
function tsCoefficient(c) {
  const parts = [
    `whPerInputToken: ${num(c.whPerInputToken)}`,
    `whPerOutputToken: ${num(c.whPerOutputToken)}`,
  ];
  if (c.paramsB !== undefined) parts.push(`paramsB: ${num(c.paramsB)}`);
  parts.push(`source: ${JSON.stringify(c.source)}`);
  if (c.status !== undefined) parts.push(`status: ${JSON.stringify(c.status)}`);
  return `{ ${parts.join(", ")} }`;
}

function tsFamily(f) {
  const parts = [`id: ${JSON.stringify(f.id)}`, `representative: ${JSON.stringify(f.representative)}`];
  if (f.contains) parts.push(`contains: ${JSON.stringify(f.contains)}`);
  if (f.prefix !== undefined) parts.push(`prefix: ${JSON.stringify(f.prefix)}`);
  if (f.regex !== undefined) parts.push(`regex: ${JSON.stringify(f.regex)}`);
  return `  { ${parts.join(", ")} },`;
}

function tsPrice(p) {
  const parts = [
    `inUsdPerMtok: ${num(p.inUsdPerMtok)}`,
    `outUsdPerMtok: ${num(p.outUsdPerMtok)}`,
  ];
  if (p.batchDiscount !== undefined) parts.push(`batchDiscount: ${num(p.batchDiscount)}`);
  parts.push(`asOf: ${JSON.stringify(p.asOf)}`);
  parts.push(`source: ${JSON.stringify(p.source)}`);
  return `{ ${parts.join(", ")} }`;
}

function tsRecord(obj, indent = "  ") {
  return Object.entries(obj)
    .map(([k, v]) => `${indent}${JSON.stringify(k)}: ${num(v)},`)
    .join("\n");
}

function tsCatalogEntry(c) {
  return `{ name: ${JSON.stringify(c.name)}, country: ${JSON.stringify(c.country)}, countryName: ${JSON.stringify(c.countryName)}, operator: ${JSON.stringify(c.operator)} }`;
}

function renderTs() {
  const coeffLines = Object.entries(energy.coefficients)
    .map(([id, c]) => `  ${JSON.stringify(id)}: ${tsCoefficient(c)},`)
    .join("\n");
  const familyLines = energy.families.map(tsFamily).join("\n");
  const bandLines = bands.thresholds
    .map((t) => `  { maxExclusive: ${num(t.maxExclusive)}, band: ${JSON.stringify(t.band)} },`)
    .join("\n");
  const priceLines = Object.entries(prices.prices)
    .map(([id, p]) => `  ${JSON.stringify(id)}: ${tsPrice(p)},`)
    .join("\n");
  const catalogLines = Object.entries(regions.regionCatalog)
    .map(([zone, c]) => `  ${JSON.stringify(zone)}: ${tsCatalogEntry(c)},`)
    .join("\n");

  return `/**
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
export const DEFAULT_PUE = ${num(energy.defaultPue)};

/** Backwards-compatible flat estimate. Used when no model is provided. */
export const LEGACY_KWH_PER_TASK = ${num(energy.legacyKwhPerTask)};

/** Typical token shape used when a caller names a model but no token counts. */
export const TYPICAL_INPUT_TOKENS = ${num(energy.typicalInputTokens)};
export const TYPICAL_OUTPUT_TOKENS = ${num(energy.typicalOutputTokens)};

/** Per-model coefficient table. Keys are canonical lowercase names. */
export const MODEL_ENERGY_COEFFICIENTS: Readonly<
  Record<string, ModelEnergyCoefficients>
> = Object.freeze({
${coeffLines}
});

/**
 * Ordered family-fallback rules. The first rule whose conditions all hold
 * (see familyRepresentative in energy.ts) supplies coefficients for an
 * otherwise-unknown model id in that family.
 */
export const MODEL_FAMILIES: readonly ModelFamily[] = Object.freeze([
${familyLines}
]);

/** Citation metadata for the coefficient table. */
export const ENERGY_SOURCES = Object.freeze(${JSON.stringify(energy.sources, null, 2)
    .split("\n")
    .join("\n")});

/** Synthetic-curve region midpoints (gCO2/kWh). */
export const REGION_FLOORS: Readonly<Record<string, number>> = Object.freeze({
${tsRecord(regions.regionFloors)}
});

/** Fallback midpoint for regions with no explicit floor. */
export const DEFAULT_REGION_FLOOR = ${num(regions.defaultFloor)};

/** Peak-to-trough half-swing of the synthetic curve (gCO2/kWh). */
export const SYNTHETIC_AMPLITUDE = ${num(regions.amplitude)};

/** Per-region UTC-hour offset applied to the synthetic curve's local trough. */
export const REGION_UTC_OFFSETS: Readonly<Record<string, number>> = Object.freeze({
${tsRecord(regions.regionUtcOffsets)}
});

/**
 * Supported grid zones for people: name, ISO country code, country name and
 * grid operator. Keys equal REGION_FLOORS and the website's zone list.
 */
export const REGION_CATALOG: Readonly<Record<string, RegionCatalogEntry>> = Object.freeze({
${catalogLines}
});

/** Band thresholds (ascending). A value maps to the first band it is below. */
export const BAND_THRESHOLDS: readonly {
  maxExclusive: number;
  band: GridForecastEntry["band"];
}[] = Object.freeze([
${bandLines}
]);

/** Band for values at or above every threshold. */
export const DEFAULT_BAND: GridForecastEntry["band"] = ${JSON.stringify(bands.defaultBand)};

/** Month the price table figures were read (see prices.json). */
export const PRICES_AS_OF = ${JSON.stringify(prices.asOf)};

/**
 * Per-model public list prices (USD per million tokens), keyed by the same
 * canonical lowercase ids as MODEL_ENERGY_COEFFICIENTS. Ollama-routable
 * open-weight models are 0 (self-hosted). Used by cross-provider routing's
 * cost dimension. LIST prices, not the caller's negotiated rate.
 */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = Object.freeze({
${priceLines}
});
`;
}

// ============================================================================
// Python
// ============================================================================
function pyValue(v) {
  if (v === null) return "None";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") return num(v);
  if (Array.isArray(v)) return `[${v.map(pyValue).join(", ")}]`;
  if (typeof v === "object") {
    const inner = Object.entries(v)
      .map(([k, val]) => `${JSON.stringify(k)}: ${pyValue(val)}`)
      .join(", ");
    return `{${inner}}`;
  }
  return JSON.stringify(v);
}

function pyCoefficient(c) {
  const parts = [
    `"wh_per_input_token": ${num(c.whPerInputToken)}`,
    `"wh_per_output_token": ${num(c.whPerOutputToken)}`,
    `"params_b": ${c.paramsB === undefined ? "None" : num(c.paramsB)}`,
    `"source": ${JSON.stringify(c.source)}`,
    `"status": ${c.status === undefined ? "None" : JSON.stringify(c.status)}`,
  ];
  return `{${parts.join(", ")}}`;
}

function pyFamily(f) {
  const parts = [`"id": ${JSON.stringify(f.id)}`, `"representative": ${JSON.stringify(f.representative)}`];
  parts.push(`"contains": ${f.contains ? pyValue(f.contains) : "None"}`);
  parts.push(`"prefix": ${f.prefix === undefined ? "None" : JSON.stringify(f.prefix)}`);
  parts.push(`"regex": ${f.regex === undefined ? "None" : JSON.stringify(f.regex)}`);
  return `    {${parts.join(", ")}},`;
}

function pyPrice(p) {
  const parts = [
    `"in_usd_per_mtok": ${num(p.inUsdPerMtok)}`,
    `"out_usd_per_mtok": ${num(p.outUsdPerMtok)}`,
    `"batch_discount": ${p.batchDiscount === undefined ? "None" : num(p.batchDiscount)}`,
    `"as_of": ${JSON.stringify(p.asOf)}`,
    `"source": ${JSON.stringify(p.source)}`,
  ];
  return `{${parts.join(", ")}}`;
}

function pyDict(obj, indent = "    ") {
  return Object.entries(obj)
    .map(([k, v]) => `${indent}${JSON.stringify(k)}: ${num(v)},`)
    .join("\n");
}

function renderPy() {
  const coeffLines = Object.entries(energy.coefficients)
    .map(([id, c]) => `    ${JSON.stringify(id)}: ${pyCoefficient(c)},`)
    .join("\n");
  const familyLines = energy.families.map(pyFamily).join("\n");
  const sourceLines = Object.entries(energy.sources)
    .map(([k, v]) => `    ${JSON.stringify(k)}: ${pyValue(v)},`)
    .join("\n");
  const bandLines = bands.thresholds
    .map((t) => `    (${num(t.maxExclusive)}, ${JSON.stringify(t.band)}),`)
    .join("\n");
  const priceLines = Object.entries(prices.prices)
    .map(([id, p]) => `    ${JSON.stringify(id)}: ${pyPrice(p)},`)
    .join("\n");
  const catalogLines = Object.entries(regions.regionCatalog)
    .map(
      ([zone, c]) =>
        `    ${JSON.stringify(zone)}: {"name": ${JSON.stringify(c.name)}, "country": ${JSON.stringify(c.country)}, "country_name": ${JSON.stringify(c.countryName)}, "operator": ${JSON.stringify(c.operator)}},`,
    )
    .join("\n");

  return `# GENERATED — DO NOT EDIT.
#
# Produced by scripts/gen-data.mjs from packages/core-ts/src/data/*.json.
# Edit those JSON files and run 'pnpm gen:data' to regenerate. CI fails
# on drift ('pnpm gen:data:check').
# ruff: noqa
"""Generated data tables mirrored from the JSON SSOT in @tidegap/core."""

from __future__ import annotations

from typing import Any

#: Industry-average Power Usage Effectiveness for hyperscaler data centres.
DEFAULT_PUE: float = ${num(energy.defaultPue)}

#: Backwards-compatible flat estimate. Used when no model is provided.
LEGACY_KWH_PER_TASK: float = ${num(energy.legacyKwhPerTask)}

#: Typical token shape used when a caller names a model but no token counts.
TYPICAL_INPUT_TOKENS: int = ${num(energy.typicalInputTokens)}
TYPICAL_OUTPUT_TOKENS: int = ${num(energy.typicalOutputTokens)}

#: Per-model coefficient table. Keys are canonical lowercase names.
COEFFICIENTS: dict[str, dict[str, Any]] = {
${coeffLines}
}

#: Ordered family-fallback rules (see _family_representative).
FAMILIES: list[dict[str, Any]] = [
${familyLines}
]

#: Citation metadata for the coefficient table.
ENERGY_SOURCES: dict[str, dict[str, str]] = {
${sourceLines}
}

#: Synthetic-curve region midpoints (gCO2/kWh).
REGION_FLOORS: dict[str, int] = {
${pyDict(regions.regionFloors)}
}

#: Fallback midpoint for regions with no explicit floor.
DEFAULT_REGION_FLOOR: int = ${num(regions.defaultFloor)}

#: Peak-to-trough half-swing of the synthetic curve (gCO2/kWh).
SYNTHETIC_AMPLITUDE: int = ${num(regions.amplitude)}

#: Per-region UTC-hour offset applied to the synthetic curve's local trough.
REGION_UTC_OFFSETS: dict[str, int] = {
${pyDict(regions.regionUtcOffsets)}
}

#: Supported grid zones for people: name, ISO country code, country name and
#: grid operator. Keys equal REGION_FLOORS and the website's zone list.
REGION_CATALOG: dict[str, dict[str, str]] = {
${catalogLines}
}

#: Band thresholds (ascending). A value maps to the first band it is below.
BAND_THRESHOLDS: list[tuple[int, str]] = [
${bandLines}
]

#: Band for values at or above every threshold.
DEFAULT_BAND: str = ${JSON.stringify(bands.defaultBand)}

#: Month the price table figures were read (see prices.json).
PRICES_AS_OF: str = ${JSON.stringify(prices.asOf)}

#: Per-model public list prices (USD per million tokens), keyed by the same
#: canonical lowercase ids as COEFFICIENTS. Ollama-routable open-weight models
#: are 0 (self-hosted). Used by cross-provider routing's cost dimension.
MODEL_PRICES: dict[str, dict[str, Any]] = {
${priceLines}
}
`;
}

writeFileSync(tsOut, renderTs());
writeFileSync(pyOut, renderPy());
// eslint-disable-next-line no-console
console.log(`gen-data: wrote\n  ${tsOut}\n  ${pyOut}`);
