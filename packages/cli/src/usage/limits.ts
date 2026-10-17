/**
 * One call returns the Claude limit state (R1, R2, R4): the statusline
 * reading, or, with `TIDEGAP_USAGE_OAUTH=1`, the cached or freshly fetched
 * OAuth usage read. Read-only towards Claude Code; writes only
 * `~/.tidegap/usage.json`.
 */

import { createRequire } from "node:module";

import { readUsageCache, usageCachePath, writeUsageCache, type OauthEntry, type UsageCacheFile } from "./cache.js";
import { fetchClaudeUsage, type FetchLike, type UsageErrorKind } from "./claude-limits.js";
import { readClaudeToken, type CredentialDeps } from "./credentials.js";
import type { ClaudeLimits, ClaudeLimitState, LimitCause, UsageEnv, UsageSettings } from "./types.js";

/** TTL of an explicit read (`tidegap usage`, MCP `tidegap_usage`). */
export const EXPLICIT_TTL_S = 300;
/** A forced read (a limit result in a tick) still reuses an entry this young. */
const FORCED_REUSE_S = 60;
/** After a 429 no request for at least this long: the budget is a trailing hour. */
const RATE_LIMIT_BACKOFF_S = 3_600;
/** A `Retry-After` longer than this is capped (a bad header must not block reads for good). */
const RATE_LIMIT_MAX_S = 7 * 86_400;

export const CAUSE_TEXT: Record<LimitCause, string> = {
  no_data:
    "no statusline reading yet; register `tidegap usage hook` as the Claude Code statusLine (tidegap install), or set TIDEGAP_USAGE_OAUTH=1",
  not_logged_in: "Claude Code is not logged in",
  api_key: "Claude Code uses an API key; it has no subscription limits",
  token_expired: "the Claude Code login token expired; Claude Code renews it on its next run",
  keychain_unavailable: "the macOS Keychain did not answer",
  rate_limited: "the usage API is rate-limited; retrying later",
  network: "network error reaching the usage API",
  api_error: "the usage API returned an error",
};

const KIND_CAUSE: Record<UsageErrorKind, LimitCause> = {
  "http-401": "token_expired",
  "http-403": "api_error",
  "http-429": "rate_limited",
  "http-5xx": "api_error",
  "http-other": "api_error",
  timeout: "network",
  network: "network",
  "bad-response": "api_error",
};

function userAgent(): string {
  try {
    const pkg = createRequire(import.meta.url)("../../package.json") as { version?: string };
    return `tidegap/${pkg.version ?? "0.0.0"}`;
  } catch {
    return "tidegap/0.0.0";
  }
}

export interface ReadLimitsOptions {
  settings: UsageSettings;
  env?: UsageEnv;
  cachePath?: string;
  now?: Date;
  /** Seconds a reading counts as fresh. Default {@link EXPLICIT_TTL_S}. */
  ttlS?: number;
  /** Skip the TTL (a limit result in a tick); still honors `retry_at` and reuses entries under 60 s. */
  force?: boolean;
  fetch?: FetchLike;
  timeoutMs?: number;
  /** Credential reader overrides (tests inject the Keychain runner and files). */
  credentials?: Omit<CredentialDeps, "env" | "now">;
}

/** A failed cache write must not lose the reading this call returns. */
function tryWriteCache(file: UsageCacheFile, path: string): void {
  try {
    writeUsageCache(file, path);
  } catch {
    // Read-only home or full disk: the next read fetches again.
  }
}

function ageS(at: string | undefined, now: Date): number | undefined {
  return at ? Math.max(0, Math.round((now.getTime() - Date.parse(at)) / 1000)) : undefined;
}

function fromData(
  data: ClaudeLimits,
  source: ClaudeLimitState["source"],
  fetchedAt: string,
  now: Date,
  stale: boolean,
  cause?: LimitCause,
): ClaudeLimitState {
  return {
    status: "ok",
    source,
    fetched_at: fetchedAt,
    age_s: ageS(fetchedAt, now),
    stale,
    ...(data.five_hour ? { five_hour: data.five_hour } : {}),
    ...(data.seven_day ? { seven_day: data.seven_day } : {}),
    scoped: data.scoped,
    ...(cause ? { error: { cause, message: CAUSE_TEXT[cause] } } : {}),
  };
}

function unavailable(cause: LimitCause): ClaudeLimitState {
  return { status: "unavailable", stale: false, scoped: [], error: { cause, message: CAUSE_TEXT[cause] } };
}

/** The newest last good value of either source, marked stale, with `cause`. */
function lastGood(
  sl: { fetched_at: string; data: ClaudeLimits } | undefined,
  oa: OauthEntry | undefined,
  now: Date,
  cause: LimitCause,
): ClaudeLimitState {
  const oaGood = oa?.fetched_at && oa.data ? { fetched_at: oa.fetched_at, data: oa.data } : undefined;
  const pick =
    sl && oaGood ? (Date.parse(sl.fetched_at) >= Date.parse(oaGood.fetched_at) ? sl : oaGood) : (sl ?? oaGood);
  if (!pick) return unavailable(cause);
  return fromData(pick.data, pick === sl ? "statusline" : "cache", pick.fetched_at, now, true, cause);
}

export async function readClaudeLimits(opts: ReadLimitsOptions): Promise<ClaudeLimitState> {
  if (opts.settings.disabled) return { status: "disabled", stale: false, scoped: [] };
  const now = opts.now ?? new Date();
  const path = opts.cachePath ?? usageCachePath();
  const file = readUsageCache(path);
  const sl = file.claude.statusline;
  const oa = file.claude.oauth;
  const ttlMs = (opts.force ? FORCED_REUSE_S : (opts.ttlS ?? EXPLICIT_TTL_S)) * 1000;
  const young = (at: string | undefined) => at !== undefined && now.getTime() - Date.parse(at) < ttlMs;

  if (!opts.settings.oauth) {
    if (!sl) return unavailable("no_data");
    return fromData(sl.data, "statusline", sl.fetched_at, now, !young(sl.fetched_at));
  }

  // A fresh statusline reading costs no request.
  if (sl && young(sl.fetched_at)) return fromData(sl.data, "statusline", sl.fetched_at, now, false);
  if (oa?.data && oa.fetched_at && young(oa.fetched_at)) {
    const cause = oa.error_kind ? KIND_CAUSE[oa.error_kind as UsageErrorKind] : undefined;
    return fromData(oa.data, "cache", oa.fetched_at, now, cause !== undefined, cause);
  }
  if (oa?.retry_at && Date.parse(oa.retry_at) > now.getTime()) return lastGood(sl, oa, now, "rate_limited");

  const token = await readClaudeToken({ ...opts.credentials, env: opts.env ?? {}, now });
  if (!token.ok) return lastGood(sl, oa, now, token.cause);
  const fetchFn = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const res = await fetchClaudeUsage(token.token, { fetch: fetchFn, userAgent: userAgent(), timeoutMs: opts.timeoutMs });
  if (res.ok) {
    file.claude.oauth = { fetched_at: now.toISOString(), data: res.limits };
    tryWriteCache(file, path);
    return fromData(res.limits, "api", now.toISOString(), now, false);
  }
  const next: OauthEntry = { ...oa, error_kind: res.kind };
  delete next.retry_at;
  if (res.kind === "http-429") {
    const waitS = Math.min(Math.max(res.retryAfterS ?? 0, RATE_LIMIT_BACKOFF_S), RATE_LIMIT_MAX_S);
    next.retry_at = new Date(now.getTime() + waitS * 1000).toISOString();
  }
  file.claude.oauth = next;
  tryWriteCache(file, path);
  return lastGood(sl, next, now, KIND_CAUSE[res.kind]);
}
