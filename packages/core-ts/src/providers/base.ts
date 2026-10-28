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

import type { RunSession } from "../run-session.js";
import type { JobCaps, ProviderCallSpec, TaskMessage } from "../types.js";

/** The agent session a task came from (KTD13). Only `claude-code` runs receive it. */
export interface DispatchOrigin {
  sessionId: string;
  /** The session's project directory. */
  cwd: string;
  agent: "claude-code" | "codex";
  transcriptPath?: string;
}

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
  /**
   * The session that queued the task, for a run that resumes a copy of it.
   * The scheduler passes it to `claude-code` tasks only.
   */
  origin?: DispatchOrigin;
  /**
   * Per-call time limit in ms (a job's `llmTimeoutMs`). Overrides the
   * adapter's own limit; adapters without one ignore it.
   */
  timeoutMs?: number;
  /**
   * Per-call budget in USD (a job's `maxBudgetUsd`). `claude-code` passes it
   * as `--max-budget-usd`; API adapters cap `maxTokens` with it and refuse a
   * call whose input alone costs more (KTD8).
   */
  maxBudgetUsd?: number;
  /**
   * Working directory of a job occurrence (KTD8). `claude-code` runs fresh
   * there, never as a fork of a session; `~` is the home folder.
   */
  cwd?: string;
  /** The job the occurrence belongs to; the `command` adapter refuses a call without one. */
  jobId?: string;
  /** The shell step of a command job occurrence (`command` adapter only). */
  command?: ProviderCallSpec["command"];
  /** The tool-less summarize step after the shell step (`command` adapter only). */
  summarize?: ProviderCallSpec["summarize"];
  /** The job's caps (`command` adapter only; other adapters get `timeoutMs` and `maxBudgetUsd`). */
  caps?: JobCaps;
}

/**
 * Extra keys for the occurrence's `completed` or `failed` event (KTD7):
 * the steps that ran, which cap stopped the run, whether output was cut.
 * Never in the signed receipt.
 */
export interface RunDetails {
  /** Steps of the run, in order: `command`, `prompt`. */
  steps?: string[];
  /** The cap that stopped the run: `command_timeout`, `llm_timeout`, `budget`. */
  stopped_by?: "command_timeout" | "llm_timeout" | "budget";
  /** True when the command output went over `outputCapBytes` and the rest was dropped. */
  truncated?: boolean;
}

/** Prior turns followed by the current prompt as the last user turn. */
export function conversation(
  prompt: string,
  options: Pick<DispatchOptions, "messages"> = {},
): TaskMessage[] {
  return [...(options.messages ?? []), { role: "user", content: prompt }];
}

/**
 * The tokens one model used in a run (KTD9). `inputTokens` counts fresh
 * input plus cache writes; cache reads are not counted. A count the model
 * did not report is absent: the bill then uses the typical count, as on the
 * single-model path (`billModelUsage`).
 */
export interface ModelUsage {
  model: string;
  inputTokens?: number;
  outputTokens?: number;
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
  /**
   * The tokens of each model the run used (KTD9). With two or more billed
   * entries the scheduler bills each model with its own coefficients and
   * writes the breakdown to the receipt; otherwise it bills `usage` under
   * `model`, as before.
   */
  modelUsage?: ModelUsage[];
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
  /** Where the run happened: a fork of the origin session or a fresh one (claude-code only). Recorded on the receipt. */
  session?: RunSession;
  /** Extra keys for the `completed` event; not on the receipt. */
  details?: RunDetails;
}

/**
 * An error the scheduler must not retry: the call may have done work that
 * must not run twice (a job's shell step), or retrying cannot help (a
 * budget the input alone exceeds). `details` go on the `failed` event.
 */
export class NonRetryableError extends Error {
  readonly nonRetryable = true;
  readonly details?: RunDetails;

  constructor(message: string, details?: RunDetails) {
    super(message);
    this.name = "NonRetryableError";
    if (details) this.details = details;
  }
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
