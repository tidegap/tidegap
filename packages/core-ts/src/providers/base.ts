/**
 * Provider adapter interface.
 *
 * Adapters wrap a vendor SDK (Anthropic, OpenAI, etc.) and expose two
 * uniform entry points:
 *
 *   - dispatch(): single synchronous-ish LLM call, returns when complete.
 *     The scheduler waits until the chosen carbon window, then calls this.
 *
 *   - dispatchBatch(): submit N prompts via the vendor's Batch API
 *     (Anthropic Message Batches, OpenAI Batch Files). Returns a handle.
 *     50% cheaper, up-to-24h SLA. The scheduler routes deadline > 24h
 *     tasks here automatically (status "submitted"), then polls
 *     retrieveBatch() from tick() until results land (status "completed").
 *
 *   - retrieveBatch(): poll a submitted batch by id; returns status and,
 *     when completed, the parsed per-request results (text + usage).
 *
 * Adapter modules import the vendor SDK lazily so the package can be
 * installed without forcing both SDK dependencies on every consumer.
 */

import type { TaskMessage } from "../types.js";

export interface DispatchOptions {
  /** Sampling temperature; vendor-specific defaults if omitted. */
  temperature?: number;
  /** Max tokens to generate. */
  maxTokens?: number;
  /** Optional system prompt. */
  system?: string;
  /** Free-form metadata forwarded to the provider request (e.g. the
   *  Anthropic `metadata` field). Not recorded on the carbon receipt. */
  metadata?: Record<string, string>;
  /**
   * Prior conversation turns, oldest first (ui v2 reply). Sent before the
   * current prompt; Gemini maps `assistant` to its `model` role. Absent or
   * empty means a single-turn request, exactly as before.
   */
  messages?: TaskMessage[];
  /**
   * Claude Code tool names for a `claude-code` run (`[]` = none). Absent
   * means the adapter's default. Other adapters ignore it.
   */
  tools?: string[];
}

/** Prior turns followed by the current prompt as the last user turn. */
export function conversation(
  prompt: string,
  options: Pick<DispatchOptions, "messages"> = {},
): TaskMessage[] {
  return [...(options.messages ?? []), { role: "user", content: prompt }];
}

export interface DispatchResult {
  /** The model's text reply, concatenated across content blocks. */
  text: string;
  /** Token usage as reported by the provider. Fields may be missing. */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  /** Vendor identifier we used (e.g. "claude-sonnet-5", "gpt-6-sol"). */
  model: string;
  /** Vendor name: "anthropic" | "openai" | "..." */
  provider: string;
  /** Raw vendor response object. Inspect at your own risk. */
  raw: unknown;
  /**
   * Why the model stopped, as the provider reported it (Anthropic
   * `stop_reason`: "end_turn", "max_tokens", ...). A "max_tokens" value
   * means `text` is truncated. Absent when the provider does not report one.
   */
  stopReason?: string;
  /** Tools the run could use (claude-code only). Recorded on the receipt. */
  tools?: string[];
}

/**
 * Thrown when the provider declined the request (Anthropic
 * `stop_reason: "refusal"`). The call returned HTTP 200, but its content
 * is not an answer, so it must not be recorded as a completed task.
 * Carries no HTTP status, so the scheduler does not retry it.
 */
export class ProviderRefusalError extends Error {
  readonly provider: string;
  readonly model: string;
  /** Refusal category from `stop_details.category` ("cyber", "bio", ...), or null. */
  readonly category: string | null;

  constructor(provider: string, model: string, category: string | null) {
    super(
      `${provider} refused the request for ${model}` +
        (category ? ` (category: ${category})` : ""),
    );
    this.name = "ProviderRefusalError";
    this.provider = provider;
    this.model = model;
    this.category = category;
  }
}

export interface BatchHandle {
  /** Vendor batch identifier. Use the vendor SDK to poll for completion. */
  batchId: string;
  /** Vendor name, mirrors DispatchResult.provider. */
  provider: string;
  /** Number of prompts in this batch. */
  size: number;
}

/**
 * Result of polling a submitted batch via {@link ProviderAdapter.retrieveBatch}.
 *
 * The scheduler only ever submits single-prompt batches, so `results`
 * carries at most one entry; the scheduler takes `results[0]`.
 */
export interface BatchRetrieveResult {
  /**
   * Batch lifecycle:
   *   - "in_progress": still running; poll again later.
   *   - "completed":   results are available in `results`.
   *   - "failed":      the batch itself errored (not per-request).
   *   - "expired":     the batch exceeded its SLA without completing.
   */
  status: "in_progress" | "completed" | "failed" | "expired";
  /** Per-request results, present when status === "completed". */
  results?: Array<{
    text: string;
    model?: string;
    /** Provider stop reason for this request; "max_tokens" means truncated. */
    stopReason?: string;
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
    };
  }>;
  /** Human-readable error when status is "failed" / "expired". */
  error?: string;
}

export interface ProviderAdapter {
  /** Vendor name, lowercase, no spaces. */
  readonly provider: string;
  /** True if a usable client could be constructed (API key present etc.). */
  readonly ready: boolean;

  /** Run one prompt; resolve when the model finishes. */
  dispatch(
    model: string,
    prompt: string,
    options?: DispatchOptions,
  ): Promise<DispatchResult>;

  /**
   * Submit a batch of prompts; resolves once the batch is registered.
   *
   * Optional: a provider whose Batch API does not map cleanly onto this
   * submit → poll → results contract (e.g. Gemini, whose Developer-API
   * batch mode is a long-running operation keyed by an operation name and
   * whose Vertex batch path requires GCS/BigQuery I/O), or a local provider
   * with no batch API at all (Ollama), simply omits this method. The
   * scheduler feature-detects `typeof adapter.dispatchBatch === "function"`
   * and keeps batch-incapable adapters on the sync path.
   */
  dispatchBatch?(
    model: string,
    prompts: string[],
    options?: DispatchOptions,
  ): Promise<BatchHandle>;

  /**
   * Poll a submitted batch by id. Returns the batch's current status and,
   * when completed, the parsed per-request results (text + usage). The
   * scheduler calls this from `tick()` on every "submitted" task until it
   * observes a terminal status. Optional so adapters that only submit
   * (or third-party adapters) need not implement it — the scheduler
   * feature-detects `typeof adapter.retrieveBatch === "function"`.
   */
  retrieveBatch?(batchId: string): Promise<BatchRetrieveResult>;
}
