/** The driver contract (integrations plan KTD3): a driver performs one `DeliverySpec`. */

import type { DeliverySpec } from "@tidegap/core";

import type { ChannelDriverEnv } from "../../env.js";
import { DeliveryError, sendHttp, type HttpSendOptions } from "../http.js";
import type { SmtpOptions } from "../smtp.js";

export interface DriverContext {
  /** Options of the HTTP transport: the URL policy's UI ports, test overrides. */
  http: HttpSendOptions;
  /** Tests: the host settings; default {@link readChannelDriverEnv} at each send. */
  env?: ChannelDriverEnv;
  /** Tests: SMTP timeouts and a test CA. Never from config. */
  smtp?: Partial<Omit<SmtpOptions, "uiPorts">>;
  /** Tests: the time limit of a Shortcuts or Command child (default 20 s). */
  execTimeoutMs?: number;
  /** One line about the host settings (an ignored override); default stderr. */
  log?: (line: string) => void;
}

/** Sends one spec; rejects with a `DeliveryError` (a code, never a secret). */
export interface ChannelDriver {
  send(spec: DeliverySpec, ctx: DriverContext): Promise<void>;
}

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
