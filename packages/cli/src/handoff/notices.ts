/**
 * Session notices: the text a Claude Code session gets on its next prompt
 * when tasks it queued finished, and the marker files that let the plugin's
 * prompt hook stay in `sh` when there is nothing to say.
 *
 * `~/.tidegap/sessions/notices/<session_id>` exists while the session has a
 * deliverable notice. Only the Node tick creates markers (the sweep below,
 * after every tick pass); the sweep and `queue notices` remove them. The
 * ledger stays the truth: a marker is a hint, and a missing one comes back
 * on the next tick.
 *
 * The wake markers (`~/.tidegap/sessions/wake/<session_id>`) are written at
 * enqueue by `queue add --wake` and `schedule_task` with `wake_session`, and
 * removed by the waiter (`handoff/waiter.ts`); the sweep here removes one
 * that is older than 12 h and has no wake task left to wait for, and any
 * older than 7 days.
 */

import { chmodSync, lstatSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  isValidSessionId,
  removeWakeMarker,
  SESSION_NOTICE_MAX_AGE_MS,
  stripControlChars,
  taskWorkShape,
  WAKE_MARKER_MAX_AGE_MS,
  wakeMarkersDir,
  writeWakeMarker,
} from "@tidegap/core";
import type { SessionNotice, TaskRecord, TaskStatus, TaskStore } from "@tidegap/core";

import { sessionsDir } from "../session/capture.js";

/** Tasks a notice names one by one; the rest are counted. */
export const NOTICE_MAX_TASKS = 10;
/** Longest title in a notice line. */
export const NOTICE_TITLE_MAX_CHARS = 60;
/** Longest notice line. */
export const NOTICE_LINE_MAX_CHARS = 400;

/** `~/.tidegap/sessions/notices`. */
export function noticesDir(dir: string = sessionsDir()): string {
  return join(dir, "notices");
}

/** The marker of one session, or undefined for an id that fails the id rule. */
export function noticeMarkerPath(sessionId: string, dir: string = noticesDir()): string | undefined {
  return isValidSessionId(sessionId) ? join(dir, sessionId) : undefined;
}

/** Longest notice in all, under the 10,000 characters Claude Code adds from a prompt hook. */
export const NOTICE_TEXT_MAX_CHARS = 9_000;

const chars = (text: string): string[] => Array.from(text);

/** One quoted title: control characters removed, at most `max` characters (an ellipsis marks a cut); "" when none fits. */
function quotedTitle(title: string | undefined, max: number = NOTICE_TITLE_MAX_CHARS): string {
  if (!title || max < 2) return "";
  const clean = stripControlChars(title).trim();
  if (!clean) return "";
  const all = chars(clean);
  const cut = all.length > max ? `${all.slice(0, max - 1).join("")}…` : clean;
  return ` ${JSON.stringify(cut)}`;
}

/** The result file part of a line: its path once written, else that it was not written. */
function resultPart(n: SessionNotice): string {
  if (!n.resultPath) return "";
  return n.resultFile?.written === true ? ` result_path: ${stripControlChars(n.resultPath)}` : " result file not written";
}

/** A job run's reasons: ` (job: matched)`, ` (job: failed, ended)`; never the output or the pattern. */
function jobPart(n: SessionNotice): string {
  return n.jobNotice ? ` (job: ${n.jobNotice.reasons.join(", ")})` : "";
}

/**
 * One task's line: id, status, quoted title, a job run's reasons, result
 * file. The line is cut to {@link NOTICE_LINE_MAX_CHARS}, but a result path
 * stays whole: the title is shortened or dropped first, and a path longer
 * than that keeps its line longer.
 */
function noticeLine(n: SessionNotice): string {
  const head = stripControlChars(`- ${n.record.taskId} ${n.record.status}`);
  const tail = `${jobPart(n)}${resultPart(n)}`;
  const room = NOTICE_LINE_MAX_CHARS - chars(head).length - chars(tail).length - 3;
  const title = quotedTitle(n.record.title, Math.min(NOTICE_TITLE_MAX_CHARS, room));
  if (!tail) return chars(`${head}${title}`).slice(0, NOTICE_LINE_MAX_CHARS).join("");
  return `${chars(head).slice(0, NOTICE_LINE_MAX_CHARS).join("")}${title}${tail}`;
}

/** The notice text and how many tasks it names one by one (the ones a delivery may claim). */
export interface NoticeBlock {
  text: string;
  listed: number;
}

/**
 * The notice: one line per finished task with its id, status, quoted title
 * and result file, at most {@link NOTICE_MAX_TASKS} and
 * {@link NOTICE_TEXT_MAX_CHARS} in all, then a count of the rest. Never the
 * result or the error text: those come from prompts and model output.
 */
export function renderNoticeBlock(notices: readonly SessionNotice[]): NoticeBlock {
  if (notices.length === 0) return { text: "", listed: 0 };
  const noun = notices.length === 1 ? "task" : "tasks";
  const first = `Tidegap: ${notices.length} ${noun} queued from this session finished:`;
  const last = "Read one with: tidegap queue show <id> (or check_queue_status task_id=<id>).";
  const more = (n: number) => `- and ${n} more: run \`tidegap queue list --session current\`.`;
  const lines = [first];
  // Room for the first and last lines and the count line, with their newlines.
  let used = first.length + last.length + more(notices.length).length + 3;
  for (const n of notices.slice(0, NOTICE_MAX_TASKS)) {
    const line = noticeLine(n);
    if (lines.length > 1 && used + chars(line).length + 1 > NOTICE_TEXT_MAX_CHARS) break;
    lines.push(line);
    used += chars(line).length + 1;
  }
  const listed = lines.length - 1;
  if (notices.length > listed) lines.push(more(notices.length - listed));
  lines.push(last);
  return { text: lines.join("\n"), listed };
}

/** {@link renderNoticeBlock}'s text. */
export function renderNotices(notices: readonly SessionNotice[]): string {
  return renderNoticeBlock(notices).text;
}

/** Remove a session's marker; a missing one is fine. */
export function removeNoticeMarker(sessionId: string, dir: string = noticesDir()): void {
  const path = noticeMarkerPath(sessionId, dir);
  if (!path) return;
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
}

export interface NoticeSweepResult {
  created: string[];
  removed: string[];
}

/**
 * Make the markers match the ledger: a marker (file `0600`, folder `0700`)
 * for each session with a deliverable notice, none for the others, and none
 * older than 7 days. Never throws: a sweep must not fail the tick.
 */
export function noticeSweep(store: TaskStore, dir: string = noticesDir(), now: Date = new Date()): NoticeSweepResult {
  const out: NoticeSweepResult = { created: [], removed: [] };
  try {
    const due = new Set(
      store
        .listSessionNotices({ now })
        .map((n) => n.record.originSessionId)
        .filter((id): id is string => isValidSessionId(id)),
    );
    let present: string[] = [];
    try {
      present = readdirSync(dir).filter((name) => isValidSessionId(name));
    } catch {
      // no folder yet
    }
    for (const id of present) {
      let old = false;
      try {
        old = now.getTime() - statSync(join(dir, id)).mtimeMs > SESSION_NOTICE_MAX_AGE_MS;
      } catch {
        continue;
      }
      if (due.has(id) && !old) continue;
      removeNoticeMarker(id, dir);
      out.removed.push(id);
    }
    if (due.size === 0) return out;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    for (const id of due) {
      try {
        writeFileSync(join(dir, id), `${now.toISOString()}\n`, { mode: 0o600, flag: "wx" });
        out.created.push(id);
      } catch {
        // present already, or the folder is not writable
      }
    }
  } catch {
    // an unreadable ledger or folder: the next tick tries again
  }
  return out;
}

/** Statuses of a task that may still finish. */
const OPEN: readonly TaskStatus[] = ["queued", "scheduled", "running", "submitted"];

/** True for a task queued with wake. */
export function isWakeTask(record: Pick<TaskRecord<unknown>, "bodyJson">): boolean {
  return taskWorkShape(record).wake === true;
}

/**
 * A session's wake tasks still to come: not finished yet, or completed and
 * waiting for its result file (its notice comes once the file is). A row
 * that completed more than {@link SESSION_NOTICE_MAX_AGE_MS} ago no longer
 * counts: it can never be a notice.
 */
export function pendingWakeTasks(store: TaskStore, sessionId: string, now: Date = new Date()): TaskRecord<unknown>[] {
  return wakeTasksToCome(store, sessionId, now);
}

/** {@link pendingWakeTasks} of one session, or of every session when `sessionId` is undefined. */
function wakeTasksToCome(store: TaskStore, sessionId: string | undefined, now: Date): TaskRecord<unknown>[] {
  const oldest = now.getTime() - SESSION_NOTICE_MAX_AGE_MS;
  return [
    ...store.list({ ...(sessionId === undefined ? {} : { originSessionId: sessionId }), status: OPEN }),
    ...store
      .listResultFilesDue()
      .filter((r) => (sessionId === undefined || r.originSessionId === sessionId) && Date.parse(r.completedAt ?? "") >= oldest),
  ].filter(isWakeTask);
}

/**
 * Remove a session's wake marker, then read its pending wake tasks once
 * more, and write the marker again when one is pending (one queued after
 * `since`, when given) or the read fails. An enqueue commits its row
 * before it writes the marker, so a wake task queued while the caller
 * decided is either seen here or writes its marker after the removal.
 * Returns "removed", "kept" (a task is pending) or "unread" (the read
 * failed). Never throws.
 */
export function removeWakeMarkerUnlessPending(
  store: TaskStore,
  sessionId: string,
  dir: string = wakeMarkersDir(),
  now: Date = new Date(),
  since?: number,
): "removed" | "kept" | "unread" {
  removeWakeMarker(sessionId, dir);
  let left: "removed" | "kept" | "unread";
  try {
    const pending = pendingWakeTasks(store, sessionId, now);
    left = pending.some((t) => since === undefined || Date.parse(t.enqueuedAt) > since) ? "kept" : "removed";
  } catch {
    left = "unread";
  }
  // An unread ledger keeps the marker's old time, so the sweep's 7-day rule still counts from it.
  if (left !== "removed") writeWakeMarker(sessionId, dir, left === "unread" && since !== undefined ? new Date(since) : now);
  return left;
}

/**
 * Write the marker back for each session with a wake task still to come,
 * queued in the last {@link SESSION_NOTICE_MAX_AGE_MS}, whose marker is
 * gone: a remover that died between its removal and its second look, or a
 * marker write that failed. The marker gets that task's enqueue time, so
 * the 7-day rule still counts from the enqueue. Never throws.
 */
function restoreWakeMarkers(store: TaskStore, dir: string, now: Date): void {
  const oldest = now.getTime() - SESSION_NOTICE_MAX_AGE_MS;
  const newest = new Map<string, number>();
  try {
    for (const t of wakeTasksToCome(store, undefined, now)) {
      const id = t.originSessionId;
      const at = Date.parse(t.enqueuedAt);
      if (!id || !isValidSessionId(id) || !(at >= oldest)) continue;
      newest.set(id, Math.max(newest.get(id) ?? at, at));
    }
  } catch {
    return;
  }
  for (const [id, at] of newest) {
    try {
      lstatSync(join(dir, id));
      continue;
    } catch {
      // gone: write it back
    }
    writeWakeMarker(id, dir, new Date(Math.min(at, now.getTime())));
  }
}

/**
 * Remove the wake markers that have nothing left to do: older than
 * {@link WAKE_MARKER_MAX_AGE_MS} (since the enqueue, or the session's last
 * Stop) with no wake task of the session still to come, and any older than
 * {@link SESSION_NOTICE_MAX_AGE_MS}. A marker of a session with a pending
 * wake task stays, so the session's next turn starts a waiter for it.
 * Without a ledger (`store` undefined) only the 7-day rule applies. A wake
 * task queued after the marker's last refresh puts it back
 * ({@link removeWakeMarkerUnlessPending}). With a ledger, a session with a
 * recent wake task to come gets its missing marker back
 * ({@link restoreWakeMarkers}). Returns the sessions whose marker went.
 * Never throws.
 */
export function wakeSweep(store: TaskStore | undefined, dir: string = wakeMarkersDir(), now: Date = new Date()): string[] {
  const removed: string[] = [];
  let present: string[] = [];
  try {
    present = readdirSync(dir).filter((name) => isValidSessionId(name));
  } catch {
    // no folder yet: nothing to remove, maybe one to write back
  }
  for (const id of present) {
    let refreshed: number;
    try {
      refreshed = statSync(join(dir, id)).mtimeMs;
      const age = now.getTime() - refreshed;
      if (age <= WAKE_MARKER_MAX_AGE_MS) continue;
      if (age <= SESSION_NOTICE_MAX_AGE_MS && (!store || pendingWakeTasks(store, id, now).length > 0)) continue;
    } catch {
      continue;
    }
    if (!store) removeWakeMarker(id, dir);
    else if (removeWakeMarkerUnlessPending(store, id, dir, now, refreshed) !== "removed") continue;
    removed.push(id);
  }
  if (store) restoreWakeMarkers(store, dir, now);
  return removed;
}
