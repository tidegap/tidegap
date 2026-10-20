/**
 * Discord (R12): a channel webhook. One embed per message, colored by level;
 * markdown specials escaped and `allowed_mentions` empty, so a task title can
 * neither link nor ping (KTD2). Sent with `?wait=true`, so Discord answers
 * only after it accepted the message.
 */

import type { DeliverySpec, FieldValues, KindDescriptor } from "../registry.js";
import type { NotificationPayload } from "../payload.js";
import { clipEscaped, escapeChars, LEVEL_COLOR, LOOPBACK_URL } from "./shared.js";

/** Discord's caps on an embed's title and description. */
export const DISCORD_TITLE_MAX = 256;
export const DISCORD_DESCRIPTION_MAX = 4096;

/** Discord markdown: emphasis, code, spoilers, quotes, headings, masked links and `<@…>` mentions. */
const SPECIALS = "\\*_~`|>[]()#<";

export function discordBody(payload: NotificationPayload): string {
  return JSON.stringify({
    username: "Tidegap",
    embeds: [
      {
        title: clipEscaped(escapeChars(payload.title, SPECIALS), DISCORD_TITLE_MAX),
        description: clipEscaped(escapeChars(payload.text, SPECIALS), DISCORD_DESCRIPTION_MAX),
        color: LEVEL_COLOR[payload.level],
        timestamp: payload.at,
      },
    ],
    allowed_mentions: { parse: [] },
  });
}

/** The webhook URL with `wait=true`, other query parameters (`thread_id`) kept. */
export function discordUrl(raw: string): string {
  const url = new URL(raw);
  url.searchParams.set("wait", "true");
  return url.toString();
}

const DISCORD_URL_TEXT = "Discord does not know this webhook. Copy the URL again from Server Settings → Integrations → Webhooks.";

export const discord: KindDescriptor = {
  kind: "discord",
  label: "Discord",
  description: "Messages in a Discord channel through a webhook.",
  ready: true,
  fields: [
    {
      name: "url",
      label: "Webhook URL",
      input: "url",
      required: true,
      secret: true,
      placeholder: "https://discord.com/api/webhooks/…/…",
      pattern: String.raw`https://(?:(?:canary|ptb)\.)?discord(?:app)?\.com/api(?:/v\d+)?/webhooks/\d+/[A-Za-z0-9_-]+(?:\?\S*)?|${LOOPBACK_URL}`,
      invalid: "Paste the Discord webhook URL. It starts with https://discord.com/api/webhooks/.",
    },
  ],
  steps: [
    { text: "In Discord, open Server Settings → Integrations." },
    { text: "Open Webhooks → New Webhook, then pick the channel for Tidegap messages." },
    { text: "Press Copy Webhook URL, paste it here and press Connect." },
  ],
  defaultEvents: ["task_done", "task_failed", "not_ready"],
  docsAnchor: "notify-discord",
  errors: {
    auth: { text: DISCORD_URL_TEXT, field: "url" },
    http_404: { text: DISCORD_URL_TEXT, field: "url" },
    http_400: { text: "Discord refused the message format. Update Tidegap and try again." },
  },
  format(payload: NotificationPayload, values: FieldValues): DeliverySpec {
    return { type: "http", method: "POST", url: discordUrl(String(values.url)), headers: { "Content-Type": "application/json" }, body: discordBody(payload) };
  },
};
