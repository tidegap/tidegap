/**
 * The opt-in OAuth usage client (KTD3): one GET of Anthropic's undocumented
 * `/api/oauth/usage` with the Claude Code login's token. Off by default
 * (`TIDEGAP_USAGE_OAUTH=1` turns it on). Errors carry a kind, never the
 * token, the response body or its headers.
 */

import type { ClaudeLimits, ScopedWindow } from "./types.js";

export const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const USAGE_TIMEOUT_MS = 5_000;

/** The subset of `fetch` the client uses, so tests inject a fake. */
export type FetchLike = (
  url: string,
  init: { method: "GET"; headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ status: number; headers: { get(name: string): string | null }; json(): Promise<unknown> }>;

export type UsageErrorKind =
  | "http-401"
  | "http-403"
  | "http-429"
  | "http-5xx"
  | "http-other"
  | "timeout"
  | "network"
  | "bad-response";

export type UsageFetchResult =
  | { ok: true; limits: ClaudeLimits }
  | { ok: false; kind: UsageErrorKind; retryAfterS?: number };

function iso(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

function utilWindow(v: unknown): { pct: number; resets_at: string } | undefined {
  if (!v || typeof v !== "object") return undefined;
  const w = v as { utilization?: unknown; resets_at?: unknown };
  const at = iso(w.resets_at);
  return typeof w.utilization === "number" && Number.isFinite(w.utilization) && at
    ? { pct: w.utilization, resets_at: at }
    : undefined;
}

/** Normalize the response; unknown fields are ignored. */
export function normalizeUsage(body: unknown): ClaudeLimits | undefined {
  if (!body || typeof body !== "object") return undefined;
  const o = body as { five_hour?: unknown; seven_day?: unknown; limits?: unknown };
  const scoped: ScopedWindow[] = [];
  if (Array.isArray(o.limits)) {
    for (const entry of o.limits) {
      const e = entry as { scope?: { model?: { display_name?: unknown } }; percent?: unknown; resets_at?: unknown };
      const model = e?.scope?.model?.display_name;
      const at = iso(e?.resets_at);
      if (typeof model === "string" && model && typeof e.percent === "number" && at) {
        scoped.push({ model, pct: e.percent, resets_at: at });
      }
    }
  }
  const out: ClaudeLimits = { scoped };
  const five = utilWindow(o.five_hour);
  const seven = utilWindow(o.seven_day);
  if (five) out.five_hour = five;
  if (seven) out.seven_day = seven;
  return five || seven ? out : undefined;
}

export async function fetchClaudeUsage(
  token: string,
  opts: { fetch: FetchLike; userAgent: string; timeoutMs?: number },
): Promise<UsageFetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? USAGE_TIMEOUT_MS);
  try {
    const res = await opts.fetch(USAGE_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": opts.userAgent,
      },
      signal: controller.signal,
    });
    if (res.status === 429) {
      const ra = Number(res.headers.get("retry-after"));
      return { ok: false, kind: "http-429", ...(Number.isFinite(ra) && ra > 0 ? { retryAfterS: ra } : {}) };
    }
    if (res.status === 401) return { ok: false, kind: "http-401" };
    if (res.status === 403) return { ok: false, kind: "http-403" };
    if (res.status >= 500) return { ok: false, kind: "http-5xx" };
    if (res.status !== 200) return { ok: false, kind: "http-other" };
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { ok: false, kind: "bad-response" };
    }
    const limits = normalizeUsage(body);
    return limits ? { ok: true, limits } : { ok: false, kind: "bad-response" };
  } catch {
    return { ok: false, kind: controller.signal.aborted ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}
