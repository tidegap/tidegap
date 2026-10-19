/** Generic webhook (R11, R13): the reference kind. A POST of the Tidegap JSON body (KTD2) to the user's URL. */

import type { DeliverySpec, FieldValues, KindDescriptor } from "../registry.js";
import type { NotificationPayload } from "../payload.js";

/** Bumped only when the Tidegap JSON body changes shape, so receivers can pin it. */
export const WEBHOOK_BODY_VERSION = 1;

/** The `tidegap` format body: the payload, raw, plus `version`. */
export function webhookBody(payload: NotificationPayload): string {
  const { event, level, title, text, at, task } = payload;
  return JSON.stringify({ version: WEBHOOK_BODY_VERSION, event, level, title, text, at, ...(task ? { task } : {}) });
}

export const webhook: KindDescriptor = {
  kind: "webhook",
  label: "Webhook",
  description: "A JSON POST to any URL you own: your server, n8n, Home Assistant.",
  ready: true,
  fields: [{ name: "url", label: "Webhook URL", input: "url", required: true, secret: true, placeholder: "https://example.com/hooks/tidegap" }],
  steps: [
    { text: "Create an incoming webhook in the receiving app and copy its URL." },
    { text: "Paste the URL here and press Connect. Tidegap sends a test message." },
  ],
  defaultEvents: ["task_done", "task_failed", "clean_window", "not_ready"],
  docsAnchor: "notify-webhook",
  worksWith: "Microsoft Teams (Workflows), Google Chat, Mattermost and Matrix (hookshot).",
  format(payload: NotificationPayload, values: FieldValues): DeliverySpec {
    return { type: "http", method: "POST", url: String(values.url), headers: { "Content-Type": "application/json" }, body: webhookBody(payload) };
  },
};
