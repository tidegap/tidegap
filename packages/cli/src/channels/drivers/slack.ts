/**
 * Slack driver: a POST of the descriptor's spec through the shared HTTP
 * transport (retries, URL policy, no redirects). Slack names a refusal in
 * its plain-text body (`invalid_payload`, `channel_not_found`, `no_service`,
 * `action_prohibited`…); that word picks the code, the status only when the
 * body names nothing known.
 */

import type { DeliveryCode } from "@tidegap/core";

import { sendHttp } from "../http.js";
import { expectSpec, type ChannelDriver } from "./types.js";

const SLACK_ERRORS: Readonly<Record<string, DeliveryCode>> = {
  invalid_payload: "slack_payload",
  no_text: "slack_payload",
  too_many_attachments: "slack_payload",
  channel_not_found: "slack_channel_not_found",
  channel_is_archived: "slack_channel_archived",
  action_prohibited: "slack_action_prohibited",
  posting_to_general_channel_denied: "slack_action_prohibited",
  no_service: "slack_webhook_gone",
  no_service_id: "slack_webhook_gone",
  no_team: "slack_webhook_gone",
  team_disabled: "slack_webhook_gone",
  invalid_token: "slack_webhook_gone",
  no_active_hooks: "slack_webhook_gone",
};

/** The code of a refused answer from Slack's error word, else undefined (the status decides). */
export function slackError(status: number, body: string): DeliveryCode | undefined {
  if (status < 400 || status >= 500) return undefined;
  const word = body.trim();
  return Object.hasOwn(SLACK_ERRORS, word) ? SLACK_ERRORS[word] : undefined;
}

export const slack: ChannelDriver = {
  async send(spec, ctx) {
    await sendHttp(expectSpec(spec, "http"), { ...ctx.http, mapError: slackError });
  },
};
