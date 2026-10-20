/** Slack (R12): an Incoming Webhook of a Slack app. `text` plus one mrkdwn section block; `&<>` escaped (KTD2). */

import type { DeliverySpec, FieldValues, KindDescriptor } from "../registry.js";
import type { NotificationPayload } from "../payload.js";
import { clipEscaped, escapeAngle, LOOPBACK_URL } from "./shared.js";

/** Slack's cap on a section block's text. */
export const SLACK_SECTION_MAX = 3000;

export function slackBody(payload: NotificationPayload): string {
  const title = escapeAngle(payload.title);
  const text = escapeAngle(payload.text);
  return JSON.stringify({
    text,
    blocks: [{ type: "section", text: { type: "mrkdwn", text: clipEscaped(`*${title}*\n${text}`, SLACK_SECTION_MAX) } }],
  });
}

const URL_TEXT = "Slack did not accept this URL. Create a new webhook in Slack and paste it again.";

export const slack: KindDescriptor = {
  kind: "slack",
  label: "Slack",
  description: "Messages in a Slack channel through an Incoming Webhook.",
  ready: true,
  fields: [
    {
      name: "url",
      label: "Webhook URL",
      input: "url",
      required: true,
      secret: true,
      placeholder: "https://hooks.slack.com/services/T…/B…/…",
      pattern: String.raw`https://hooks\.slack\.com/services/[A-Za-z0-9_/-]+|${LOOPBACK_URL}`,
      invalid: "Paste the Incoming Webhook URL. It starts with https://hooks.slack.com/services/.",
    },
  ],
  steps: [
    { text: "Open your Slack apps and create one: Create New App → From scratch.", link: "https://api.slack.com/apps" },
    { text: "Open Incoming Webhooks and turn them on." },
    { text: "Add New Webhook, then pick the channel for Tidegap messages." },
    { text: "Copy the webhook URL, paste it here and press Connect." },
  ],
  defaultEvents: ["task_done", "task_failed", "not_ready"],
  docsAnchor: "notify-slack",
  errors: {
    auth: { text: URL_TEXT, field: "url" },
    http_404: { text: "Slack removed this webhook. Add a new one in your Slack app and paste it here.", field: "url" },
    http_410: { text: "The Slack channel of this webhook is archived. Add a webhook for another channel and paste it here.", field: "url" },
    http_400: { text: "Slack refused the message format. Update Tidegap and try again." },
  },
  format(payload: NotificationPayload, values: FieldValues): DeliverySpec {
    return { type: "http", method: "POST", url: String(values.url), headers: { "Content-Type": "application/json" }, body: slackBody(payload) };
  },
};
