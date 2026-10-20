/**
 * Generic webhook (R11, R13, KTD2, KTD13): a POST to any URL the user owns.
 * Three bodies: the Tidegap JSON (`tidegap`, raw text), a plain `{"text"}`
 * (Google Chat, Mattermost, Matrix hookshot) and a Microsoft Teams Adaptive
 * Card (`teams`, the Workflows "Post to a channel when a webhook request is
 * received" template). Optional HMAC signing and custom header lines.
 */

import type { DeliverySpec, FieldValues, KindDescriptor } from "../registry.js";
import type { NotificationPayload } from "../payload.js";
import { defuseMentions, escapeAngle, escapeChars } from "./shared.js";

/** Bumped only when the Tidegap JSON body changes shape, so receivers can pin it. */
export const WEBHOOK_BODY_VERSION = 1;

export type WebhookFormat = "tidegap" | "text" | "teams";

/** The `tidegap` format body: the payload, raw, plus `version`. */
export function webhookBody(payload: NotificationPayload): string {
  const { event, level, title, text, at, task } = payload;
  return JSON.stringify({ version: WEBHOOK_BODY_VERSION, event, level, title, text, at, ...(task ? { task } : {}) });
}

/** Most header lines (KTD13). */
export const MAX_HEADER_LINES = 10;

/** RFC 7230 token. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** Printable ASCII and tab: Node refuses other bytes in a header, and CR or LF would split it. */
const HEADER_VALUE = /^[\t\x20-\x7e]*$/;
const RESERVED_HEADER = /^(host|content-length|transfer-encoding|connection|x-tidegap-.*)$/i;

export const HEADERS_TEXT = `Write one "Name: value" per line, at most ${MAX_HEADER_LINES}. Host, Content-Length, Transfer-Encoding, Connection and X-Tidegap-* are set by Tidegap.`;

/** The `headers` field as a map, or undefined when a line breaks a KTD13 rule. Empty lines are skipped. */
export function parseHeaders(text: string): Record<string, string> | undefined {
  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length > MAX_HEADER_LINES) return undefined;
  const out: Record<string, string> = {};
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon <= 0) return undefined;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (!HEADER_NAME.test(name) || RESERVED_HEADER.test(name) || !HEADER_VALUE.test(value)) return undefined;
    out[name] = value;
  }
  return out;
}

/** Plain text for a receiver that reads `<…>` links and `@` group mentions. */
function plain(text: string): string {
  return defuseMentions(escapeAngle(text));
}

/** Teams TextBlock markdown: no live link, emphasis or group mention. */
function teamsText(text: string): string {
  return defuseMentions(escapeChars(text, "\\[]()*_"));
}

/** A Teams Workflows message with one Adaptive Card 1.4: the title in bold, then the text. */
export function teamsBody(payload: NotificationPayload): string {
  return JSON.stringify({
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body: [
            { type: "TextBlock", text: teamsText(payload.title), weight: "Bolder", size: "Medium", wrap: true },
            { type: "TextBlock", text: teamsText(payload.text), wrap: true },
          ],
        },
      },
    ],
  });
}

function bodyOf(format: WebhookFormat, payload: NotificationPayload): string {
  if (format === "text") return JSON.stringify({ text: plain(payload.text) });
  if (format === "teams") return teamsBody(payload);
  return webhookBody(payload);
}

export const webhook: KindDescriptor = {
  kind: "webhook",
  label: "Webhook",
  description: "A POST to any URL you own: your server, n8n, Home Assistant, Teams, Google Chat.",
  ready: true,
  fields: [
    { name: "url", label: "Webhook URL", input: "url", required: true, secret: true, placeholder: "https://example.com/hooks/tidegap" },
    {
      name: "format",
      label: "Body format",
      input: "select",
      default: "tidegap",
      options: [
        { value: "tidegap", label: "Tidegap JSON" },
        { value: "text", label: "Plain text {\"text\"}: Google Chat, Mattermost, Matrix hookshot" },
        { value: "teams", label: "Microsoft Teams card (Workflows)" },
      ],
      help: 'Tidegap JSON is {"version": 1, "event", "level", "title", "text", "at", "task"}. The Connect and Send test message has "event": "test".',
    },
    {
      name: "secret",
      label: "Signing secret",
      input: "password",
      secret: true,
      advanced: true,
      keepWith: "url",
      help: 'Optional. Adds X-Tidegap-Timestamp and X-Tidegap-Signature: sha256=HMAC-SHA256(secret, "<timestamp>.<body>").',
    },
    {
      name: "headers",
      label: "Extra headers",
      input: "textarea",
      secret: true,
      advanced: true,
      keepWith: "url",
      maxLines: MAX_HEADER_LINES,
      placeholder: "Authorization: Bearer …",
      help: "Optional. One \"Name: value\" per line, for example an Authorization header. Stored as a secret.",
    },
  ],
  steps: [
    { text: "Create an incoming webhook in the receiving app and copy its URL. Teams: in the channel, Workflows → \"Post to a channel when a webhook request is received\"." },
    { text: "Pick the body format: Tidegap JSON for your own code, n8n or Home Assistant; Plain text for Google Chat, Mattermost and Matrix; Teams card for Teams." },
    { text: "Optional: add a signing secret or headers such as Authorization." },
    { text: 'Press Connect. Tidegap sends a test message with "event": "test"; answer it with any 2xx status.' },
  ],
  defaultEvents: ["task_done", "task_failed", "clean_window", "not_ready"],
  docsAnchor: "notify-webhook",
  worksWith: "Microsoft Teams (Workflows), Google Chat, Mattermost and Matrix (hookshot).",
  errors: {
    http_413: { text: "The receiver refused the message as too large. Raise its body limit, or pick the Plain text format." },
    http_400: { text: "The receiver refused the message body (HTTP 400). Check that the body format matches the receiver.", field: "format" },
  },
  validate(values) {
    if (typeof values.headers === "string" && !parseHeaders(values.headers)) return { field: "headers", text: HEADERS_TEXT };
    return undefined;
  },
  format(payload: NotificationPayload, values: FieldValues): DeliverySpec {
    const format = (values.format ?? "tidegap") as WebhookFormat;
    const extra = typeof values.headers === "string" ? (parseHeaders(values.headers) ?? {}) : {};
    const secret = typeof values.secret === "string" && values.secret ? values.secret : undefined;
    return {
      type: "http",
      method: "POST",
      url: String(values.url),
      headers: { ...extra, "Content-Type": "application/json" },
      body: bodyOf(format, payload),
      ...(secret ? { sign: { secret } } : {}),
    };
  },
};
