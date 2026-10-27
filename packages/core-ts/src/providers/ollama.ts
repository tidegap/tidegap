/**
 * Ollama provider adapter.
 *
 * Talks to a local Ollama server over HTTP (default
 * http://localhost:11434, override with `OLLAMA_HOST`). No API key — Ollama
 * runs on the machine. Uses `fetch` directly; no vendor SDK dependency.
 *
 * Endpoint used:
 *   - POST /api/chat (stream:false) — sync dispatch, returns the assistant
 *     message plus `prompt_eval_count` / `eval_count` token counts.
 *
 * Batch: UNSUPPORTED. Ollama is local inference with no batch API — there is
 * no cost/SLA batch tier to route through. `dispatchBatch` is omitted; the
 * scheduler keeps Ollama tasks on the sync path.
 *
 * Carbon accounting is unchanged: energy coefficients for local models
 * (llama-*, mistral-*, mixtral-*) already live in the SSOT energy table, and
 * the receipt math applies the caller's grid intensity exactly as it does for
 * hosted providers. There is no special-cased "local" carbon logic here.
 */

import { conversation } from "./base.js";
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

export interface OllamaAdapterOptions {
  /**
   * Base host URL, supplied by the host application — this library never
   * reads the environment. Defaults to `http://localhost:11434` when omitted.
   * A bare `host:port` is accepted and prefixed with `http://`.
   *
   * The `tidegap` CLI and `@tidegap/mcp` server read `OLLAMA_HOST` and pass it
   * here; the OpenClaw plugin passes `ollamaHost` from plugin config.
   */
  host?: string;
  /** Inject a `fetch` implementation. Defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
}

const DEFAULT_HOST = "http://localhost:11434";

/** Normalize a host string into a scheme-qualified base URL with no trailing slash. */
function normalizeHost(raw: string | undefined): string {
  const h = (raw ?? DEFAULT_HOST).trim() || DEFAULT_HOST;
  const withScheme = /^https?:\/\//i.test(h) ? h : `http://${h}`;
  return withScheme.replace(/\/$/, "");
}

export class OllamaAdapter implements ProviderAdapter {
  readonly provider = "ollama";
  private readonly host: string;
  private readonly fetchImpl: FetchLike | undefined;

  constructor(opts: OllamaAdapterOptions = {}) {
    this.host = normalizeHost(opts.host);
    this.fetchImpl = opts.fetchImpl;
  }

  /**
   * Always "ready": Ollama needs no credential. Whether the local server is
   * actually reachable is only known at dispatch time (a connection-refused
   * surfaces there, not here).
   */
  get ready(): boolean {
    return true;
  }

  async dispatch(
    model: string,
    prompt: string,
    options: DispatchOptions = {},
  ): Promise<DispatchResult> {
    const fetchImpl = this.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
    if (typeof fetchImpl !== "function") {
      throw new Error(
        "OllamaAdapter: no fetch implementation available. Pass { fetchImpl } or run on a runtime with global fetch.",
      );
    }

    const ollamaOptions: Record<string, unknown> = {};
    if (options.temperature !== undefined) {
      ollamaOptions.temperature = options.temperature;
    }
    if (options.maxTokens !== undefined) {
      ollamaOptions.num_predict = options.maxTokens;
    }

    const messages = [
      ...(options.system ? [{ role: "system", content: options.system }] : []),
      ...conversation(prompt, options),
    ];

    const body: Record<string, unknown> = {
      model,
      messages,
      stream: false,
    };
    if (Object.keys(ollamaOptions).length > 0) {
      body.options = ollamaOptions;
    }

    const url = `${this.host}/api/chat`;
    const data = (await withLlmTimeout(this.provider, options.timeoutMs, async (request) => {
      let res: Awaited<ReturnType<FetchLike>>;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          ...(request ? { signal: request.signal } : {}),
        });
      } catch (err) {
        // Connection refused / DNS / TLS — the local server is not reachable.
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(
          `OllamaAdapter: could not reach Ollama at ${this.host} (${detail}). ` +
            `Is \`ollama serve\` running? Set OLLAMA_HOST to override the address.`,
        );
      }
      if (!res.ok) {
        let detail = "";
        try {
          detail = (await res.text()).slice(0, 300);
        } catch {
          detail = "(no response body)";
        }
        throw new Error(`Ollama API ${res.status}: ${detail}`);
      }
      return res.json();
    })) as {
      message?: { content?: string };
      prompt_eval_count?: number;
      eval_count?: number;
      model?: string;
    };
    const inputTokens = data.prompt_eval_count;
    const outputTokens = data.eval_count;
    return {
      text: data.message?.content ?? "",
      usage: {
        inputTokens,
        outputTokens,
        totalTokens:
          inputTokens !== undefined && outputTokens !== undefined
            ? inputTokens + outputTokens
            : undefined,
      },
      model: data.model ?? model,
      provider: this.provider,
      raw: data,
    };
  }

  // No dispatchBatch / retrieveBatch — Ollama has no batch API.
}
