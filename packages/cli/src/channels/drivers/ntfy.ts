/**
 * ntfy driver: a POST of the descriptor's spec through the shared HTTP
 * transport (retries, URL policy, no redirects). A 401 or 403 without a
 * token means the topic needs one (`ntfy_token_needed`); with a token, the
 * token was refused (`auth`).
 */

import { sendHttp, statusCode } from "../http.js";
import { expectSpec, type ChannelDriver } from "./types.js";

export const ntfy: ChannelDriver = {
  async send(spec, ctx) {
    const http = expectSpec(spec, "http");
    const tokenSent = Object.hasOwn(http.headers, "Authorization");
    await sendHttp(http, { ...ctx.http, mapError: (status) => (!tokenSent && statusCode(status) === "auth" ? "ntfy_token_needed" : undefined) });
  },
};
