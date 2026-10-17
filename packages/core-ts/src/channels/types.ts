/**
 * Channel registry types (coherence KTD10). A channel is a place a host
 * sends task events to: the OS toast (`os`) or a paired Telegram chat
 * (`telegram`). Core holds the types and pure planning; the host owns
 * every side effect (spawning the toast, calling the Bot API).
 */

import type { ReadinessProblem } from "../readiness.js";
import type { TaskRecord } from "../types.js";

export type ChannelKind = "os" | "telegram";

/** The events a channel can subscribe to. */
export type EventKind = "task_done" | "task_failed" | "clean_window" | "not_ready";

export const EVENT_KINDS: readonly EventKind[] = ["task_done", "task_failed", "clean_window", "not_ready"];

/** One row of the ledger `channels` table. */
export interface Channel {
  id: string;
  kind: ChannelKind;
  enabled: boolean;
  events: EventKind[];
  /** Kind-specific settings; `telegram`: {@link TelegramChannelConfig}. */
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

/** A task event a channel can receive. */
export type ChannelEvent =
  | { kind: "task_done"; task: TaskRecord<unknown> }
  | { kind: "task_failed"; task: TaskRecord<unknown> }
  | { kind: "clean_window"; window: CleanWindowEvent }
  | { kind: "not_ready"; problems: ReadinessProblem[] };

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
