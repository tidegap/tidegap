import { describe, expect, it } from "vitest";
import {
  DEFAULT_PUE,
  ENERGY_SOURCES,
  LEGACY_KWH_PER_TASK,
  MODEL_ENERGY_COEFFICIENTS,
  estimateEnergyKwh,
  gramsForIntensity,
  lookupModelEnergy,
  normalizeModelName,
  resolveModelEnergy,
} from "../src/energy.js";
import { DEFAULT_MODEL_BY_PROVIDER } from "../src/index.js";

describe("normalizeModelName", () => {
  it("lowercases and strips dated suffixes", () => {
    expect(normalizeModelName("Claude-Sonnet-4-5-20251022")).toBe("claude-sonnet-4-5");
    expect(normalizeModelName("gpt-4o-2024-11-20")).toBe("gpt-4o");
  });

  it("converts dots to dashes", () => {
    expect(normalizeModelName("gpt-3.5-turbo")).toBe("gpt-3-5-turbo");
  });

  it("strips -latest / -preview / version-number suffixes", () => {
    expect(normalizeModelName("claude-haiku-3-5-latest")).toBe("claude-haiku-3-5");
    expect(normalizeModelName("gpt-4o-preview")).toBe("gpt-4o");
    expect(normalizeModelName("model-v2")).toBe("model");
    expect(normalizeModelName("model-001")).toBe("model");
  });

  it("leaves canonical names untouched", () => {
    expect(normalizeModelName("claude-opus-4-7")).toBe("claude-opus-4-7");
    expect(normalizeModelName("llama-3-1-8b")).toBe("llama-3-1-8b");
  });

  it("strips provider prefixes (path and Bedrock styles)", () => {
    expect(normalizeModelName("anthropic/claude-opus-4-7")).toBe("claude-opus-4-7");
    expect(normalizeModelName("meta-llama/Llama-3.1-8B")).toBe("llama-3-1-8b");
    expect(normalizeModelName("us.anthropic.claude-opus-4-1-v1:0")).toBe("claude-opus-4-1");
  });

  it("strips Bedrock global and bare vendor prefixes", () => {
    expect(normalizeModelName("global.anthropic.claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(normalizeModelName("anthropic.claude-opus-5")).toBe("claude-opus-5");
    expect(normalizeModelName("meta.llama-4-scout")).toBe("llama-4-scout");
  });

  it("canonicalizes claude word order", () => {
    expect(normalizeModelName("claude-3-5-sonnet")).toBe("claude-sonnet-3-5");
    expect(normalizeModelName("claude-3-5-sonnet-20241022")).toBe("claude-sonnet-3-5");
    expect(normalizeModelName("claude-5-1-fable")).toBe("claude-fable-5-1");
    expect(normalizeModelName("claude-5-1-mythos")).toBe("claude-mythos-5-1");
  });

  it("maps the dotted Gemini / GPT vendor ids to the canonical keys", () => {
    expect(normalizeModelName("gemini-3.8-flash")).toBe("gemini-3-8-flash");
    expect(normalizeModelName("gpt-4.1-mini")).toBe("gpt-4-1-mini");
  });
});

describe("resolveModelEnergy", () => {
  it("keeps retired rows resolvable and flags them", () => {
    const r = resolveModelEnergy("claude-sonnet-3-5");
    expect(r.tier).toBe("exact");
    expect(r.coeffs.status).toBe("retired");
    expect(resolveModelEnergy("claude-3-5-sonnet-20241022").tier).toBe("normalized");
    expect(resolveModelEnergy("gpt-4").coeffs.status).toBe("deprecated");
    expect(resolveModelEnergy("claude-sonnet-5").coeffs.status).toBeUndefined();
  });

  it("routes new families to current representatives", () => {
    const opus5 = MODEL_ENERGY_COEFFICIENTS["claude-opus-5"]!;
    const fable = MODEL_ENERGY_COEFFICIENTS["claude-fable-5-1"]!;
    const gpt41 = MODEL_ENERGY_COEFFICIENTS["gpt-4-1"]!;
    expect(resolveModelEnergy("claude-opus-6")).toEqual({ coeffs: opus5, tier: "family-fallback" });
    expect(resolveModelEnergy("claude-mythos-5-1")).toEqual({ coeffs: fable, tier: "family-fallback" });
    expect(resolveModelEnergy("gemini-4-flash").coeffs).toBe(MODEL_ENERGY_COEFFICIENTS["gemini-3-8-flash"]);
    // gpt-4-1 is ordered before gpt-4, so a 4.1 variant never lands on gpt-4.
    expect(resolveModelEnergy("gpt-4-1-ultra").coeffs).toBe(gpt41);
    expect(resolveModelEnergy("gpt-4-1-ultra").coeffs).not.toBe(MODEL_ENERGY_COEFFICIENTS["gpt-4"]);
    // The removed never-real row still resolves, through its family.
    expect(resolveModelEnergy("claude-opus-3-5")).toEqual({ coeffs: opus5, tier: "family-fallback" });
  });

  it("reports the resolution tier", () => {
    expect(resolveModelEnergy("claude-opus-4-7").tier).toBe("exact");
    expect(resolveModelEnergy("claude-sonnet-4-5-20251022").tier).toBe("normalized");
    expect(resolveModelEnergy("claude-sonnet-9").tier).toBe("family-fallback");
    expect(resolveModelEnergy("totally-unknown").tier).toBe("default");
    expect(resolveModelEnergy(undefined).tier).toBe("default");
  });

  it("family fallback uses the representative's coefficients", () => {
    const rep = MODEL_ENERGY_COEFFICIENTS["claude-sonnet-5"]!;
    const got = resolveModelEnergy("claude-sonnet-9").coeffs;
    expect(got.whPerInputToken).toBe(rep.whPerInputToken);
    expect(got.whPerOutputToken).toBe(rep.whPerOutputToken);
    expect(got.source).toBe("estimated");
  });
});

describe("lookupModelEnergy", () => {
  it("returns measured coefficients for an open-weight model", () => {
    const c = lookupModelEnergy("llama-3-1-70b");
    expect(c.source).toBe("measured");
    expect(c.whPerInputToken).toBeGreaterThan(0);
    expect(c.whPerOutputToken).toBeGreaterThan(c.whPerInputToken);
  });

  it("returns estimated coefficients for a closed frontier model", () => {
    const c = lookupModelEnergy("claude-opus-4-7");
    expect(c.source).toBe("estimated");
  });

  it("falls back for unknown models", () => {
    expect(lookupModelEnergy("totally-unknown-model").source).toBe("fallback");
    expect(lookupModelEnergy("").source).toBe("fallback");
    expect(lookupModelEnergy(undefined).source).toBe("fallback");
  });

  it("hits the same entry for dated and undated names", () => {
    const a = lookupModelEnergy("claude-sonnet-4-5");
    const b = lookupModelEnergy("claude-sonnet-4-5-20251022");
    expect(b).toEqual(a);
  });
});

describe("estimateEnergyKwh — backwards compatibility", () => {
  it("returns exactly LEGACY_KWH_PER_TASK when no args at all", () => {
    expect(estimateEnergyKwh()).toBe(LEGACY_KWH_PER_TASK);
    expect(estimateEnergyKwh({})).toBe(LEGACY_KWH_PER_TASK);
  });

  it("returns LEGACY_KWH_PER_TASK for an unknown model with no token counts", () => {
    expect(estimateEnergyKwh({ model: "ghost-model" })).toBe(LEGACY_KWH_PER_TASK);
  });

  it("family-recognized unknown uses the family estimate, not the legacy flat", () => {
    // claude-sonnet-9 → sonnet representative typical-token estimate (§1.8).
    const got = estimateEnergyKwh({ model: "claude-sonnet-9" });
    expect(got).toBeCloseTo(0.00345, 6);
    expect(got).not.toBe(LEGACY_KWH_PER_TASK);
  });
});

describe("estimateEnergyKwh — per-model math", () => {
  it("uses per-token coefficients × PUE when both model and tokens are known", () => {
    // claude-sonnet-4: 0.0010 input + 0.0050 output Wh/token
    // 1000 in + 2000 out = 1.0 + 10.0 = 11.0 Wh chip
    // × PUE 1.15 = 12.65 Wh grid → 0.01265 kWh
    const got = estimateEnergyKwh({
      model: "claude-sonnet-4",
      inputTokens: 1000,
      outputTokens: 2000,
    });
    expect(got).toBeCloseTo(0.01265, 6);
  });

  it("uses typical-token defaults when only model is given", () => {
    // Typical 500 in + 500 out for claude-sonnet-4:
    // 500*0.001 + 500*0.005 = 0.5 + 2.5 = 3.0 Wh chip × 1.15 = 3.45 Wh = 0.00345 kWh
    expect(estimateEnergyKwh({ model: "claude-sonnet-4" })).toBeCloseTo(0.00345, 6);
  });

  it("frontier models cost more energy than compact ones at the same token shape", () => {
    const opus = estimateEnergyKwh({ model: "claude-opus-4-7", inputTokens: 500, outputTokens: 500 });
    const haiku = estimateEnergyKwh({ model: "claude-haiku-4-5", inputTokens: 500, outputTokens: 500 });
    expect(opus).toBeGreaterThan(haiku * 5);
  });

  it("respects a PUE override", () => {
    const default_ = estimateEnergyKwh({ model: "llama-3-1-8b", inputTokens: 100, outputTokens: 100 });
    const noPue = estimateEnergyKwh({ model: "llama-3-1-8b", inputTokens: 100, outputTokens: 100, pue: 1.0 });
    expect(default_ / noPue).toBeCloseTo(DEFAULT_PUE, 6);
  });

  it("scales linearly with token counts", () => {
    const a = estimateEnergyKwh({ model: "gpt-4o", inputTokens: 100, outputTokens: 200 });
    const b = estimateEnergyKwh({ model: "gpt-4o", inputTokens: 1000, outputTokens: 2000 });
    expect(b / a).toBeCloseTo(10, 6);
  });
});

describe("gramsForIntensity", () => {
  it("multiplies by grid intensity", () => {
    const wattHourPerKwh = estimateEnergyKwh({}) * 250;
    expect(gramsForIntensity(250)).toBeCloseTo(wattHourPerKwh, 6);
  });

  it("gives larger grams for the same intensity on a frontier model than a compact model", () => {
    const opus = gramsForIntensity(400, { model: "claude-opus-4-7" });
    const haiku = gramsForIntensity(400, { model: "claude-haiku-4-5" });
    expect(opus).toBeGreaterThan(haiku);
  });
});

describe("MODEL_ENERGY_COEFFICIENTS table sanity", () => {
  it("output Wh/token is always >= input Wh/token (decode is more expensive than prefill)", () => {
    for (const [name, c] of Object.entries(MODEL_ENERGY_COEFFICIENTS)) {
      expect(c.whPerOutputToken, name).toBeGreaterThanOrEqual(c.whPerInputToken);
    }
  });

  it("all coefficients are positive and finite", () => {
    for (const [name, c] of Object.entries(MODEL_ENERGY_COEFFICIENTS)) {
      expect(Number.isFinite(c.whPerInputToken), name).toBe(true);
      expect(Number.isFinite(c.whPerOutputToken), name).toBe(true);
      expect(c.whPerInputToken, name).toBeGreaterThan(0);
      expect(c.whPerOutputToken, name).toBeGreaterThan(0);
    }
  });

  it("each entry carries a recognized confidence tier", () => {
    const allowed = new Set(["measured", "estimated"]);
    for (const [name, c] of Object.entries(MODEL_ENERGY_COEFFICIENTS)) {
      expect(allowed.has(c.source), name).toBe(true);
    }
  });

  it("scales monotonically across the llama-3.1 family", () => {
    const a = MODEL_ENERGY_COEFFICIENTS["llama-3-1-8b"]!;
    const b = MODEL_ENERGY_COEFFICIENTS["llama-3-1-70b"]!;
    const c = MODEL_ENERGY_COEFFICIENTS["llama-3-1-405b"]!;
    expect(b.whPerOutputToken).toBeGreaterThan(a.whPerOutputToken);
    expect(c.whPerOutputToken).toBeGreaterThan(b.whPerOutputToken);
  });
});

describe("ENERGY_SOURCES citations", () => {
  it("includes all three primary sources", () => {
    expect(ENERGY_SOURCES.patterson2021.arxiv).toBe("2104.10350");
    expect(ENERGY_SOURCES.luccioni2024.arxiv).toBe("2311.16863");
    expect(ENERGY_SOURCES.huggingface.url).toContain("huggingface.co/AIEnergyScore");
  });
});

describe("DEFAULT_MODEL_BY_PROVIDER", () => {
  it("names one current model per provider, each resolvable by the energy table", () => {
    expect(DEFAULT_MODEL_BY_PROVIDER).toEqual({
      anthropic: "claude-sonnet-5",
      openai: "gpt-6-sol",
      gemini: "gemini-3.8-flash",
      ollama: "llama3.1",
      "claude-code": "default",
      command: "none",
    });
    // "default" means "Claude Code picks"; it resolves to the fallback
    // coefficients at schedule time, and the receipt uses the real model.
    // "none": a command job's shell step has no model.
    const { "claude-code": _claudeCode, command: _command, ...vendorDefaults } = DEFAULT_MODEL_BY_PROVIDER;
    for (const model of Object.values(vendorDefaults)) {
      expect(resolveModelEnergy(model).coeffs.status, model).toBeUndefined();
    }
    expect(resolveModelEnergy(DEFAULT_MODEL_BY_PROVIDER.gemini).tier).toBe("normalized");
  });
});
