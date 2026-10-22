/**
 * Channel types (coherence KTD10). A channel is a place a host sends task
 * events to: the OS toast (`os`), a paired Telegram chat (`telegram`) or
 * one of the registry kinds in `kinds/` (webhook, Slack, email…). Core
 * holds the types, the kind descriptors and pure planning; the host owns
 * every side effect (spawning the toast, calling the Bot API, sending HTTP).
 */

import type { ReadinessProblem } from "../readiness.js";
import type { TaskRecord } from "../types.js";

/** Every kind a channel row can have: `os` plus the registry kinds (`kinds/index.ts` lists one descriptor per registry kind). */
export const CHANNEL_KINDS = ["os", "telegram", "webhook", "slack", "discord", "ntfy", "pushover", "email", "shortcuts", "command"] as const;

export type ChannelKind = (typeof CHANNEL_KINDS)[number];

/** The kinds the registry describes: every kind but the implicit OS toast. */
export type RegistryKind = Exclude<ChannelKind, "os">;

/** The events a channel can subscribe to. `digest` is the daily summary. */
export type EventKind = "task_done" | "task_failed" | "clean_window" | "not_ready" | "digest";

export const EVENT_KINDS: readonly EventKind[] = ["task_done", "task_failed", "clean_window", "not_ready", "digest"];

/** `config.quiet` of a channel: `night` skips every event but `digest` from 22:00 to 09:00 local time (KTD10). */
export type QuietMode = "night" | "off";

/** One row of the ledger `channels` table. */
export interface Channel {
  id: string;
  kind: ChannelKind;
  enabled: boolean;
  events: EventKind[];
  /**
   * Kind-specific non-secret settings (`telegram`: {@link TelegramChannelConfig})
   * plus the shared `quiet` ({@link QuietMode}, absent = `off`). Secrets never live here.
   */
  config: Record<string, unknown>;
  /** ISO-8601. */
  createdAt: string;
}

/** `config` of a telegram channel. The bot token is never stored: the host reads it from its env file. */
export interface TelegramChannelConfig {
  chat_id: number;
  /** The paired user's @username or first name, for `channels list`. */
  label?: string;
}

/** A clean window as the host computed it from the forecast. */
export interface CleanWindowEvent {
  /** ISO-8601 start; also the dedupe key (`notified:clean_window:<start>`). */
  start: string;
  /** ISO-8601 end. */
  end: string;
  /** Lowest intensity in the window, gCO2e/kWh, when known. */
  g?: number;
}

/** A task event a channel can receive. A `digest` carries its finished text; the host builds it from the ledger. */
export type ChannelEvent =
  | { kind: "task_done"; task: TaskRecord<unknown> }
  | { kind: "task_failed"; task: TaskRecord<unknown> }
  | { kind: "clean_window"; window: CleanWindowEvent }
  /** `recovered`: a ticker alert was sent before and the tick daemon runs again; `problems` may then be empty. */
  | { kind: "not_ready"; problems: ReadinessProblem[]; recovered?: true }
  | { kind: "digest"; title: string; text: string; covers?: DigestCovers };

/** What a daily summary lists, so a channel that gets it gets no separate alert for the same thing ({@link foldIntoDigest}). */
export interface DigestCovers {
  /** Done and failed tasks the summary lists by title (at most `DIGEST_LIST_MAX` of each). */
  taskIds: readonly string[];
  /** The summary lists the open readiness problems. */
  notReady: boolean;
  /** Start of the clean window the summary names. */
  cleanWindow?: string;
}

/** One send a host performs: `event` to `channel`. */
export interface SendJob {
  channel: Channel;
  event: ChannelEvent;
}

/** The OS toast as a channel (R23): implicit, done and failed only, enabled by the host's config switch. */
export function osChannel(enabled: boolean): Channel {
  return { id: "os", kind: "os", enabled, events: ["task_done", "task_failed"], config: {}, createdAt: new Date(0).toISOString() };
}

/** The chat id of a telegram channel, or undefined when its config has none. */
export function telegramChatId(channel: Channel): number | undefined {
  if (channel.kind !== "telegram") return undefined;
  const id = (channel.config as Partial<TelegramChannelConfig>).chat_id;
  return typeof id === "number" && Number.isSafeInteger(id) ? id : undefined;
}

/** The channel's quiet mode; anything but `night` is `off`. */
export function channelQuiet(channel: Channel): QuietMode {
  return channel.config.quiet === "night" ? "night" : "off";
}
