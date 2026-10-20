/**
 * Pushover (R12, R20): phone push through the user's own Pushover
 * application token. The message is a form-encoded POST to the fixed
 * `https://api.pushover.net/1/messages.json`; the host may point it at a
 * loopback test server (`TIDEGAP_PUSHOVER_API_BASE`, KTD8), never anywhere
 * else. Pushover shows plain text, so nothing is escaped.
 */

import type { DeliverySpec, FieldValues, KindDescriptor } from "../registry.js";
import type { NotificationPayload, PayloadEvent } from "../payload.js";

export const PUSHOVER_API_BASE = "https://api.pushover.net";
export const PUSHOVER_MESSAGES_PATH = "/1/messages.json";

/** Pushover's limits: message 1,024 characters, title 250. */
export const PUSHOVER_MAX_MESSAGE = 1024;
export const PUSHOVER_MAX_TITLE = 250;

/** Priority per event: summaries and clean windows quiet (-1), the rest normal (0). */
const PRIORITY: Record<PayloadEvent, number> = { task_failed: 0, not_ready: 0, task_done: 0, test: 0, clean_window: -1, digest: -1 };

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Pushover user keys and application tokens: 30 letters and digits. */
const KEY = "[A-Za-z0-9]{30}";

export const pushover: KindDescriptor = {
  kind: "pushover",
  label: "Pushover",
  description: "Push notifications to your phone through your own Pushover account.",
  ready: true,
  fields: [
    {
      name: "user_key",
      label: "User key",
      input: "password",
      required: true,
      secret: true,
      pattern: KEY,
      invalid: "Paste the 30-character user key from the top of your Pushover dashboard.",
    },
    {
      name: "app_token",
      label: "API token",
      input: "password",
      required: true,
      secret: true,
      pattern: KEY,
      invalid: "Paste the 30-character API token of the application you created for Tidegap.",
    },
  ],
  steps: [
    { text: "Log in at pushover.net and copy Your User Key from the dashboard.", link: "https://pushover.net/" },
    { text: "Create an Application/API Token. Name it Tidegap.", link: "https://pushover.net/apps/build" },
    { text: "Copy the API token of that application." },
    { text: "Paste both here and press Connect. Pushover is a one-time purchase per platform after a 30-day trial." },
  ],
  defaultEvents: ["task_done", "task_failed", "not_ready"],
  docsAnchor: "notify-pushover",
  target: (_values, hints) => (hints.user_key ? `user ${hints.user_key}` : "Pushover"),
  errors: {
    pushover_user: { text: "Pushover does not know this user key. Copy it again from your Pushover dashboard.", field: "user_key" },
    pushover_token: { text: "Pushover refused the API token. Copy it again from the application page, or create a new one.", field: "app_token" },
    http_400: { text: "Pushover refused the message. Check the user key and the API token." },
    rate_limited: { text: "Your Pushover application reached its monthly message limit. Wait for the next month, or upgrade it in Pushover." },
  },
  format(payload: NotificationPayload, values: FieldValues): DeliverySpec {
    const at = Math.floor(Date.parse(payload.at) / 1000);
    const body = new URLSearchParams({
      token: String(values.app_token),
      user: String(values.user_key),
      title: clip(payload.title, PUSHOVER_MAX_TITLE),
      message: clip(payload.text, PUSHOVER_MAX_MESSAGE),
      priority: String(PRIORITY[payload.event]),
      ...(Number.isFinite(at) ? { timestamp: String(at) } : {}),
    });
    return {
      type: "http",
      method: "POST",
      url: `${PUSHOVER_API_BASE}${PUSHOVER_MESSAGES_PATH}`,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    };
  },
};
