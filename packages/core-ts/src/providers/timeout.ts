/**
 * The LLM time limit of an API adapter: the limit the scheduler resolved
 * when the run started reaches the adapter as `timeoutMs`. The call gets an
 * abort signal, and the dispatch rejects when the limit passes, even when
 * the client ignores the signal. An SDK client also gets the limit as its
 * own request timeout, so its default (10 minutes) cannot end a longer call
 * first, unlabelled; with `"none"` it gets the longest timer it takes and
 * Tidegap sets none. The error names the cap in its details (`stopped_by:
 * "llm_timeout"`), so no caller reads the message text for it, and it is
 * not retried: the limit is spent.
 *
 * The caller's `signal` (a cancel of the task while it runs) aborts the call
 * the same way, at once, with a `stopped: the task was cancelled` error.
 *
 * Under a limit, `none` included, the request also carries an undici
 * dispatcher whose header and body timeouts follow the limit
 * (`fetchOptions.dispatcher`, see `http.ts`), so Node's 300-second header
 * timeout cannot end the call first: no hidden ceiling remains.
 */

import type { Dispatcher } from "undici";

import { NonRetryableError } from "./base.js";
import { limitDispatcher } from "./http.js";

/** The longest delay `setTimeout` honours; a larger one fires at once. Every timer that takes a user's limit clamps to it. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * What an SDK request takes: the abort signal; with a time limit, its own
 * timeout (the same limit, clamped) and the dispatcher of that limit, which
 * a `fetch` call passes as `dispatcher` (through `httpFetch`).
 */
export interface LlmRequestOptions {
  signal: AbortSignal;
  timeout?: number;
  fetchOptions?: { dispatcher: Dispatcher };
}

/** The error of a call stopped because its task was cancelled. */
function cancelledError(provider: string): NonRetryableError {
  return new NonRetryableError(`${provider}: stopped: the task was cancelled`);
}

export async function withLlmTimeout<T>(
  provider: string,
  timeoutMs: number | "none" | undefined,
  call: (request: LlmRequestOptions | undefined) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const unlimited = timeoutMs === "none";
  const limited = typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0;
  if (!limited && !unlimited && !signal) return call(undefined);
  if (signal?.aborted) throw cancelledError(provider);
  const controller = new AbortController();
  const limit = limited ? Math.min(timeoutMs, MAX_TIMER_MS) : undefined;
  const sdkTimeout = unlimited ? MAX_TIMER_MS : limit;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    // Each rejects before the abort, so a client that rejects on abort at once cannot win the race.
    if (limit !== undefined) {
      timer = setTimeout(() => {
        reject(new NonRetryableError(`${provider}: timed out after ${(timeoutMs as number) / 1000}s`, { stopped_by: "llm_timeout" }));
        controller.abort();
      }, limit);
    }
    if (signal) {
      onAbort = () => {
        reject(cancelledError(provider));
        controller.abort();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  try {
    const dispatcher = limitDispatcher(timeoutMs);
    const request: LlmRequestOptions = {
      signal: controller.signal,
      ...(sdkTimeout !== undefined ? { timeout: sdkTimeout } : {}),
      ...(dispatcher ? { fetchOptions: { dispatcher } } : {}),
    };
    return await Promise.race([call(request), stopped]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal!.removeEventListener("abort", onAbort);
  }
}
