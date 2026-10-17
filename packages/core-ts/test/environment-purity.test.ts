/**
 * `@tidegap/core` is an ENVIRONMENT-PURE library.
 *
 * Motivation: the OpenClaw plugin bundles this library, and ClawHub's ClawScan
 * raises `suspicious.env_credential_access` (severity: critical) on ANY
 * ambient-environment read inside a bundle that also makes network calls —
 * even a non-secret numeric threshold. Reading env "narrowly, by name" was not
 * enough; the reads had to be gone. Beyond the scanner, it is simply the right
 * shape: a library that reaches into ambient state is untestable and surprising.
 *
 * The contract these tests pin down:
 *   1. No source file under src/ contains an ambient-environment read.
 *   2. Every credentialed entry point IGNORES the same-named environment
 *      variable and honours only its explicit argument.
 *
 * The hosts (`tidegap` CLI, `@tidegap/mcp` server, the web dashboard) read those
 * variables at their own entry points and inject them — see
 * `packages/cli/src/env.ts` and `packages/mcp-server/src/env.ts`. The OpenClaw
 * plugin injects OpenClaw plugin-config values instead.
 *
 * DELIBERATE ASYMMETRY: the Python mirror (`packages/core-py`) is NOT
 * environment-pure and is not expected to be. It is never bundled into a
 * third-party plugin — it is used directly as its own host — so its
 * `os.environ` fallbacks stay for ergonomics.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AnthropicAdapter,
  buildDefaultGridFeed,
  eiaFeed,
  electricityMapsFeed,
  entsoeFeed,
  GeminiAdapter,
  loadCarbonBudgetConfig,
  OllamaAdapter,
  OpenAIAdapter,
  wattTimeFeed,
} from "../src/index.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

/**
 * Every environment variable a HOST reads on core's behalf. Setting all of
 * them and then asserting core behaves as if none were set is the strongest
 * available statement of purity.
 */
const HOST_ENV_VARS = [
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
  "TIDEGAP_USAGE",
  "TIDEGAP_USAGE_OAUTH",
  // The 0.17 names, still read by the hosts as a fallback.
  "EBB_ELECTRICITY_MAPS_API_KEY",
  "EBB_EIA_API_KEY",
  "EBB_ENTSOE_SECURITY_TOKEN",
  "EBB_CARBON_BUDGET_G",
  "EBB_CARBON_BUDGET_WINDOW",
] as const;

describe("@tidegap/core is environment-pure", () => {
  it("no source file reads the ambient environment", () => {
    // Built by concatenation so this test file's own source does not match the
    // pattern it is searching for.
    const needle = "process" + "." + "env";
    const offenders = walk(SRC).filter((f) =>
      readFileSync(f, "utf8").includes(needle),
    );
    expect(offenders).toEqual([]);
  });

  describe("with every host variable exported, core still sees nothing", () => {
    const saved = new Map<string, string | undefined>();

    beforeEach(() => {
      for (const key of HOST_ENV_VARS) {
        saved.set(key, process.env[key]);
        // A value that would be obviously wrong if it ever leaked through.
        process.env[key] = key.endsWith("_CARBON_BUDGET_G") ? "1" : `leaked-${key}`;
      }
      process.env.TIDEGAP_CARBON_BUDGET_WINDOW = "weekly";
    });

    afterEach(() => {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      saved.clear();
    });

    it("provider adapters ignore their environment variables", () => {
      expect(new AnthropicAdapter().ready).toBe(false);
      expect(new OpenAIAdapter().ready).toBe(false);
      expect(new GeminiAdapter().ready).toBe(false);
      // Ollama is keyless (always ready); what matters is that OLLAMA_HOST is
      // not picked up — the adapter must target the compiled-in default.
      const ollama = new OllamaAdapter() as unknown as { host: string };
      expect(ollama.host).toBe("http://localhost:11434");
    });

    it("provider adapters honour the injected value", () => {
      expect(new AnthropicAdapter({ apiKey: "injected" }).ready).toBe(true);
      expect(new OpenAIAdapter({ apiKey: "injected" }).ready).toBe(true);
      expect(new GeminiAdapter({ apiKey: "injected" }).ready).toBe(true);
      const ollama = new OllamaAdapter({
        host: "example.test:1234",
      }) as unknown as { host: string };
      expect(ollama.host).toBe("http://example.test:1234");
    });

    it("grid feeds degrade to mock rather than using an environment credential", async () => {
      // Each of these would hit a live API if it had picked up its variable.
      // With no injected credential they must report the synthetic mock feed.
      expect((await electricityMapsFeed().fetchForecast("DE", 3)).source).toBe("mock");
      expect((await eiaFeed().fetchForecast("US-CAL-CISO", 3)).source).toBe("mock");
      expect((await entsoeFeed().fetchForecast("FR", 3)).source).toBe("mock");
      // wattTimeFeed with no credentials collapses to its fallback.
      const fallback = { source: "sentinel", fetchForecast: async () => ({}) };
      expect(wattTimeFeed({ fallback: fallback as never })).toBe(fallback);
    });

    it("buildDefaultGridFeed() with no argument is the zero-credential feed", async () => {
      const feed = buildDefaultGridFeed();
      // GB is free and needs no key, so it stays live; everything else is mock.
      expect((await feed.fetchForecast("US-CAL-CISO", 3)).source).toBe("mock");
      expect((await feed.fetchForecast("FR", 3)).source).toBe("mock");
      expect((await feed.fetchForecast("JP", 3)).source).toBe("mock");
    });

    it("buildDefaultGridFeed routes to the injected credentials' feeds", async () => {
      // A bad key still produces `mock` (the feeds degrade on error), so assert
      // on the request instead: a credential was injected ⇒ the feed tries the
      // real endpoint. Capture the attempt with a fetch stub.
      const realFetch = globalThis.fetch;
      const urls: string[] = [];
      globalThis.fetch = (async (url: string) => {
        urls.push(String(url));
        throw new Error("blocked in test");
      }) as unknown as typeof fetch;
      try {
        const feed = buildDefaultGridFeed({
          eiaApiKey: "injected-eia",
          entsoeSecurityToken: "injected-entsoe",
          electricityMapsApiKey: "injected-em",
        });
        await feed.fetchForecast("US-CAL-CISO", 3);
        await feed.fetchForecast("FR", 3);
        await feed.fetchForecast("JP", 3);
      } finally {
        globalThis.fetch = realFetch;
      }
      expect(urls.some((u) => u.includes("injected-eia"))).toBe(true);
      expect(urls.some((u) => u.includes("injected-entsoe"))).toBe(true);
      expect(urls.some((u) => new URL(u).hostname === "api.electricitymap.org")).toBe(true);
      // …and none of the leaked environment values reached a request.
      expect(urls.some((u) => u.includes("leaked-"))).toBe(false);
    });

    it("loadCarbonBudgetConfig ignores TIDEGAP_CARBON_BUDGET_* and takes opts.env", () => {
      // TIDEGAP_CARBON_BUDGET_G=1 is exported above. With a config path that does
      // not exist and no injected override, the feature must stay OFF.
      expect(
        loadCarbonBudgetConfig({ path: join(SRC, "does-not-exist") }),
      ).toBeUndefined();
      // The host-supplied override is what turns it on.
      expect(
        loadCarbonBudgetConfig({
          path: join(SRC, "does-not-exist"),
          env: { TIDEGAP_CARBON_BUDGET_G: "250", TIDEGAP_CARBON_BUDGET_WINDOW: "monthly" },
        }),
      ).toEqual({ thresholdG: 250, windowKind: "monthly" });
    });
  });
});
