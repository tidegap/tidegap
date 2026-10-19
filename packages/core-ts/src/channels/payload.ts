/**
 * The one payload model every channel formats from (KTD2). Text comes from
 * {@link eventMessage}, so every channel says what Telegram says, with its
 * redaction and the 600-character preview. Title and text are untrusted
 * plain text: a `format` for a receiver that renders markup escapes them.
 */

import type { TaskStatus } from "../types.js";
import { eventMessage, messageTitle } from "./format.js";
import type { ChannelEvent, EventKind } from "./types.js";

export type NotificationLevel = "info" | "success" | "warning" | "error";

export interface NotificationPayload {
  event: EventKind;
  level: NotificationLevel;
  /** One line. */
  title: string;
  /** The full message, as Telegram sends it. */
  text: string;
  /** ISO-8601: when the event happened (a task's completion), else when the payload was built. */
  at: string;
  task?: { id: string; title: string; status: TaskStatus; grams?: number };
}

const LEVEL: Record<EventKind, NotificationLevel> = {
  task_done: "success",
  task_failed: "error",
  clean_window: "info",
  not_ready: "warning",
  digest: "info",
};

function validIso(iso: string | undefined): string | undefined {
  return iso && Number.isFinite(Date.parse(iso)) ? iso : undefined;
}

/** The payload of one event. */
export function payloadFor(event: ChannelEvent, now: Date = new Date()): NotificationPayload {
  const { text } = eventMessage(event, now);
  const base = { event: event.kind, level: LEVEL[event.kind], text };
  switch (event.kind) {
    case "task_done":
    case "task_failed": {
      const record = event.task;
      const title = messageTitle(record);
      const grams = record.receipt?.actualCarbonGCo2 ?? record.receipt?.estimatedCarbonGCo2;
      return {
        ...base,
        title: `${event.kind === "task_done" ? "Done" : "Failed"}: ${title}`,
        at: validIso(record.completedAt) ?? now.toISOString(),
        task: { id: record.taskId, title, status: record.status, ...(typeof grams === "number" && Number.isFinite(grams) ? { grams } : {}) },
      };
    }
    case "clean_window":
      return { ...base, title: "Clean window starting", at: validIso(event.window.start) ?? now.toISOString() };
    case "not_ready":
      return { ...base, title: text.split("\n")[0]!, at: now.toISOString() };
    case "digest":
      return { ...base, title: event.title.split("\n")[0]!.trim(), at: now.toISOString() };
  }
}
