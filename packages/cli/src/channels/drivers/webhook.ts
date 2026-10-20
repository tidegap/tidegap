/**
 * Generic webhook driver (R11, KTD13): a POST through the shared HTTP
 * transport. With a signing secret it adds `X-Tidegap-Timestamp: <unix s>`
 * and `X-Tidegap-Signature: sha256=<hex HMAC-SHA256(secret, "<ts>.<body>")>`;
 * every retry of the job carries the same pair, inside the 5-minute replay
 * window the docs give receivers.
 */

import { createHmac } from "node:crypto";

import { sendHttp, type HttpSpec } from "../http.js";
import { expectSpec, type ChannelDriver } from "./types.js";

/** The signature headers of `body` at `nowS` (unix seconds). */
export function signatureHeaders(secret: string, body: string, nowS: number = Math.floor(Date.now() / 1000)): Record<string, string> {
  const ts = String(nowS);
  const mac = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
  return { "X-Tidegap-Timestamp": ts, "X-Tidegap-Signature": `sha256=${mac}` };
}

/** The spec as sent: the signing secret becomes headers and leaves the spec. */
export function signedSpec(spec: HttpSpec, nowS?: number): HttpSpec {
  const { sign, ...rest } = spec;
  return sign ? { ...rest, headers: { ...rest.headers, ...signatureHeaders(sign.secret, rest.body, nowS) } } : rest;
}

export const webhook: ChannelDriver = {
  async send(spec, ctx) {
    await sendHttp(signedSpec(expectSpec(spec, "http")), ctx.http);
  },
};
