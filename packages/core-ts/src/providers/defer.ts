/**
 * A provider asks the scheduler to put a running task back in the queue
 * until `retryAt` instead of failing it (for example a subscription usage
 * limit that resets at a known time). Not retried; the series does not roll.
 */
export class ProviderDeferError extends Error {
  override name = "ProviderDeferError";
  constructor(
    message: string,
    public readonly retryAt: Date,
  ) {
    super(message);
  }
}

/**
 * The `retryAt` of a defer request, or undefined. Matches by `instanceof`
 * or by name, because the CLI and core can load separate copies of the class.
 */
export function deferRetryAt(err: unknown): Date | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as { name?: unknown; retryAt?: unknown };
  if (!(err instanceof ProviderDeferError) && e.name !== "ProviderDeferError") return undefined;
  const at =
    e.retryAt instanceof Date
      ? e.retryAt
      : typeof e.retryAt === "string" || typeof e.retryAt === "number"
        ? new Date(e.retryAt)
        : undefined;
  return at && Number.isFinite(at.getTime()) ? at : undefined;
}
