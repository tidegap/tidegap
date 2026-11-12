/**
 * `GET|POST /api/settings/region` (region plan U3, KTD7): the grid region
 * card's routes, over the same module as `tidegap region`. The server lets
 * only the page token and a `macos` client token through, never an
 * extension origin. A POST stores a catalog zone (any case, or an alias) or
 * clears the setting with `"auto"`, at most 30 times a minute per server.
 *
 * `GET|POST /api/settings/limits` (limits plan U11, KTD12): the run-limit
 * settings card, over the same module as `tidegap limits`, in the same
 * route class. A POST stores or clears one setting for all runners or one
 * runner, at most 30 times a minute per server, apart from region writes.
 *
 * With `guard` set (the page server), a config file in or linked into a
 * folder macOS guards answers 409 `guarded_folder` before any read or write.
 */

import { carbonBudgetConfigPath } from "@tidegap/core";

import { limitsJson, LimitSettingError, storeLimitJson } from "../limits.js";
import { guardedFolderResponse, guardedLinkError } from "../providers/macos-privacy.js";
import { regionCatalog, regionView, storeRegion, UnknownRegionError, type RegionViewInputs } from "../region.js";
import type { ApiResponse } from "./api.js";
import { rateLimited, SlidingWindowLimiter } from "./rate-limit.js";

/** Most region writes per minute, per server. */
export const REGION_WRITES_PER_MINUTE = 30;
/** Most run-limit writes per minute, per server. */
export const LIMITS_WRITES_PER_MINUTE = 30;
const WINDOW_MS = 60_000;

/** One limiter per server, keyed by the server's (shared) region inputs object. */
const writes = new WeakMap<RegionViewInputs, SlidingWindowLimiter>();

function body(inputs: RegionViewInputs): unknown {
  return { ...regionView(inputs), catalog: regionCatalog(inputs.credentials) };
}

function invalid(error: string): ApiResponse {
  return { status: 400, body: { error, code: "invalid" } };
}

/** Seconds to wait when over the write limit of `route`, else undefined (and the write is counted). */
function limited(inputs: RegionViewInputs, route: "region" | "limits", now: number): number | undefined {
  let limiter = writes.get(inputs);
  // Both routes allow 30 a minute; each counts on its own key.
  if (!limiter) writes.set(inputs, (limiter = new SlidingWindowLimiter(REGION_WRITES_PER_MINUTE, WINDOW_MS)));
  return limiter.check(route, now);
}

const SAVE_FAILED: ApiResponse = { status: 500, body: { error: "Tidegap could not save the change. Try again.", code: "internal" } };

function limits(inputs: RegionViewInputs, method: string, payload: Record<string, unknown>, now: number): ApiResponse {
  if (method === "GET") return { status: 200, body: limitsJson(inputs.configPath) };
  if (method !== "POST") return { status: 405, body: { error: "method not allowed" } };
  const wait = limited(inputs, "limits", now);
  if (wait !== undefined) return rateLimited(wait);
  try {
    storeLimitJson(payload, inputs.configPath);
  } catch (err) {
    if (err instanceof LimitSettingError) return invalid(err.message);
    return SAVE_FAILED;
  }
  return { status: 200, body: limitsJson(inputs.configPath) };
}

/** Route `/api/settings/<route…>`; `inputs` absent = no settings routes. */
export function handleSettings(
  inputs: RegionViewInputs | undefined,
  method: string,
  route: readonly string[],
  payload: Record<string, unknown>,
  now: number = Date.now(),
): ApiResponse {
  if (!inputs || route.length !== 1 || (route[0] !== "region" && route[0] !== "limits")) return { status: 404, body: { error: "not found" } };
  const refused = inputs.guard && guardedLinkError([inputs.configPath ?? carbonBudgetConfigPath()], inputs.guard);
  if (refused) return guardedFolderResponse(refused);
  if (route[0] === "limits") return limits(inputs, method, payload, now);
  if (method === "GET") return { status: 200, body: body(inputs) };
  if (method !== "POST") return { status: 405, body: { error: "method not allowed" } };
  if (Object.keys(payload).some((k) => k !== "zone")) return invalid('the body must be {"zone": "<zone>" | "auto"}');
  const zone = payload.zone;
  if (typeof zone !== "string" || zone.trim() === "" || zone.length > 64) {
    return invalid('the body must be {"zone": "<zone>" | "auto"}');
  }
  const wait = limited(inputs, "region", now);
  if (wait !== undefined) return rateLimited(wait);
  try {
    storeRegion(zone, inputs.configPath);
  } catch (err) {
    if (err instanceof UnknownRegionError) return { status: 400, body: { error: err.message, code: err.code } };
    // A file error can name a path; the page needs only the fact.
    return SAVE_FAILED;
  }
  return { status: 200, body: body(inputs) };
}
