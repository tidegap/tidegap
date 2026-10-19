/** Pure notification planning (KTD10): which channel receives which event, with quiet hours. */

import { MORNING_START_H, TONIGHT_START_H } from "../postpone.js";
import { channelQuiet, type Channel, type ChannelEvent, type SendJob } from "./types.js";

/** True when local time `now` is in the quiet hours [22:00, 09:00), the `tonight` and `tomorrow_morning` preset starts. */
export function isQuietTime(now: Date): boolean {
  const h = now.getHours();
  return h >= TONIGHT_START_H || h < MORNING_START_H;
}

/**
 * One job per (event, enabled channel subscribed to the event's kind), in
 * event order. A channel with quiet `night` gets no job in the quiet hours,
 * except the daily summary (`digest`).
 */
export function planNotifications(events: readonly ChannelEvent[], channels: readonly Channel[], now: Date = new Date()): SendJob[] {
  const quiet = isQuietTime(now);
  const jobs: SendJob[] = [];
  for (const event of events) {
    for (const channel of channels) {
      if (!channel.enabled || !channel.events.includes(event.kind)) continue;
      if (quiet && event.kind !== "digest" && channelQuiet(channel) === "night") continue;
      jobs.push({ channel, event });
    }
  }
  return jobs;
}
