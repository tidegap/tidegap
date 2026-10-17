/**
 * `~/.tidegap/usage.json`: measurements and fetch state only, never a token
 * (KTD4). Mode 0600, written atomically (temp file plus rename). Every host
 * process reads it first; the statusline hook and the OAuth client write it.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveTidegapHome } from "@tidegap/core";

import type { ClaudeLimits, LimitWindow, ScopedWindow } from "./types.js";

export interface StatuslineEntry {
  fetched_at: string;
  data: ClaudeLimits;
}

export interface OauthEntry {
  /** Time of the last good read (absent before the first one). */
  fetched_at?: string;
  data?: ClaudeLimits;
  /** Kind of the last failed read, cleared by a good one. */
  error_kind?: string;
  /** No request before this instant (after a 429). */
  retry_at?: string;
}

export interface UsageCacheFile {
  version: 1;
  claude: { statusline?: StatuslineEntry; oauth?: OauthEntry };
}

export function usageCachePath(home: string = resolveTidegapHome()): string {
  return join(home, "usage.json");
}

function isoOrUndefined(v: unknown): string | undefined {
  return typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : undefined;
}

function limitWindow(v: unknown): LimitWindow | undefined {
  if (!v || typeof v !== "object") return undefined;
  const w = v as { pct?: unknown; resets_at?: unknown };
  const at = isoOrUndefined(w.resets_at);
  return typeof w.pct === "number" && Number.isFinite(w.pct) && at ? { pct: w.pct, resets_at: at } : undefined;
}

/** Keep only well-formed windows; anything else in the file is dropped. */
export function sanitizeLimits(v: unknown): ClaudeLimits | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as { five_hour?: unknown; seven_day?: unknown; scoped?: unknown };
  const scoped: ScopedWindow[] = [];
  if (Array.isArray(o.scoped)) {
    for (const s of o.scoped) {
      const w = limitWindow(s);
      const model = (s as { model?: unknown }).model;
      if (w && typeof model === "string" && model) scoped.push({ ...w, model });
    }
  }
  const out: ClaudeLimits = { scoped };
  const five = limitWindow(o.five_hour);
  const seven = limitWindow(o.seven_day);
  if (five) out.five_hour = five;
  if (seven) out.seven_day = seven;
  return out.five_hour || out.seven_day || scoped.length > 0 ? out : undefined;
}

/** The cache file, or an empty one when it is missing or unreadable. */
export function readUsageCache(path: string = usageCachePath()): UsageCacheFile {
  const empty: UsageCacheFile = { version: 1, claude: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return empty;
  }
  const claude = (raw as { claude?: Record<string, unknown> } | null)?.claude;
  if (!claude || typeof claude !== "object") return empty;
  const sl = claude.statusline as { fetched_at?: unknown; data?: unknown } | undefined;
  const slAt = isoOrUndefined(sl?.fetched_at);
  const slData = sanitizeLimits(sl?.data);
  if (slAt && slData) empty.claude.statusline = { fetched_at: slAt, data: slData };
  const oa = claude.oauth as Record<string, unknown> | undefined;
  if (oa && typeof oa === "object") {
    const entry: OauthEntry = {};
    const at = isoOrUndefined(oa.fetched_at);
    const data = sanitizeLimits(oa.data);
    if (at && data) {
      entry.fetched_at = at;
      entry.data = data;
    }
    if (typeof oa.error_kind === "string") entry.error_kind = oa.error_kind;
    const retry = isoOrUndefined(oa.retry_at);
    if (retry) entry.retry_at = retry;
    empty.claude.oauth = entry;
  }
  return empty;
}

/** Atomic write, mode 0600, directory 0700. */
export function writeUsageCache(file: UsageCacheFile, path: string = usageCachePath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** Read, change one source's entry, write. */
export function updateUsageCache(
  change: (file: UsageCacheFile) => void,
  path: string = usageCachePath(),
): UsageCacheFile {
  const file = readUsageCache(path);
  change(file);
  writeUsageCache(file, path);
  return file;
}
