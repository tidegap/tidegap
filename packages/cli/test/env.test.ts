/**
 * The `tidegap` CLI is a HOST: environment variables still configure it exactly as
 * they always have.
 *
 * `@tidegap/core` became environment-pure so the OpenClaw plugin bundle could
 * contain zero ambient-environment reads (ClawScan flags any such read in a
 * bundle that also makes network calls). That refactor must be INVISIBLE to
 * `tidegap` users: the same variables, the same precedence, the same adapters.
 * These tests are the regression fence around that promise.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readEnvCredentials, readTelegramEnv } from "../src/env.js";
import { buildAdapters } from "../src/commands/tick.js";

const VARS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "OLLAMA_HOST",
  "TIDEGAP_ELECTRICITY_MAPS_API_KEY",
  "TIDEGAP_EIA_API_KEY",
  "TIDEGAP_ENTSOE_SECURITY_TOKEN",
  "WATTTIME_USERNAME",
  "WATTTIME_PASSWORD",
  "TIDEGAP_CARBON_BUDGET_G",
  "TIDEGAP_CARBON_BUDGET_WINDOW",
  "TIDEGAP_CLAUDE_BIN",
  "TIDEGAP_CLAUDE_CODE",
  "TIDEGAP_CLAUDE_CODE_MAX_BUDGET_USD",
] as const;

describe("tidegap CLI env boundary", () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of VARS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    saved.clear();
  });

  it("reads every documented variable by name", () => {
    process.env.ANTHROPIC_API_KEY = "a";
    process.env.OPENAI_API_KEY = "o";
    process.env.GEMINI_API_KEY = "g";
    process.env.OLLAMA_HOST = "http://ollama.test:11434";
    process.env.TIDEGAP_ELECTRICITY_MAPS_API_KEY = "em";
    process.env.TIDEGAP_EIA_API_KEY = "eia";
    process.env.TIDEGAP_ENTSOE_SECURITY_TOKEN = "entsoe";
    process.env.WATTTIME_USERNAME = "wt-user";
    process.env.WATTTIME_PASSWORD = "wt-pass";
    process.env.TIDEGAP_CARBON_BUDGET_G = "1000";
    process.env.TIDEGAP_CARBON_BUDGET_WINDOW = "weekly";
    process.env.TIDEGAP_CLAUDE_BIN = "/opt/claude";
    process.env.TIDEGAP_CLAUDE_CODE = "off";
    process.env.TIDEGAP_CLAUDE_CODE_MAX_BUDGET_USD = "0.5";

    expect(readEnvCredentials()).toEqual({
      anthropicApiKey: "a",
      openaiApiKey: "o",
      geminiApiKey: "g",
      ollamaHost: "http://ollama.test:11434",
      grid: {
        electricityMapsApiKey: "em",
        eiaApiKey: "eia",
        entsoeSecurityToken: "entsoe",
        wattTimeUsername: "wt-user",
        wattTimePassword: "wt-pass",
      },
      carbonBudget: {
        TIDEGAP_CARBON_BUDGET_G: "1000",
        TIDEGAP_CARBON_BUDGET_WINDOW: "weekly",
      },
      noNotify: false,
      claudeBin: "/opt/claude",
      claudeCodeDisabled: true,
      claudeCodeMaxBudgetUsd: "0.5",
    });
  });

  it("prefers GEMINI_API_KEY over GOOGLE_API_KEY (unchanged precedence)", () => {
    process.env.GOOGLE_API_KEY = "goog";
    expect(readEnvCredentials().geminiApiKey).toBe("goog");
    process.env.GEMINI_API_KEY = "gem";
    expect(readEnvCredentials().geminiApiKey).toBe("gem");
  });

  it("treats an empty / whitespace value as unset", () => {
    process.env.ANTHROPIC_API_KEY = "   ";
    expect(readEnvCredentials().anthropicApiKey).toBeUndefined();
  });

  it("buildAdapters registers exactly the providers whose variables are set", () => {
    expect(buildAdapters()).toEqual({});

    process.env.ANTHROPIC_API_KEY = "a";
    expect(Object.keys(buildAdapters())).toEqual(["anthropic"]);

    process.env.OPENAI_API_KEY = "o";
    process.env.GOOGLE_API_KEY = "goog";
    process.env.OLLAMA_HOST = "http://ollama.test:11434";
    expect(Object.keys(buildAdapters()).sort()).toEqual([
      "anthropic",
      "gemini",
      "ollama",
      "openai",
    ]);
  });

  it("forwards OLLAMA_HOST into the adapter rather than relying on a default", () => {
    process.env.OLLAMA_HOST = "ollama.test:9999";
    const adapters = buildAdapters();
    const ollama = adapters.ollama as unknown as { host: string };
    expect(ollama.host).toBe("http://ollama.test:9999");
  });
});

describe("readTelegramEnv (coherence KTD13)", () => {
  const NAMES = ["TIDEGAP_TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_TOKEN", "TIDEGAP_TELEGRAM_API_BASE"] as const;
  const saved = new Map<string, string | undefined>();
  beforeEach(() => {
    for (const k of NAMES) {
      saved.set(k, process.env[k]);
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("reads the token, TIDEGAP_ name first", () => {
    process.env.TELEGRAM_BOT_TOKEN = "plain";
    expect(readTelegramEnv().token).toBe("plain");
    process.env.TIDEGAP_TELEGRAM_BOT_TOKEN = "tidegap";
    expect(readTelegramEnv().token).toBe("tidegap");
  });

  it("honours the API base only on loopback", () => {
    expect(readTelegramEnv()).toEqual({ token: undefined, apiBase: "https://api.telegram.org", apiBaseRejected: false });
    process.env.TIDEGAP_TELEGRAM_API_BASE = "http://127.0.0.1:9999";
    expect(readTelegramEnv().apiBase).toBe("http://127.0.0.1:9999");
    process.env.TIDEGAP_TELEGRAM_API_BASE = "https://attacker.example";
    expect(readTelegramEnv()).toMatchObject({ apiBase: "https://api.telegram.org", apiBaseRejected: true });
  });
});
