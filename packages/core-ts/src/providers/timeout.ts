/**
 * The model time limit of an API adapter (KTD14): a job's `llmTimeoutMs`
 * reaches the adapter as `timeoutMs`. The call gets an abort signal, and the
 * dispatch rejects when the limit passes, even when the client ignores the
 * signal. An SDK client also gets the limit as its own request timeout, so
 * its default (10 minutes) cannot end a longer call first, unlabelled. The error names the cap in its details (`stopped_by:
 * "llm_timeout"`), so no caller reads the message text for it, and it is
 * not retried: the limit is spent.
 */

import { NonRetryableError } from "./base.js";

/** The longest delay `setTimeout` honours; a larger one fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** What an SDK request takes: the abort signal and its own timeout (the same limit, clamped). */
export interface LlmRequestOptions {
  signal: AbortSignal;
  timeout: number;
}

export async function withLlmTimeout<T>(
  provider: string,
  timeoutMs: number | undefined,
  call: (request: LlmRequestOptions | undefined) => Promise<T>,
): Promise<T> {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return call(undefined);
  const controller = new AbortController();
  const limit = Math.min(timeoutMs, MAX_TIMER_MS);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Settled before the abort, so a client that rejects on abort at once cannot win the race.
      reject(new NonRetryableError(`${provider}: timed out after ${timeoutMs / 1000}s`, { stopped_by: "llm_timeout" }));
      controller.abort();
    }, limit);
  });
  try {
    return await Promise.race([call({ signal: controller.signal, timeout: limit }), expired]);
  } finally {
    clearTimeout(timer);
  }
}
