/**
 * Anthropic provider adapter.
 *
 * Wraps @anthropic-ai/sdk. The SDK is a peer dependency — this module
 * imports it lazily so missing-SDK callers still get a clear error
 * instead of a module-load crash.
 *
 * Endpoints used:
 *   - messages.create — sync dispatch
 *   - messages.batches.create — Batch API (50% off, 24h SLA)
 */

import { normalizeModelName } from "../energy.js";
import { conversation, ProviderRefusalError } from "./base.js";
import { budgetMaxTokens } from "./budget.js";
import { withLlmTimeout } from "./timeout.js";
import type {
  BatchHandle,
  BatchRetrieveResult,
  DispatchOptions,
  DispatchResult,
  ProviderAdapter,
} from "./base.js";

/**
 * Output ceiling when the caller sets none. The `claude-api` skill's
 * non-streaming default: large enough not to truncate normal answers,
 * small enough to stay under the SDK's HTTP timeout.
 */
const DEFAULT_MAX_TOKENS = 16000;

/**
 * Allow-list: does this Claude model accept sampling parameters
 * (`temperature`)? Opus 4.7 and later, Sonnet 5, Fable and Mythos reject
 * them with a 400. True only for every Haiku id and for Opus / Sonnet 4.6
 * or lower; every other id, including models released after this list
 * was written, gets false. Omitting `temperature` never breaks a request;
 * sending it to a model that rejects it always does.
 */
export function supportsSamplingParams(model: string): boolean {
  const m = normalizeModelName(model).match(
    /^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?!\d)/,
  );
  if (!m) return false;
  if (m[1] === "haiku") return true;
  const major = Number(m[2]);
  const minor = Number(m[3] ?? 0);
  return major < 4 || (major === 4 && minor <= 6);
}

interface AnthropicMessage {
  content?: Array<{ type: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
  model?: string;
  stop_reason?: string | null;
  stop_details?: { category?: string | null } | null;
}

function messageText(message: AnthropicMessage | undefined): string {
  return (message?.content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
}

/** Throw on a refusal: the response is HTTP 200 but carries no answer. */
function assertNotRefused(message: AnthropicMessage | undefined, model: string): void {
  if (message?.stop_reason === "refusal") {
    throw new ProviderRefusalError(
      "anthropic",
      message.model ?? model,
      message.stop_details?.category ?? null,
    );
  }
}

export interface AnthropicAdapterOptions {
  /**
   * API key. Supplied by the host — this library never reads the environment.
   * The `tidegap` CLI and `@tidegap/mcp` server read `ANTHROPIC_API_KEY` and pass
   * it here; the OpenClaw plugin passes `anthropicApiKey` from plugin config.
   * Without a key (and without `client`), `ready` is false.
   */
  apiKey?: string;
  /**
   * Inject an already-constructed SDK client. Useful for tests and for
   * callers that want to reuse a single client across the process.
   */
  client?: unknown;
}

interface AnthropicMessagesClient {
  messages: {
    create(req: unknown, options?: { signal?: AbortSignal; timeout?: number }): Promise<unknown>;
    batches: {
      create(req: unknown): Promise<unknown>;
      retrieve(batchId: string): Promise<unknown>;
      results(batchId: string): Promise<AsyncIterable<unknown>>;
    };
  };
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly provider = "anthropic";
  private readonly apiKey: string | undefined;
  private client: AnthropicMessagesClient | undefined;

  constructor(opts: AnthropicAdapterOptions = {}) {
    this.apiKey = opts.apiKey;
    if (opts.client) {
      this.client = opts.client as AnthropicMessagesClient;
    }
  }

  get ready(): boolean {
    return Boolean(this.client) || Boolean(this.apiKey);
  }

  async dispatch(
    model: string,
    prompt: string,
    options: DispatchOptions = {},
  ): Promise<DispatchResult> {
    const maxTokens = budgetMaxTokens(model, prompt, options, DEFAULT_MAX_TOKENS);
    const client = await this.getClient();
    const req = {
      ...requestParams(model, prompt, { ...options, maxTokens }),
      metadata: options.metadata ? { user_id: undefined, ...options.metadata } : undefined,
    };
    const res = (await withLlmTimeout(this.provider, options.timeoutMs, (request) =>
      request ? client.messages.create(req, request) : client.messages.create(req),
    )) as AnthropicMessage;
    assertNotRefused(res, model);
    return {
      text: messageText(res),
      usage: {
        inputTokens: res.usage?.input_tokens,
        outputTokens: res.usage?.output_tokens,
        totalTokens:
          res.usage?.input_tokens !== undefined && res.usage?.output_tokens !== undefined
            ? res.usage.input_tokens + res.usage.output_tokens
            : undefined,
      },
      model: res.model ?? model,
      provider: this.provider,
      raw: res,
      stopReason: res.stop_reason ?? undefined,
    };
  }

  async dispatchBatch(
    model: string,
    prompts: string[],
    options: DispatchOptions = {},
  ): Promise<BatchHandle> {
    if (prompts.length === 0) {
      throw new Error("dispatchBatch: prompts must contain at least one entry");
    }
    const client = await this.getClient();
    const requests = prompts.map((prompt, i) => ({
      custom_id: `tidegap-${i}`,
      params: requestParams(model, prompt, options),
    }));
    const res = (await client.messages.batches.create({ requests })) as {
      id?: string;
    };
    if (!res.id) {
      throw new Error("Anthropic Batch API returned no batch id");
    }
    return { batchId: res.id, provider: this.provider, size: prompts.length };
  }

  /**
   * Poll a Message Batch. Maps Anthropic's
   * `processing_status` ("in_progress" | "canceling" | "ended") plus the
   * per-request `request_counts` onto the uniform BatchRetrieveResult.
   * Once the batch has ended we stream `messages.batches.results`, which
   * yields one entry per request with a `result` union (succeeded /
   * errored / expired / canceled).
   */
  async retrieveBatch(batchId: string): Promise<BatchRetrieveResult> {
    const client = await this.getClient();
    const batch = (await client.messages.batches.retrieve(batchId)) as {
      processing_status?: string;
    };
    if (batch.processing_status !== "ended") {
      // "in_progress" and "canceling" are both still-running from our POV.
      return { status: "in_progress" };
    }
    const results: NonNullable<BatchRetrieveResult["results"]> = [];
    let sawExpired = false;
    let sawError = false;
    let firstError: string | undefined;
    const iterable = await client.messages.batches.results(batchId);
    for await (const entry of iterable) {
      const e = entry as {
        result?: {
          type?: string;
          message?: AnthropicMessage;
          error?: { message?: string; type?: string };
        };
      };
      const type = e.result?.type;
      const message = e.result?.message;
      if (type === "succeeded" && message?.stop_reason === "refusal") {
        // A refused request succeeded at the HTTP level but has no answer.
        sawError = true;
        firstError ??= new ProviderRefusalError(
          this.provider,
          message.model ?? "unknown model",
          message.stop_details?.category ?? null,
        ).message;
      } else if (type === "succeeded") {
        const text = messageText(message);
        const inputTokens = message?.usage?.input_tokens;
        const outputTokens = message?.usage?.output_tokens;
        results.push({
          text,
          model: message?.model,
          stopReason: message?.stop_reason ?? undefined,
          usage: {
            inputTokens,
            outputTokens,
            totalTokens:
              inputTokens !== undefined && outputTokens !== undefined
                ? inputTokens + outputTokens
                : undefined,
          },
        });
      } else if (type === "expired") {
        sawExpired = true;
      } else {
        sawError = true;
        firstError ??=
          e.result?.error?.message ?? `batch request result type: ${type}`;
      }
    }
    if (results.length > 0) {
      return { status: "completed", results };
    }
    if (sawExpired) {
      return { status: "expired", error: "Anthropic batch request expired" };
    }
    if (sawError) {
      return { status: "failed", error: firstError ?? "Anthropic batch request failed" };
    }
    // Ended with no parseable results — treat as failed rather than hang.
    return { status: "failed", error: "Anthropic batch ended with no results" };
  }

  private async getClient(): Promise<AnthropicMessagesClient> {
    if (this.client) return this.client;
    if (!this.apiKey) {
      throw new Error(
        "AnthropicAdapter: no API key. Set ANTHROPIC_API_KEY or pass { apiKey } to the constructor.",
      );
    }
    let Anthropic: new (opts: {
      apiKey: string;
      maxRetries?: number;
    }) => AnthropicMessagesClient;
    try {
      const mod = (await import("@anthropic-ai/sdk")) as
        | { default: typeof Anthropic }
        | { Anthropic: typeof Anthropic };
      Anthropic =
        "default" in mod
          ? mod.default
          : (mod as { Anthropic: typeof Anthropic }).Anthropic;
    } catch (err) {
      throw new Error(
        "AnthropicAdapter: @anthropic-ai/sdk is not installed. Run `pnpm add @anthropic-ai/sdk`.",
      );
    }
    // maxRetries: 0 — Tidegap's scheduler owns the retry policy
    // (retryWithBackoff); letting the SDK retry too multiplies attempts
    // and can double-bill ambiguous network errors.
    this.client = new Anthropic({ apiKey: this.apiKey, maxRetries: 0 });
    return this.client;
  }
}

/**
 * The request fields shared by `messages.create` and each Message Batches
 * entry. `temperature` is left out entirely for models that reject it.
 */
function requestParams(
  model: string,
  prompt: string,
  options: DispatchOptions,
): Record<string, unknown> {
  const params: Record<string, unknown> = {
    model,
    max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    system: options.system,
    messages: conversation(prompt, options),
  };
  if (options.temperature !== undefined && supportsSamplingParams(model)) {
    params.temperature = options.temperature;
  }
  return params;
}
