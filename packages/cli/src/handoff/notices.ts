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
 */

import { chmodSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isValidSessionId, SESSION_NOTICE_MAX_AGE_MS, stripControlChars } from "@tidegap/core";
import type { SessionNotice, TaskStore } from "@tidegap/core";

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

/** One quoted title: control characters removed, at most {@link NOTICE_TITLE_MAX_CHARS} characters. */
function quotedTitle(title: string | undefined): string {
  if (!title) return "";
  const clean = stripControlChars(title).trim();
  if (!clean) return "";
  const chars = Array.from(clean);
  const cut = chars.length > NOTICE_TITLE_MAX_CHARS ? `${chars.slice(0, NOTICE_TITLE_MAX_CHARS - 1).join("")}…` : clean;
  return ` ${JSON.stringify(cut)}`;
}

/** The result file part of a line: its path once written, else that it was not written. */
function resultPart(n: SessionNotice): string {
  if (!n.resultPath) return "";
  return n.resultFile?.written === true ? ` result_path: ${n.resultPath}` : " result file not written";
}

/**
 * The notice: one line per finished task with its id, status, quoted title
 * and result file, at most {@link NOTICE_MAX_TASKS}, then a count. Never the
 * result or the error text: those come from prompts and model output.
 */
export function renderNotices(notices: readonly SessionNotice[]): string {
  if (notices.length === 0) return "";
  const noun = notices.length === 1 ? "task" : "tasks";
  const lines = [`Tidegap: ${notices.length} ${noun} queued from this session finished:`];
  for (const n of notices.slice(0, NOTICE_MAX_TASKS)) {
    lines.push(`- ${n.record.taskId} ${n.record.status}${quotedTitle(n.record.title)}${resultPart(n)}`);
  }
  if (notices.length > NOTICE_MAX_TASKS) {
    lines.push(`- and ${notices.length - NOTICE_MAX_TASKS} more: run \`tidegap queue list --session current\`.`);
  }
  lines.push("Read one with: tidegap queue show <id> (or check_queue_status task_id=<id>).");
  return lines.map((l) => Array.from(stripControlChars(l)).slice(0, NOTICE_LINE_MAX_CHARS).join("")).join("\n");
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
