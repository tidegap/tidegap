/**
 * Gemini provider adapter.
 *
 * Talks to Google's Generative Language API
 * (https://generativelanguage.googleapis.com) directly over `fetch` — no
 * vendor SDK dependency. The API key is read from `GEMINI_API_KEY`, falling
 * back to `GOOGLE_API_KEY` (the same precedence Google's own `@google/genai`
 * SDK uses).
 *
 * Endpoint used:
 *   - POST /v1beta/models/{model}:generateContent — sync dispatch, returns
 *     text plus real `usageMetadata` token counts.
 *
 * Batch: DELIBERATELY UNSUPPORTED. The uniform batch surface in this package
 * is submit → batchId → poll(retrieveBatch) → per-request results, modelled
 * on Anthropic Message Batches and OpenAI Batch Files (a flat 50% discount,
 * a discrete batch id, a distinct results endpoint, 24h SLA). Gemini's batch
 * options do not map cleanly:
 *   - Vertex AI batch prediction requires a GCS or BigQuery source/sink — a
 *     different I/O contract entirely (no inline prompt → text round-trip).
 *   - The Developer-API batch mode returns a long-running *operation* keyed
 *     by an operation name, not a batch id with a separate results endpoint,
 *     and its retrieval + usage semantics differ from the shared contract.
 * Rather than fake a mapping, this adapter omits `dispatchBatch` /
 * `retrieveBatch`. The scheduler feature-detects that and keeps Gemini tasks
 * on the sync path (batch-incapable adapters are a first-class case).
 */

import { conversation } from "./base.js";
import { budgetMaxTokens } from "./budget.js";
import { withLlmTimeout } from "./timeout.js";
import type {
  DispatchOptions,
  DispatchResult,
  ProviderAdapter,
} from "./base.js";

/** Minimal shape of the `fetch` we depend on (injectable for tests). */
type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

export interface GeminiAdapterOptions {
  /**
   * API key. Supplied by the host — this library never reads the environment.
   * The `tidegap` CLI and `@tidegap/mcp` server read `GEMINI_API_KEY` (else
   * `GOOGLE_API_KEY`) and pass the winner here; the OpenClaw plugin passes
   * `geminiApiKey` (else `googleApiKey`) from plugin config.
   */
  apiKey?: string;
  /** Override the API base URL (defaults to the public endpoint). */
  baseUrl?: string;
  /** Inject a `fetch` implementation. Defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
}

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

export class GeminiAdapter implements ProviderAdapter {
  readonly provider = "gemini";
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike | undefined;

  constructor(opts: GeminiAdapterOptions = {}) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl;
  }

  get ready(): boolean {
    return Boolean(this.apiKey);
  }

  async dispatch(
    model: string,
    prompt: string,
    options: DispatchOptions = {},
  ): Promise<DispatchResult> {
    if (!this.apiKey) {
      throw new Error(
        "GeminiAdapter: no API key. Set GEMINI_API_KEY (or GOOGLE_API_KEY) or pass { apiKey } to the constructor.",
      );
    }
    const fetchImpl = this.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
    if (typeof fetchImpl !== "function") {
      throw new Error(
        "GeminiAdapter: no fetch implementation available. Pass { fetchImpl } or run on a runtime with global fetch.",
      );
    }

    const maxTokens = budgetMaxTokens(model, prompt, options);
    const generationConfig: Record<string, unknown> = {};
    if (maxTokens !== undefined) {
      generationConfig.maxOutputTokens = maxTokens;
    }
    if (options.temperature !== undefined) {
      generationConfig.temperature = options.temperature;
    }

    const body: Record<string, unknown> = {
      contents: conversation(prompt, options).map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      })),
    };
    if (options.system) {
      body.systemInstruction = { parts: [{ text: options.system }] };
    }
    if (Object.keys(generationConfig).length > 0) {
      body.generationConfig = generationConfig;
    }

    // The API key rides in the `x-goog-api-key` header (keeping it out of the
    // URL / access logs) rather than the legacy `?key=` query parameter.
    const url = `${this.baseUrl}/models/${encodeURIComponent(model)}:generateContent`;
    const apiKey = this.apiKey;
    const data = (await withLlmTimeout(this.provider, options.timeoutMs, async (request) => {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify(body),
        ...(request ? { signal: request.signal } : {}),
      });
      if (!res.ok) {
        let detail = "";
        try {
          detail = (await res.text()).slice(0, 300);
        } catch {
          detail = "(no response body)";
        }
        throw new Error(`Gemini API ${res.status}: ${detail}`);
      }
      return res.json();
    })) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
      }>;
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        totalTokenCount?: number;
      };
      modelVersion?: string;
    };
    const text = (data.candidates?.[0]?.content?.parts ?? [])
      .map((p) => (typeof p.text === "string" ? p.text : ""))
      .join("");
    const inputTokens = data.usageMetadata?.promptTokenCount;
    const outputTokens = data.usageMetadata?.candidatesTokenCount;
    const totalTokens =
      data.usageMetadata?.totalTokenCount ??
      (inputTokens !== undefined && outputTokens !== undefined
        ? inputTokens + outputTokens
        : undefined);
    return {
      text,
      usage: { inputTokens, outputTokens, totalTokens },
      model: data.modelVersion ?? model,
      provider: this.provider,
      raw: data,
    };
  }

  // No dispatchBatch / retrieveBatch — see the module docstring. The
  // scheduler keeps Gemini tasks on the sync path.
}
