/** Pure notification planning (KTD10): which channel receives which event. */

import type { Channel, ChannelEvent, SendJob } from "./types.js";

/** One job per (event, enabled channel subscribed to the event's kind), in event order. */
export function planNotifications(events: readonly ChannelEvent[], channels: readonly Channel[]): SendJob[] {
  const jobs: SendJob[] = [];
  for (const event of events) {
    for (const channel of channels) {
      if (channel.enabled && channel.events.includes(event.kind)) jobs.push({ channel, event });
    }
  }
  return jobs;
}
