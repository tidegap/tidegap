/**
 * Pushover driver (U10): the form POST through the shared HTTP transport.
 * `TIDEGAP_PUSHOVER_API_BASE` may point it at a loopback test server only
 * (KTD8); any other value is ignored with one log line per process. A 4xx
 * whose JSON says `user` or `token` is invalid becomes `pushover_user` or
 * `pushover_token`, so the card names the field.
 */

import { PUSHOVER_MESSAGES_PATH, type DeliveryCode } from "@tidegap/core";

import { readChannelDriverEnv } from "../../env.js";
import { sendHttp } from "../http.js";
import { expectSpec, type ChannelDriver } from "./types.js";

/** The code of a refused answer from Pushover's JSON `{status: 0, user: "invalid"}`, else undefined. */
export function pushoverError(status: number, body: string): DeliveryCode | undefined {
  if (status < 400 || status >= 500) return undefined;
  try {
    const json = JSON.parse(body) as { user?: unknown; token?: unknown };
    if (json.token === "invalid") return "pushover_token";
    if (json.user === "invalid") return "pushover_user";
  } catch {
    // not JSON
  }
  return undefined;
}

let warned = false;

export const pushover: ChannelDriver = {
  async send(spec, ctx) {
    const http = expectSpec(spec, "http");
    const env = ctx.env ?? readChannelDriverEnv();
    if (env.pushoverApiBaseRejected && !warned) {
      warned = true;
      (ctx.log ?? ((l) => process.stderr.write(`${l}\n`)))("tidegap: TIDEGAP_PUSHOVER_API_BASE is not a loopback http URL; using the public Pushover API");
    }
    const url = env.pushoverApiBase ? new URL(PUSHOVER_MESSAGES_PATH, env.pushoverApiBase).href : http.url;
    await sendHttp({ ...http, url }, { ...ctx.http, mapError: pushoverError });
  },
};
