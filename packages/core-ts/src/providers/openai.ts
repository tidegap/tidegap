/**
 * OpenAI provider adapter.
 *
 * Wraps the `openai` SDK. Lazy import (like the Anthropic adapter).
 *
 * Endpoints used:
 *   - responses.create / chat.completions.create — sync dispatch
 *   - files.create({ purpose: "batch" }) + batches.create — Batch API
 *     (50% off, 24h SLA). OpenAI's batch input is a JSONL file uploaded
 *     to /v1/files, then referenced by id from POST /v1/batches.
 */

import { conversation } from "./base.js";
import { budgetMaxTokens } from "./budget.js";
import type {
  BatchHandle,
  BatchRetrieveResult,
  DispatchOptions,
  DispatchResult,
  ProviderAdapter,
} from "./base.js";

export interface OpenAIAdapterOptions {
  /**
   * API key. Supplied by the host — this library never reads the environment.
   * The `tidegap` CLI and `@tidegap/mcp` server read `OPENAI_API_KEY` and pass it
   * here; the OpenClaw plugin passes `openaiApiKey` from plugin config.
   */
  apiKey?: string;
  /** Inject an already-constructed SDK client (tests, client reuse). */
  client?: unknown;
}

interface OpenAIClient {
  chat: {
    completions: {
      create(req: unknown): Promise<unknown>;
    };
  };
  files: {
    create(req: unknown): Promise<unknown>;
    content(fileId: string): Promise<unknown>;
  };
  batches: {
    create(req: unknown): Promise<unknown>;
    retrieve(batchId: string): Promise<unknown>;
  };
}

/** o-series reasoning models (o1, o3, o4-mini, …). */
function isOSeriesModel(model: string): boolean {
  return /^o\d/.test(model.trim().toLowerCase());
}

/** gpt-5 and gpt-6 families (gpt-5, gpt-5-mini, gpt-5.1, gpt-6-sol, …). */
function isGpt5Or6FamilyModel(model: string): boolean {
  return /^gpt-[56]/.test(model.trim().toLowerCase());
}

/**
 * Build the token/temperature portion of a chat.completions payload.
 * o-series, gpt-5 and gpt-6 family models reject the legacy `max_tokens`
 * parameter (400 "Unsupported parameter") and require
 * `max_completion_tokens`; o-series additionally rejects `temperature`.
 * Everything else keeps the classic parameters.
 */
function completionParams(
  model: string,
  options: DispatchOptions,
): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (isOSeriesModel(model) || isGpt5Or6FamilyModel(model)) {
    params.max_completion_tokens = options.maxTokens;
  } else {
    params.max_tokens = options.maxTokens;
  }
  if (!isOSeriesModel(model)) {
    params.temperature = options.temperature;
  }
  return params;
}

/** Chat messages: the optional system turn, prior turns, then the prompt. */
function chatMessages(
  prompt: string,
  options: DispatchOptions,
): Array<{ role: string; content: string }> {
  const turns = conversation(prompt, options);
  return options.system ? [{ role: "system", content: options.system }, ...turns] : turns;
}

export class OpenAIAdapter implements ProviderAdapter {
  readonly provider = "openai";
  private readonly apiKey: string | undefined;
  private client: OpenAIClient | undefined;

  constructor(opts: OpenAIAdapterOptions = {}) {
    this.apiKey = opts.apiKey;
    if (opts.client) {
      this.client = opts.client as OpenAIClient;
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
    const maxTokens = budgetMaxTokens(model, prompt, options);
    const client = await this.getClient();
    const messages = chatMessages(prompt, options);
    const res = (await client.chat.completions.create({
      model,
      messages,
      ...completionParams(model, { ...options, maxTokens }),
    })) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
      model?: string;
    };
    const text = res.choices?.[0]?.message?.content ?? "";
    return {
      text,
      usage: {
        inputTokens: res.usage?.prompt_tokens,
        outputTokens: res.usage?.completion_tokens,
        totalTokens: res.usage?.total_tokens,
      },
      model: res.model ?? model,
      provider: this.provider,
      raw: res,
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
    const jsonl = prompts
      .map((prompt, i) => {
        const messages = chatMessages(prompt, options);
        const body = {
          custom_id: `tidegap-${i}`,
          method: "POST",
          url: "/v1/chat/completions",
          body: {
            model,
            messages,
            ...completionParams(model, options),
          },
        };
        return JSON.stringify(body);
      })
      .join("\n");
    const buffer = new TextEncoder().encode(jsonl);
    const file = (await client.files.create({
      file: new Blob([buffer], { type: "application/jsonl" }),
      purpose: "batch",
    })) as { id?: string };
    if (!file.id) {
      throw new Error("OpenAI Files API returned no file id");
    }
    const batch = (await client.batches.create({
      input_file_id: file.id,
      endpoint: "/v1/chat/completions",
      completion_window: "24h",
    })) as { id?: string };
    if (!batch.id) {
      throw new Error("OpenAI Batch API returned no batch id");
    }
    return { batchId: batch.id, provider: this.provider, size: prompts.length };
  }

  /**
   * Poll an OpenAI batch. Maps the batch `status`
   * ("validating" | "in_progress" | "finalizing" | "completed" |
   * "failed" | "expired" | "cancelled") onto the uniform result. When
   * completed we download the `output_file_id` content (JSONL, one line
   * per request) and parse the chat-completion `response.body`.
   */
  async retrieveBatch(batchId: string): Promise<BatchRetrieveResult> {
    const client = await this.getClient();
    const batch = (await client.batches.retrieve(batchId)) as {
      status?: string;
      output_file_id?: string;
      error_file_id?: string;
      errors?: { data?: Array<{ message?: string }> };
    };
    const status = batch.status;
    if (
      status === "validating" ||
      status === "in_progress" ||
      status === "finalizing"
    ) {
      return { status: "in_progress" };
    }
    if (status === "expired") {
      return { status: "expired", error: "OpenAI batch expired" };
    }
    if (status === "failed" || status === "cancelled" || status === "cancelling") {
      const msg =
        batch.errors?.data?.[0]?.message ?? `OpenAI batch ${status}`;
      return { status: "failed", error: msg };
    }
    // status === "completed"
    if (!batch.output_file_id) {
      return { status: "failed", error: "OpenAI batch completed with no output file" };
    }
    const content = (await client.files.content(batch.output_file_id)) as {
      text?: () => Promise<string>;
    };
    const jsonl =
      typeof content?.text === "function"
        ? await content.text()
        : String(content);
    const results: NonNullable<BatchRetrieveResult["results"]> = [];
    for (const line of jsonl.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: {
        response?: {
          body?: {
            choices?: Array<{ message?: { content?: string } }>;
            usage?: {
              prompt_tokens?: number;
              completion_tokens?: number;
              total_tokens?: number;
            };
            model?: string;
          };
        };
      };
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const body = parsed.response?.body;
      if (!body) continue;
      results.push({
        text: body.choices?.[0]?.message?.content ?? "",
        model: body.model,
        usage: {
          inputTokens: body.usage?.prompt_tokens,
          outputTokens: body.usage?.completion_tokens,
          totalTokens: body.usage?.total_tokens,
        },
      });
    }
    if (results.length === 0) {
      return { status: "failed", error: "OpenAI batch output had no parseable results" };
    }
    return { status: "completed", results };
  }

  private async getClient(): Promise<OpenAIClient> {
    if (this.client) return this.client;
    if (!this.apiKey) {
      throw new Error(
        "OpenAIAdapter: no API key. Set OPENAI_API_KEY or pass { apiKey } to the constructor.",
      );
    }
    let OpenAI: new (opts: { apiKey: string; maxRetries?: number }) => OpenAIClient;
    try {
      const mod = (await import("openai")) as
        | { default: typeof OpenAI }
        | { OpenAI: typeof OpenAI };
      OpenAI =
        "default" in mod ? mod.default : (mod as { OpenAI: typeof OpenAI }).OpenAI;
    } catch (err) {
      throw new Error(
        "OpenAIAdapter: `openai` SDK is not installed. Run `pnpm add openai`.",
      );
    }
    // maxRetries: 0 — Tidegap's scheduler owns the retry policy
    // (retryWithBackoff); letting the SDK retry too multiplies attempts
    // and can double-bill ambiguous network errors.
    this.client = new OpenAI({ apiKey: this.apiKey, maxRetries: 0 });
    return this.client;
  }
}
