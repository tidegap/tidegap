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

const SLACK_URL_TEXT = "Slack did not accept this URL. Create a new webhook in Slack and paste it again.";
const SLACK_GONE_TEXT = "Slack removed this webhook. Add a new one in your Slack app and paste it here.";
const SLACK_ARCHIVED_TEXT = "The Slack channel of this webhook is archived. Add a webhook for another channel and paste it here.";
const SLACK_FORMAT_TEXT = "Slack refused the message format. Update Tidegap and try again.";

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
    auth: { text: SLACK_URL_TEXT, field: "url" },
    http_404: { text: SLACK_GONE_TEXT, field: "url" },
    http_410: { text: SLACK_ARCHIVED_TEXT, field: "url" },
    http_400: { text: SLACK_FORMAT_TEXT },
    slack_payload: { text: SLACK_FORMAT_TEXT },
    slack_webhook_gone: { text: SLACK_GONE_TEXT, field: "url" },
    slack_channel_not_found: { text: "The Slack channel of this webhook no longer exists. Add a webhook for another channel and paste it here.", field: "url" },
    slack_channel_archived: { text: SLACK_ARCHIVED_TEXT, field: "url" },
    slack_action_prohibited: { text: "A Slack admin restricted posting to this channel. Ask the admin, or add a webhook for another channel.", field: "url" },
  },
  format(payload: NotificationPayload, values: FieldValues): DeliverySpec {
    return { type: "http", method: "POST", url: String(values.url), headers: { "Content-Type": "application/json" }, body: slackBody(payload) };
  },
};
