/** The driver contract (integrations plan KTD3): a driver performs one `DeliverySpec`. */

import type { DeliverySpec } from "@tidegap/core";

import { DeliveryError, sendHttp, type HttpSendOptions } from "../http.js";

export interface DriverContext {
  /** Options of the HTTP transport: the URL policy's UI ports, test overrides. */
  http: HttpSendOptions;
}

/** Sends one spec; rejects with a `DeliveryError` (a code, never a secret). */
export interface ChannelDriver {
  send(spec: DeliverySpec, ctx: DriverContext): Promise<void>;
}

/** The driver of a kind whose stream has not landed: every send fails `not_ready`. */
export const notReadyDriver: ChannelDriver = {
  send: async () => {
    throw new DeliveryError("not_ready");
  },
};

/** Narrow a spec to the transport a driver expects. */
export function expectSpec<T extends DeliverySpec["type"]>(spec: DeliverySpec, type: T): Extract<DeliverySpec, { type: T }> {
  if (spec.type !== type) throw new DeliveryError("invalid_spec");
  return spec as Extract<DeliverySpec, { type: T }>;
}

/** The driver of a kind whose spec is one plain HTTP request (Slack, Discord, ntfy). */
export const httpDriver: ChannelDriver = {
  async send(spec, ctx) {
    await sendHttp(expectSpec(spec, "http"), ctx.http);
  },
};
