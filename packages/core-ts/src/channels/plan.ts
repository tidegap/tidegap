/** Pure notification planning (KTD10): which channel receives which event, with quiet hours. */

import { MORNING_START_H, TONIGHT_START_H } from "../postpone.js";
import { channelQuiet, type Channel, type ChannelEvent, type DigestCovers, type EventKind, type SendJob } from "./types.js";

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

/** True when the summary `covers` lists what `event` reports. */
function coveredBy(event: ChannelEvent, covers: DigestCovers): boolean {
  switch (event.kind) {
    case "task_done":
    case "task_failed":
      return covers.taskIds.includes(event.task.taskId);
    case "not_ready":
      return covers.notReady;
    case "clean_window":
      return covers.cleanWindow === event.window.start;
    case "digest":
      return false;
  }
}

/**
 * Fold alerts into the daily summary: a channel that gets the summary in
 * this run gets no separate job for a task, problem or window the summary
 * lists (an alert held by quiet hours then arrives once, inside the
 * summary). Other channels and alerts the summary does not list keep their
 * jobs. `folded` names the event kinds a fold dropped.
 */
export function foldIntoDigest(jobs: readonly SendJob[]): { jobs: SendJob[]; folded: Set<EventKind> } {
  const coversByChannel = new Map<string, DigestCovers>();
  for (const j of jobs) if (j.event.kind === "digest" && j.event.covers) coversByChannel.set(j.channel.id, j.event.covers);
  const folded = new Set<EventKind>();
  const kept = jobs.filter((j) => {
    const covers = coversByChannel.get(j.channel.id);
    if (!covers || !coveredBy(j.event, covers)) return true;
    folded.add(j.event.kind);
    return false;
  });
  return { jobs: kept, folded };
}
