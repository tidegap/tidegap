/**
 * In-process dispatcher adapters for the OpenClaw plugin.
 *
 * Provider-call tasks only *execute* when `Scheduler.tick` runs, and tick
 * needs an adapter per provider. Adapters come from two sources, in
 * priority order:
 *
 *  1. The OpenClaw runtime bridge — `api.runtime.llm.complete`, captured
 *     from a tool-call context. It runs the prompt through the gateway's
 *     own configured model + credentials, so NO separate API key is
 *     needed. This is the preferred path inside an OpenClaw gateway.
 *  2. Direct HTTP adapters built from the `anthropicApiKey` / `openaiApiKey`
 *     (and `geminiApiKey` / `ollamaHost`) PLUGIN CONFIG fields. A fallback
 *     for environments where the runtime bridge is unavailable (e.g. a
 *     gateway that denies plugin LLM use).
 *
 * A task whose provider has no adapter is failed by `Scheduler.tick` with
 * a clear error instead of being left stuck in `scheduled`.
 *
 * This module reads NO environment variables — see `config.ts` for why and
 * for the env-var → config-field migration table.
 */

import {
  GeminiAdapter,
  OllamaAdapter,
  withLlmTimeout,
  type DispatchOptions,
  type DispatchResult,
  type ProviderAdapter,
} from "@tidegap/core";

import type { PluginConfig } from "./config.js";

/**
 * The dispatcher only runs prompts synchronously, so an adapter needs
 * just `dispatch` — not the Batch-API `dispatchBatch`. Omitting it keeps
 * `Scheduler.tick` on the synchronous path.
 */
export type DispatchAdapter = Pick<ProviderAdapter, "provider" | "ready" | "dispatch">;

export type DispatchAdapters = {
  anthropic?: DispatchAdapter;
  openai?: DispatchAdapter;
  gemini?: DispatchAdapter;
  ollama?: DispatchAdapter;
};

/** How scheduled tasks will be executed in the current environment. */
export type DispatchCapability = "openclaw-runtime" | "api-key" | "unconfigured";

// ── OpenClaw runtime LLM bridge ─────────────────────────────────────────────
// Structural shape of OpenClaw's `api.runtime.llm.complete`. The real SDK
// types are injected by the gateway at load time, not available at build
// time, so we describe just the slice we use.
type BridgeLlmComplete = (params: {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
  purpose?: string;
}) => Promise<{
  text: string;
  provider?: string;
  model?: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}>;

let bridgeComplete: BridgeLlmComplete | undefined;
let capturedOpenClawConfig: unknown;

/**
 * Capture what the plugin needs from a tool-call context: the OpenClaw
 * runtime's LLM-complete caller (`api.runtime.llm.complete`) for dispatch,
 * and the gateway config (`api.config`) for result delivery. Idempotent
 * and fully defensive — does nothing for surfaces that are absent.
 */
export function captureOpenClawRuntime(context: unknown): void {
  const api = (
    context as
      | {
          api?: {
            runtime?: { llm?: { complete?: unknown } };
            config?: unknown;
          };
        }
      | undefined
  )?.api;
  if (!api) return;
  if (!bridgeComplete) {
    const llm = api.runtime?.llm;
    if (llm && typeof llm.complete === "function") {
      bridgeComplete = (llm.complete as BridgeLlmComplete).bind(llm);
    }
  }
  if (capturedOpenClawConfig === undefined && api.config !== undefined) {
    capturedOpenClawConfig = api.config;
  }
}

/** The gateway config captured from a tool-call context (for delivery). */
export function getCapturedOpenClawConfig(): unknown {
  return capturedOpenClawConfig;
}

/** Test seam: inject or clear the runtime bridge directly. */
export function setLlmBridgeForTest(fn: BridgeLlmComplete | undefined): void {
  bridgeComplete = fn;
}

/** True once the OpenClaw runtime LLM bridge has been captured. */
export function hasRuntimeBridge(): boolean {
  return bridgeComplete !== undefined;
}

/** Adapter that routes a provider_call through OpenClaw's own model runtime. */
function bridgeAdapter(provider: "anthropic" | "openai"): DispatchAdapter {
  return {
    provider,
    ready: true,
    async dispatch(
      model: string,
      prompt: string,
      options?: DispatchOptions,
    ): Promise<DispatchResult> {
      if (!bridgeComplete) {
        throw new Error("Tidegap: the OpenClaw runtime LLM bridge is not available");
      }
      // Deliberately DO NOT pass `model`. OpenClaw treats any `model` on a
      // plugin LLM completion as a model-override and rejects it unless the
      // gateway grants the plugin override policy ("Plugin LLM completion
      // cannot override the target model"). A deferred task runs fine on the
      // gateway agent's configured model — the carbon win is in the timing,
      // not the model. The requested model is honoured only on the
      // direct-API-key path (the HTTP adapters below).
      // The runtime takes no abort signal: at the LLM time limit, or on a
      // cancel, the dispatch rejects and a late answer is dropped.
      const complete = bridgeComplete;
      const result = await withLlmTimeout(
        provider,
        options?.timeoutMs,
        () =>
          complete({
            messages: [{ role: "user", content: prompt }],
            ...(options?.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
            ...(options?.temperature !== undefined
              ? { temperature: options.temperature }
              : {}),
            ...(options?.system ? { systemPrompt: options.system } : {}),
            purpose: "Tidegap deferred task dispatch",
          }),
        options?.signal,
      );
      return {
        text: result.text,
        model: result.model ?? model,
        provider: result.provider ?? provider,
        usage: {
          inputTokens: result.usage?.inputTokens,
          outputTokens: result.usage?.outputTokens,
          totalTokens: result.usage?.totalTokens,
        },
        raw: result,
      };
    },
  };
}

// ── Direct HTTP adapters (fallback) ─────────────────────────────────────────

async function readError(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "(no response body)";
  }
}

/** Anthropic Messages API adapter — https://api.anthropic.com/v1/messages */
function anthropicAdapter(apiKey: string): DispatchAdapter {
  return {
    provider: "anthropic",
    ready: true,
    async dispatch(
      model: string,
      prompt: string,
      options?: DispatchOptions,
    ): Promise<DispatchResult> {
      // The LLM time limit covers the request and the body read.
      const data = (await withLlmTimeout("anthropic", options?.timeoutMs, async (request) => {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          ...(request ? { signal: request.signal } : {}),
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model,
            max_tokens: options?.maxTokens ?? 4096,
            ...(options?.temperature !== undefined
              ? { temperature: options.temperature }
              : {}),
            ...(options?.system ? { system: options.system } : {}),
            messages: [{ role: "user", content: prompt }],
          }),
        });
        if (!res.ok) {
          throw new Error(`anthropic API ${res.status}: ${await readError(res)}`);
        }
        return res.json();
      }, options?.signal)) as {
        content?: Array<{ type: string; text?: string }>;
        usage?: { input_tokens?: number; output_tokens?: number };
        model?: string;
      };
      const text = (data.content ?? [])
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string)
        .join("");
      const inputTokens = data.usage?.input_tokens;
      const outputTokens = data.usage?.output_tokens;
      return {
        text,
        model: data.model ?? model,
        provider: "anthropic",
        usage: {
          inputTokens,
          outputTokens,
          totalTokens:
            inputTokens !== undefined && outputTokens !== undefined
              ? inputTokens + outputTokens
              : undefined,
        },
        raw: data,
      };
    },
  };
}

/** OpenAI Chat Completions adapter — https://api.openai.com/v1/chat/completions */
function openaiAdapter(apiKey: string): DispatchAdapter {
  return {
    provider: "openai",
    ready: true,
    async dispatch(
      model: string,
      prompt: string,
      options?: DispatchOptions,
    ): Promise<DispatchResult> {
      const data = (await withLlmTimeout("openai", options?.timeoutMs, async (request) => {
        const res = await fetch("https://api.openai.com/v1/chat/completions", {
          ...(request ? { signal: request.signal } : {}),
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model,
            messages: [
              ...(options?.system
                ? [{ role: "system", content: options.system }]
                : []),
              { role: "user", content: prompt },
            ],
            ...(options?.temperature !== undefined
              ? { temperature: options.temperature }
              : {}),
            ...(options?.maxTokens !== undefined
              ? { max_tokens: options.maxTokens }
              : {}),
          }),
        });
        if (!res.ok) {
          throw new Error(`openai API ${res.status}: ${await readError(res)}`);
        }
        return res.json();
      }, options?.signal)) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
        };
        model?: string;
      };
      return {
        text: data.choices?.[0]?.message?.content ?? "",
        model: data.model ?? model,
        provider: "openai",
        usage: {
          inputTokens: data.usage?.prompt_tokens,
          outputTokens: data.usage?.completion_tokens,
          totalTokens: data.usage?.total_tokens,
        },
        raw: data,
      };
    },
  };
}

/**
 * Build the dispatch adapters from PLUGIN CONFIG. Prefers the OpenClaw
 * runtime bridge (no API key needed); otherwise builds direct HTTP adapters
 * from whatever provider credentials the gateway config supplies.
 *
 * Nothing in this file reads the ambient environment. The provider keys used
 * to come from `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` /
 * `GOOGLE_API_KEY` / `OLLAMA_HOST` / `OLLAMA_MODELS`; they now come from the
 * identically-purposed `anthropicApiKey` / `openaiApiKey` / `geminiApiKey` /
 * `googleApiKey` / `ollamaHost` / `ollamaModels` config fields, which accept
 * OpenClaw's `${ENV_VAR}` secret shorthand so the gateway can still source
 * them from the environment on the plugin's behalf. See `config.ts`.
 */
export function buildAdapters(config: PluginConfig = {}): DispatchAdapters {
  const adapters: DispatchAdapters = {};
  if (bridgeComplete) {
    // The bridge routes through the gateway's own model — register it for
    // both hosted providers so tick finds an adapter whatever the task asked
    // for. (Gemini / Ollama are NOT gateway models, so they never ride the
    // bridge; they are added below from their own configuration.)
    adapters.anthropic = bridgeAdapter("anthropic");
    adapters.openai = bridgeAdapter("openai");
  } else {
    const anthropicKey = config.anthropicApiKey?.trim();
    if (anthropicKey) adapters.anthropic = anthropicAdapter(anthropicKey);
    const openaiKey = config.openaiApiKey?.trim();
    if (openaiKey) adapters.openai = openaiAdapter(openaiKey);
  }
  // Gemini and Ollama are distinct providers the gateway bridge cannot
  // represent, so build direct adapters whenever they are configured —
  // regardless of the bridge. Gemini uses geminiApiKey (else googleApiKey);
  // Ollama is local + keyless, gated on an explicit ollamaHost opt-in.
  const geminiKey = config.geminiApiKey?.trim() || config.googleApiKey?.trim();
  if (geminiKey) adapters.gemini = new GeminiAdapter({ apiKey: geminiKey });
  const ollamaHost = config.ollamaHost?.trim();
  if (ollamaHost) adapters.ollama = new OllamaAdapter({ host: ollamaHost });
  return adapters;
}

/** Summarise how scheduled tasks will be dispatched right now. */
export function dispatchCapability(
  config: PluginConfig = {},
): DispatchCapability {
  if (bridgeComplete) return "openclaw-runtime";
  if (
    config.anthropicApiKey?.trim() ||
    config.openaiApiKey?.trim() ||
    config.geminiApiKey?.trim() ||
    config.googleApiKey?.trim() ||
    config.ollamaHost?.trim()
  ) {
    return "api-key";
  }
  return "unconfigured";
}

export type Provider = "anthropic" | "openai" | "gemini" | "ollama";

/**
 * Parse the configured Ollama model allow-list from the `ollamaModels` config
 * field (comma-separated model ids; formerly the `OLLAMA_MODELS` environment
 * variable). A model in this list infers to the `ollama` provider. Empty /
 * unset → no models map to Ollama by inference (an explicit
 * `provider: "ollama"` still works).
 */
function ollamaModelSet(config: PluginConfig = {}): ReadonlySet<string> {
  return new Set(
    (config.ollamaModels ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  );
}

/**
 * Infer the provider from a model identifier:
 *   - `gpt-*` / `o<digit>*` (o1, o3-mini, …) → openai
 *   - `gemini-*` → gemini
 *   - a model listed in `ollamaModels` → ollama
 *   - `claude-*` → anthropic
 * Anything unrecognised defaults to `anthropic` (the historical default and
 * the safest fallback for a gateway that has an Anthropic key). Case- and
 * whitespace-insensitive. An explicit `provider` param always wins over this.
 */
export function inferProvider(
  model: string | undefined,
  config: PluginConfig = {},
): Provider {
  const m = (model ?? "").trim().toLowerCase();
  if (m.startsWith("gpt-") || m.startsWith("gpt") || /^o\d/.test(m)) return "openai";
  if (m.startsWith("gemini")) return "gemini";
  if (m.length > 0 && ollamaModelSet(config).has(m)) return "ollama";
  if (m.startsWith("claude")) return "anthropic";
  return "anthropic";
}

/**
 * Which providers can actually be dispatched with the current configuration.
 * With the runtime bridge captured, both hosted providers are dispatchable
 * (the bridge routes through the gateway's own model). Gemini / Ollama are
 * dispatchable whenever their own configuration is present, bridge or not.
 */
export function availableProviders(
  config: PluginConfig = {},
): Set<Provider> {
  const set = new Set<Provider>();
  if (bridgeComplete) {
    set.add("anthropic");
    set.add("openai");
  } else {
    if (config.anthropicApiKey?.trim()) set.add("anthropic");
    if (config.openaiApiKey?.trim()) set.add("openai");
  }
  if (config.geminiApiKey?.trim() || config.googleApiKey?.trim()) set.add("gemini");
  if (config.ollamaHost?.trim()) set.add("ollama");
  return set;
}
