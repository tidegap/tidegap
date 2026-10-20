/**
 * `GET|POST /api/settings/region` (region plan U3, KTD7): the grid region
 * card's routes, over the same module as `tidegap region`. The server lets
 * only the page token and a `macos` client token through, never an
 * extension origin. A POST stores a catalog zone (any case, or an alias) or
 * clears the setting with `"auto"`, at most 30 times a minute per server.
 */

import { regionCatalog, regionView, storeRegion, UnknownRegionError, type RegionViewInputs } from "../region.js";
import type { ApiResponse } from "./api.js";

/** Most region writes per minute, per server. */
export const REGION_WRITES_PER_MINUTE = 30;
const WINDOW_MS = 60_000;

/** Write times per server, keyed by the server's (shared) region inputs object. */
const writes = new WeakMap<RegionViewInputs, number[]>();

function body(inputs: RegionViewInputs): unknown {
  return { ...regionView(inputs), catalog: regionCatalog(inputs.credentials) };
}

function invalid(error: string): ApiResponse {
  return { status: 400, body: { error, code: "invalid" } };
}

/** Seconds to wait when over the write limit, else undefined (and the write is counted). */
function limited(inputs: RegionViewInputs, now: number): number | undefined {
  const recent = (writes.get(inputs) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= REGION_WRITES_PER_MINUTE) {
    writes.set(inputs, recent);
    return Math.max(1, Math.ceil((recent[0]! + WINDOW_MS - now) / 1000));
  }
  recent.push(now);
  writes.set(inputs, recent);
  return undefined;
}

/** Route `/api/settings/<route…>`; `inputs` absent = no settings routes. */
export function handleSettings(
  inputs: RegionViewInputs | undefined,
  method: string,
  route: readonly string[],
  payload: Record<string, unknown>,
  now: number = Date.now(),
): ApiResponse {
  if (!inputs || route.length !== 1 || route[0] !== "region") return { status: 404, body: { error: "not found" } };
  if (method === "GET") return { status: 200, body: body(inputs) };
  if (method !== "POST") return { status: 405, body: { error: "method not allowed" } };
  if (Object.keys(payload).some((k) => k !== "zone")) return invalid('the body must be {"zone": "<zone>" | "auto"}');
  const zone = payload.zone;
  if (typeof zone !== "string" || zone.trim() === "" || zone.length > 64) {
    return invalid('the body must be {"zone": "<zone>" | "auto"}');
  }
  const wait = limited(inputs, now);
  if (wait !== undefined) {
    return { status: 429, body: { error: `Wait ${wait} seconds and try again.`, code: "rate_limited", retry_after_s: wait } };
  }
  try {
    storeRegion(zone, inputs.configPath);
  } catch (err) {
    if (err instanceof UnknownRegionError) return { status: 400, body: { error: err.message, code: err.code } };
    // A file error can name a path; the page needs only the fact.
    return { status: 500, body: { error: "Tidegap could not save the change. Try again.", code: "internal" } };
  }
  return { status: 200, body: body(inputs) };
}
