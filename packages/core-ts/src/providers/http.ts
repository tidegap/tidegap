/**
 * The HTTP layer of a model call with a resolved LLM time limit. Node's
 * `fetch` (undici) ends any request whose response headers, or a gap in
 * its body, take longer than 300 seconds, whatever the caller's own timer
 * says: a 10-minute limit, or `none`, would stop at 5 minutes. A call that
 * runs under a limit therefore gets its own undici dispatcher, per call,
 * whose header and body timeouts follow the limit (`0`, no timeout, for
 * `none`). Library code never sets the global dispatcher.
 *
 * The dispatcher belongs to the `undici` package, so a call that takes it
 * goes through that package's `fetch` ({@link httpFetch}), the SDK clients
 * included, rather than the `fetch` bundled with the running Node.
 *
 * A bundle that leaves `undici` out (the OpenClaw plugin, whose bundle may
 * read no environment, which undici does) aliases it to an empty module:
 * then Node's own `fetch` applies, with its 300-second header wait.
 */

import * as undici from "undici";
import type { Dispatcher } from "undici";

/** The `undici` package, or nothing in a bundle that leaves it out. */
const lib: Partial<typeof undici> = undici;

/**
 * Margin on top of the limit: the labelled time limit of `withLlmTimeout`
 * fires first, and undici's coarse timers never end a call before it.
 */
const DISPATCHER_MARGIN_MS = 30_000;

/** Node's own `fetch` as this module found it. */
const nodeFetch = globalThis.fetch;

/**
 * A body the `undici` package's `fetch` cannot send: Node's global
 * `FormData` is another class than the package's, which that `fetch` would
 * send as the text `[object FormData]` (an SDK file upload, such as the
 * OpenAI Batch input file).
 */
function foreignFormData(body: unknown): boolean {
  return typeof FormData !== "undefined" && body instanceof FormData && !(lib.FormData && body instanceof lib.FormData);
}

/**
 * The `fetch` that takes a dispatcher of {@link limitDispatcher}: the
 * `undici` package's, for a call that carries one. Every other call goes
 * through the global `fetch`, so an SDK's checks of that `fetch` (the
 * OpenAI SDK's `FormData` probe) and its uploads see the classes of the
 * running Node. A global `fetch` the host replaced (a test double, an
 * instrumentation layer) is used as is, without the dispatcher, which only
 * the `undici` package's own `fetch` knows; so is Node's without `undici`,
 * and so is a call with a global `FormData` body (file uploads, which run
 * under no time limit).
 */
export const httpFetch = ((input: Parameters<typeof undici.fetch>[0], init?: Parameters<typeof undici.fetch>[1]) => {
  const { dispatcher, ...rest } = init ?? {};
  if (dispatcher && lib.fetch && globalThis.fetch === nodeFetch && !foreignFormData(rest.body)) return lib.fetch(input, init);
  return (globalThis.fetch as unknown as typeof undici.fetch)(input, rest);
}) as typeof undici.fetch;

/** {@link httpFetch} as an SDK client's `fetch` option takes it. */
export const sdkFetch = httpFetch as unknown as typeof globalThis.fetch;

/** One dispatcher per limit, reused: each holds its own connection pool. */
const dispatchers = new Map<number | "none", Dispatcher>();
const MAX_DISPATCHERS = 16;

/**
 * The dispatcher of a call under `timeoutMs`: header and body timeouts of
 * the limit plus a margin, or none for `"none"`. Undefined without a limit
 * (a direct library call): Node's default applies.
 */
export function limitDispatcher(timeoutMs: number | "none" | undefined): Dispatcher | undefined {
  if (timeoutMs === undefined || !lib.Agent) return undefined;
  if (timeoutMs !== "none" && !(Number.isFinite(timeoutMs) && timeoutMs > 0)) return undefined;
  const cached = dispatchers.get(timeoutMs);
  if (cached) return cached;
  const timeout = timeoutMs === "none" ? 0 : timeoutMs + DISPATCHER_MARGIN_MS;
  const dispatcher = new lib.Agent({ headersTimeout: timeout, bodyTimeout: timeout });
  if (dispatchers.size >= MAX_DISPATCHERS) {
    const [oldest, agent] = dispatchers.entries().next().value!;
    dispatchers.delete(oldest);
    void agent.close().catch(() => undefined);
  }
  dispatchers.set(timeoutMs, dispatcher);
  return dispatcher;
}
