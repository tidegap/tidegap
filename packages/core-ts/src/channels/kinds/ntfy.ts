/**
 * ntfy (R12, R20): phone push through the public `https://ntfy.sh` or the
 * user's own server. The message is a POST to `<server>/<topic>` with the
 * text as the body and `Title`, `Priority` and `Tags` headers. A title with
 * characters outside printable ASCII goes as an RFC 2047 encoded word, which
 * ntfy decodes. The optional access token is a Bearer header; it belongs to
 * its server (`keepWith`), so a new server never gets the old token.
 */

import type { DeliverySpec, FieldValues, KindDescriptor } from "../registry.js";
import type { NotificationLevel, NotificationPayload, PayloadEvent } from "../payload.js";
import { optString } from "./shared.js";

export const NTFY_DEFAULT_SERVER = "https://ntfy.sh";

/** ntfy turns a longer body into an attachment; stay under its 4,096-byte message limit. */
export const NTFY_MAX_BODY_BYTES = 4000;

/** Priority per event when the field is `auto`: failures high, summaries low. */
const PRIORITY: Record<PayloadEvent, number> = { task_failed: 4, not_ready: 4, task_done: 3, test: 3, clean_window: 2, digest: 2 };

/** ntfy emoji tags per level (`x` shows ❌). */
const TAGS: Record<NotificationLevel, string> = { success: "white_check_mark", error: "x", warning: "warning", info: "information_source" };

/** The header value of `text`: as is when printable ASCII, else an RFC 2047 base64 encoded word. */
export function headerText(text: string): string {
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  return `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`;
}

const ELLIPSIS_BYTES = Buffer.byteLength("…", "utf8");

/** At most `max` UTF-8 bytes, cut on a character boundary, with an ellipsis when cut. */
export function clipBytes(text: string, max: number): string {
  if (Buffer.byteLength(text, "utf8") <= max) return text;
  let out = "";
  let size = ELLIPSIS_BYTES;
  for (const ch of text) {
    size += Buffer.byteLength(ch, "utf8");
    if (size > max) break;
    out += ch;
  }
  return `${out}…`;
}

/** The publish URL: the server (any path prefix kept) plus the topic. */
export function ntfyUrl(server: string, topic: string): string {
  return `${server.replace(/\/+$/, "")}/${topic}`;
}

export function ntfyPriority(payload: NotificationPayload, override: string | number | undefined): number {
  const n = Number(override);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : PRIORITY[payload.event];
}

export const ntfy: KindDescriptor = {
  kind: "ntfy",
  label: "ntfy",
  description: "Push notifications to your phone through ntfy, on ntfy.sh or your own server.",
  ready: true,
  fields: [
    {
      name: "server",
      label: "Server",
      input: "url",
      required: true,
      default: NTFY_DEFAULT_SERVER,
      help: "Keep https://ntfy.sh, or type the address of your own ntfy server.",
    },
    {
      name: "topic",
      label: "Topic",
      input: "text",
      required: true,
      secret: true,
      pattern: "[-_A-Za-z0-9]{1,64}",
      invalid: "Use 1 to 64 letters, digits, - or _ for the topic.",
      help: "Anyone who knows the topic can read it on a public server. Keep the random name.",
    },
    {
      name: "token",
      label: "Access token",
      input: "password",
      secret: true,
      keepWith: "server",
      pattern: "[!-~]+",
      invalid: "Paste the access token as ntfy shows it, with no spaces.",
      placeholder: "tk_…",
      help: "Only for a server or topic that needs login. Leave empty for ntfy.sh.",
    },
    {
      name: "priority",
      label: "Priority",
      input: "select",
      default: "auto",
      advanced: true,
      options: [
        { value: "auto", label: "Automatic (failures high, summaries low)" },
        { value: "5", label: "5: urgent" },
        { value: "4", label: "4: high" },
        { value: "3", label: "3: default" },
        { value: "2", label: "2: low" },
        { value: "1", label: "1: min" },
      ],
    },
  ],
  steps: [
    { text: "Install the ntfy app (App Store or Google Play), or open the ntfy web app.", link: "https://ntfy.sh/app" },
    { text: "In the app, subscribe to the topic shown here. Copy it with the Copy button." },
    { text: "Press Connect. A test notification arrives on your phone." },
    { text: "Own server: change the server address, and add an access token if it needs login.", link: "https://docs.ntfy.sh/config/#access-tokens" },
  ],
  defaultEvents: ["task_done", "task_failed", "not_ready"],
  docsAnchor: "notify-ntfy",
  target(values, hints) {
    let host = String(values.server ?? NTFY_DEFAULT_SERVER);
    try {
      host = new URL(host).host;
    } catch {
      // keep the raw value
    }
    return hints.topic ? `${host} topic ${hints.topic}` : host;
  },
  errors: {
    auth: { text: "ntfy refused the access token. Create a new one in your ntfy account.", field: "token" },
    http_404: { text: "This address is not an ntfy server. Check the server address.", field: "server" },
    http_400: { text: "The ntfy server refused the topic or the message. Check the topic.", field: "topic" },
    rate_limited: { text: "The ntfy server limits messages. Wait a few minutes, or use an account token or your own server." },
    http_507: { text: "The ntfy server is out of space for this topic. Try again tomorrow, or use your own server." },
  },
  format(payload: NotificationPayload, values: FieldValues): DeliverySpec {
    const token = optString(values.token);
    return {
      type: "http",
      method: "POST",
      url: ntfyUrl(String(values.server ?? NTFY_DEFAULT_SERVER), String(values.topic)),
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        Title: headerText(payload.title),
        Priority: String(ntfyPriority(payload, values.priority)),
        Tags: TAGS[payload.level],
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: clipBytes(payload.text, NTFY_MAX_BODY_BYTES),
    };
  },
};
