/** Telegram (coherence KTD10 to KTD15). Sends through `TelegramClient`, not a `format` (KTD3); the bot token stays in the env file (Q2). */

import type { KindDescriptor } from "../registry.js";

export const telegram: KindDescriptor = {
  kind: "telegram",
  label: "Telegram",
  description: "Messages from your own bot, with buttons to run, postpone or cancel tasks.",
  ready: true,
  fields: [
    {
      name: "bot_token",
      label: "Bot token",
      input: "password",
      required: true,
      secret: true,
      pattern: "\\d{5,12}:[A-Za-z0-9_-]{30,50}",
      placeholder: "123456789:AA…",
    },
  ],
  steps: [
    { text: "Open @BotFather in Telegram.", link: "https://t.me/BotFather" },
    { text: "Send /newbot and pick a name. Use a new bot for Tidegap only." },
    { text: "Copy the token it sends and paste it here." },
  ],
  defaultEvents: ["task_done", "task_failed", "clean_window", "not_ready"],
  docsAnchor: "notify-telegram",
};
