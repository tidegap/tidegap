/** Keys kept before a check sweeps out the ones with no call in their window. */
const SWEEP_AT = 256;

/**
 * A sliding-window call counter: at most `max` calls per `windowMs`, counted
 * per key. The UI server's limits (integrations, settings, replies) share it.
 */
export class SlidingWindowLimiter {
  private readonly calls = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** Seconds to wait when `key` is over the limit, else undefined (and the call is counted). */
  check(key: string, now: number = Date.now()): number | undefined {
    if (this.calls.size >= SWEEP_AT) this.sweep(now);
    const recent = (this.calls.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      this.calls.set(key, recent);
      return Math.max(1, Math.ceil((recent[0]! + this.windowMs - now) / 1000));
    }
    recent.push(now);
    this.calls.set(key, recent);
    return undefined;
  }

  /** Drop the keys whose last call is outside the window, so the map stays bounded. */
  private sweep(now: number): void {
    for (const [key, times] of this.calls) {
      if (now - times[times.length - 1]! >= this.windowMs) this.calls.delete(key);
    }
  }
}

/** The 429 body every limited route sends. */
export function rateLimited(wait: number): { status: 429; body: { error: string; code: "rate_limited"; retry_after_s: number } } {
  return { status: 429, body: { error: `Wait ${wait} seconds and try again.`, code: "rate_limited", retry_after_s: wait } };
}
