/**
 * Channel message texts and their buttons (KTD10, KTD15, R26, R27). Plain
 * text only. Every title goes through `displayTitle` and control-character
 * stripping; a result preview is the first {@link TELEGRAM_PREVIEW_CHARS}
 * characters, default-redacted, and absent for a task that redacts its
 * receipt (Key Decisions, Q4).
 *
 * Button table, per message:
 *
 * | Message            | Buttons                                              |
 * |--------------------|------------------------------------------------------|
 * | task done          | [Result]                                             |
 * | task failed        | none                                                 |
 * | `/queue` listing   | per task row: [n Later ▾] [n Run now] [n Cancel], each only when `taskActions` allows it |
 * | `/jobs` listing    | none: `/jobs pause|resume|run <n|id>` act on it      |
 * | Later ▾ menu       | one row per available `postponeOptions` entry: [<label> · <time>] |
 * | clean window       | none                                                 |
 * | not ready          | none                                                 |
 * | replies and `/result` | none                                              |
 */

import {
  displayTitle,
  formatBytes,
  isRedactedTask,
  sendableAttachments,
  stripControlChars,
  taskActions,
  taskAttachments,
  taskAttachmentsSkipped,
  taskResultText,
  taskSummaryError,
  taskSummaryText,
  type TaskAttachment,
} from "../history.js";
import { JOB_AUTO_PAUSE_FAILURES, jobAutoPauseReason, jobEndText, jobLastRun, jobNextRun, runOutcome } from "../jobs.js";
import { clip, firstErrorLine, oneLine } from "../notify.js";
import { localTimeLabel, type PostponeOption, type PostponePreset } from "../postpone.js";
import { problemLine, TICKER_CODES, type ReadinessProblem } from "../readiness.js";
import { zoneTimeLabel } from "../zone-time.js";
import { redactPrompt } from "../redact.js";
import { freshReasonText, shortSessionId } from "../run-session.js";
import type { JobCadence, JobRecord, ProviderCallSpec, TaskRecord } from "../types.js";
import { TELEGRAM_CALLBACK_MAX_BYTES, TELEGRAM_MESSAGE_MAX, type InlineKeyboard } from "./telegram.js";
import { cutPreview, NOTICE_EMOJI, NOTICE_VERDICT_CHARS, stripBidiControls, structureSummary, type NoticeStatus, type StructuredSummary } from "./notice.js";
import type { ChannelEvent, CleanWindowEvent, JobEndedNotice, JobPausedNotice } from "./types.js";

/** Characters of result text a done message previews (Q4). */
export const TELEGRAM_PREVIEW_CHARS = 600;

/** Longest `📎` line: with the title, the time and a full preview, a notice still fits the smallest body cap (Pushover, 1024). */
export const ATTACHMENT_LINE_CHARS = 300;

/** Most characters of the verdict a job's notice leads with. */
const VERDICT_CHARS = NOTICE_VERDICT_CHARS;

/** Most messages one `/result` sends before pointing to `tidegap queue show`. */
export const RESULT_MAX_PARTS = 4;

/** Tasks one `/queue` lists. */
export const QUEUE_LIST_MAX = 10;

/** Jobs one `/jobs` lists; the same cap as the digest's lists. */
export const JOBS_LIST_MAX = 10;

/** The stored files a host sends after a message's text (Telegram only), from {@link sendableAttachments}. */
export interface OutgoingFiles {
  taskId: string;
  attachments: readonly TaskAttachment[];
}

/** A message a host sends: text, optional inline buttons, and optional files to send after it. */
export interface OutgoingMessage {
  text: string;
  buttons?: InlineKeyboard;
  files?: OutgoingFiles;
}

/** Button actions in `callback_data` (KTD15). */
export type CallbackActionName = "later" | "cancel" | "run" | "result";

const ACTION_CODE: Record<CallbackActionName, string> = { later: "l", cancel: "c", run: "x", result: "r" };
const PRESET_CODE: Record<PostponePreset, string> = { "1h": "h", tonight: "n", tomorrow_morning: "m", after_limit_reset: "r" };

/** `<action>:<task_id>[:<preset code>]` (KTD15). */
export function encodeCallback(action: CallbackActionName, taskId: string, preset?: PostponePreset): string {
  return `${ACTION_CODE[action]}:${taskId}${action === "later" && preset ? `:${PRESET_CODE[preset]}` : ""}`;
}

/**
 * True when every button of a task fits Telegram's 64-byte `callback_data`
 * and `parseCallback` can read it back. A task id that does not (a long
 * custom id) gets no buttons; its commands still work by number or id.
 */
export function callbackFits(taskId: string): boolean {
  return /^[A-Za-z0-9_~.-]{1,100}$/.test(taskId) && new TextEncoder().encode(encodeCallback("later", taskId, "1h")).length <= TELEGRAM_CALLBACK_MAX_BYTES;
}

/** The decoding tables, for `parseCallback`. */
export const CALLBACK_ACTIONS: Readonly<Record<string, CallbackActionName>> = Object.fromEntries(
  Object.entries(ACTION_CODE).map(([name, code]) => [code, name as CallbackActionName]),
);
export const CALLBACK_PRESETS: Readonly<Record<string, PostponePreset>> = Object.fromEntries(
  Object.entries(PRESET_CODE).map(([preset, code]) => [code, preset as PostponePreset]),
);

/**
 * The one-line preview of a run, the same on the jobs page and in the
 * digest (KTD6): a failed task's first error line with visible text, a
 * completed task's summary, or its result text without one, unless it
 * redacts its receipt, else undefined. Default-redacted, control characters
 * removed, whitespace runs joined; a longer text is cut to `maxChars - 1`
 * code points plus "…", so the result never exceeds `maxChars`.
 */
export function runPreview(record: TaskRecord<unknown>, maxChars: number): string | undefined {
  let text: string | undefined;
  if (record.status === "failed") text = firstErrorLine(record.error, Infinity);
  else if (record.status === "completed" && !isRedactedTask(record)) text = oneLine(taskSummaryText(record) ?? taskResultText(record) ?? "");
  return text ? cutPreview(text, maxChars) : undefined;
}

/**
 * A run's summary in the notice shape, or undefined when the run has no
 * usable summary: it failed, it redacts its receipt, it has no summary, or
 * the summary has no verdict. The summary is default-redacted first.
 */
export function runSummary(record: TaskRecord<unknown>): StructuredSummary | undefined {
  if (record.status !== "completed" || isRedactedTask(record)) return undefined;
  const summary = taskSummaryText(record);
  if (!summary) return undefined;
  const structured = structureSummary(redactPrompt(summary, undefined));
  return structured.verdict ? structured : undefined;
}

/**
 * The status of a job run's notice: `failed` for a failed run; for a
 * completed run, the status word of its usable summary, else `done`. A
 * final notice is `ended`, which the caller sets.
 */
export function noticeStatus(record: TaskRecord<unknown>): NoticeStatus {
  if (record.status === "failed") return "failed";
  return runSummary(record)?.status ?? "done";
}

/** The first line of `text` with visible text, made one line (default-redacted, no bidirectional controls), or undefined. */
function firstVisibleLine(text: string | undefined): string | undefined {
  for (const line of (text ?? "").split(/\r?\n/)) {
    const one = stripBidiControls(oneLine(line)).trim();
    if (one) return one;
  }
  return undefined;
}

/**
 * A run's verdict, the one line a person reads first: for a completed run
 * that does not redact its receipt, the verdict of its summary without the
 * status word, else the first line of its result text; for a failed run,
 * its first error line. Cut to `maxChars`; undefined when there is no such line.
 */
export function runVerdict(record: TaskRecord<unknown>, maxChars = VERDICT_CHARS): string | undefined {
  let line: string | undefined;
  if (record.status === "failed") line = firstErrorLine(record.error, Infinity);
  else if (record.status === "completed" && !isRedactedTask(record)) line = runSummary(record)?.verdict ?? firstVisibleLine(taskResultText(record));
  return line ? cutPreview(line, maxChars) : undefined;
}

/** The title a message shows: `displayTitle`, one line, at most 80 characters, else the task id. */
export function messageTitle(record: TaskRecord<unknown>): string {
  const t = stripControlChars(displayTitle(record) ?? "").trim();
  return t ? clip(t, 80) : record.taskId;
}

/** Text safe to send: default-redacted, control characters removed, newlines kept. */
function safeText(text: string | undefined): string {
  return stripControlChars(redactPrompt(text ?? "", undefined), { multiline: true }).trim();
}

/** Result text safe to send. */
function safeResult(record: TaskRecord<unknown>): string {
  return safeText(taskResultText(record));
}

function showCommand(record: TaskRecord<unknown>): string {
  return `tidegap queue show ${record.taskId}`;
}

function when(iso: string | undefined, now: Date, label: (at: Date, now: Date) => string = localTimeLabel): string | undefined {
  const t = iso ? new Date(iso) : undefined;
  return t && Number.isFinite(t.getTime()) ? label(t, now) : undefined;
}

/**
 * Where a claude-code run happened (R12), or undefined for a run without
 * that record. Names the directory by its last segment only: the full path
 * stays off the chat.
 */
function runSessionLine(record: TaskRecord<unknown>): string | undefined {
  const session = record.receipt?.session;
  if (!session) return undefined;
  if (session.mode === "fresh") {
    return `Ran in a fresh session: ${session.reason ? freshReasonText(session.reason) : "no session"}`;
  }
  const origin = session.originSessionId ?? record.originSessionId;
  const dir = record.originCwd?.split("/").filter(Boolean).pop();
  const where = dir ? ` (${stripControlChars(dir)})` : "";
  return origin ? `Ran in a copy of session ${shortSessionId(origin)}${where}` : `Ran in a copy of its session${where}`;
}

/** A job's title as a message shows it (one line, no bidirectional controls, at most 80 characters), or undefined when blank. */
function cleanJobTitle(title: string | undefined): string | undefined {
  const t = stripBidiControls(stripControlChars(title ?? "")).trim();
  return t ? clip(t, 80) : undefined;
}

/** The title a task event's message shows: the job's title for a job occurrence, else {@link messageTitle}. */
export function eventTitle(record: TaskRecord<unknown>, jobTitle?: string): string {
  return cleanJobTitle(jobTitle) ?? messageTitle(record);
}

/**
 * The body of a job run's notice: with a usable summary, one `• ` line per
 * bullet, cut to {@link TELEGRAM_PREVIEW_CHARS}; else the raw output after
 * its first visible line (the whole raw preview when that line was cut),
 * clipped to {@link TELEGRAM_PREVIEW_CHARS}; "" when there is nothing more.
 */
function jobDoneBody(record: TaskRecord<unknown>): string {
  const summary = runSummary(record);
  if (summary) return cutPreview(summary.bullets.map((b) => `• ${b}`).join("\n"), TELEGRAM_PREVIEW_CHARS);
  const result = safeResult(record);
  const lines = result.split(/\r?\n/);
  const first = lines.findIndex((line) => oneLine(line) !== "");
  if (first < 0) return "";
  if (Array.from(oneLine(lines[first]!)).length > VERDICT_CHARS) return clip(result, TELEGRAM_PREVIEW_CHARS);
  return clip(lines.slice(first + 1).join("\n").trim(), TELEGRAM_PREVIEW_CHARS);
}

/**
 * The line that names a run's attachments: `📎 funnel.png (48 KB), weekly.csv
 * (2 KB), not attached: huge.png (over 10 MB)`. A redacted task names no
 * file: `📎 2 files, not sent: this task redacts its receipt`. Undefined
 * when the run has none.
 */
export function attachmentLine(record: TaskRecord<unknown>): string | undefined {
  const stored = taskAttachments(record);
  if (isRedactedTask(record)) {
    const n = stored.length;
    return n > 0 ? `📎 ${n} ${n === 1 ? "file" : "files"}, not sent: this task redacts its receipt` : undefined;
  }
  const skipped = taskAttachmentsSkipped(record);
  const parts = stored.map((a) => `${a.name} (${formatBytes(a.bytes)})`);
  if (skipped.length > 0) parts.push(`not attached: ${skipped.map((s) => `${s.name} (${s.reason})`).join(", ")}`);
  return parts.length > 0 ? cutPreview(`📎 ${parts.join(", ")}`, ATTACHMENT_LINE_CHARS) : undefined;
}

/** The files a message about `record` sends after its text, or undefined. */
function messageFiles(record: TaskRecord<unknown>): { files?: OutgoingFiles } {
  const attachments = sendableAttachments(record);
  return attachments.length > 0 ? { files: { taskId: record.taskId, attachments } } : {};
}

/**
 * Task done (R26): title, time, the attachments line, where it ran, the
 * preview or the redaction note, and a [Result] button with the raw result;
 * the run's sendable files go with it. A job occurrence
 * (`jobTitle`) leads with `<status emoji> <job title> — <verdict>`, adds the job's next run
 * (`jobNext`) to the time line, a `No summary` line when its summarize step
 * failed, and shows its summary in place of the raw preview.
 */
export function taskDoneMessage(record: TaskRecord<unknown>, now: Date = new Date(), jobTitle?: string, jobNext?: string): OutgoingMessage {
  const job = cleanJobTitle(jobTitle);
  const redacted = isRedactedTask(record);
  const at = when(record.completedAt, now);
  const lines: string[] = [];
  let body = "";
  if (job) {
    lines.push(`${NOTICE_EMOJI[noticeStatus(record)]} ${job} — ${runVerdict(record) ?? "done"}`);
    const next = jobNext && jobNext !== JOB_RUNNING_NOW ? `next ${jobNext}` : undefined;
    const time = [at && `Finished ${at}`, next].filter(Boolean).join(" · ");
    if (time) lines.push(time);
  } else {
    lines.push(`Done: ${messageTitle(record)}`);
    if (at) lines.push(`Finished ${at}`);
  }
  const files = attachmentLine(record);
  if (files) lines.push(files);
  const ran = runSessionLine(record);
  if (ran) lines.push(ran);
  if (job && !redacted) {
    const failed = firstErrorLine(taskSummaryError(record), Infinity);
    if (failed) lines.push(`No summary: ${cutPreview(failed, VERDICT_CHARS)}`);
    body = jobDoneBody(record);
  } else if (!redacted) {
    body = clip(safeResult(record), TELEGRAM_PREVIEW_CHARS);
  }
  if (redacted) {
    lines.push("", `The result is not sent here: this task redacts its receipt. Run \`${showCommand(record)}\`.`);
  } else if (body) {
    lines.push("", body);
  }
  const buttons = callbackFits(record.taskId) ? [[{ text: "Result", data: encodeCallback("result", record.taskId) }]] : undefined;
  return { text: lines.join("\n"), ...(buttons ? { buttons } : {}), ...messageFiles(record) };
}

/** The first error line with visible text (notify's firstErrorLine), at most `max` characters, or "unknown error". */
const errorLine = (error: string | undefined, max = 300): string => firstErrorLine(error, max) ?? "unknown error";

/**
 * Task failed: title, time, the first error line, the show command. No
 * buttons. A job occurrence (`jobTitle`) leads with `❌ <job title>: failed`.
 */
export function taskFailedMessage(record: TaskRecord<unknown>, now: Date = new Date(), jobTitle?: string): OutgoingMessage {
  const job = cleanJobTitle(jobTitle);
  const lines = [job ? `${NOTICE_EMOJI.failed} ${job}: failed` : `Failed: ${messageTitle(record)}`];
  const at = when(record.completedAt, now);
  if (at) lines.push(`Failed ${at}`);
  lines.push(errorLine(record.error));
  lines.push(`Run \`${showCommand(record)}\`.`);
  return { text: lines.join("\n") };
}

/** The first line of an auto-pause notice (jobs KTD10): `job '<title>' paused after 3 failures: <reason>`. */
export function jobPausedTitle(notice: JobPausedNotice): string {
  const title = cleanJobTitle(notice.title) ?? notice.jobId;
  return `job '${title}' paused after ${JOB_AUTO_PAUSE_FAILURES} failures: ${errorLine(notice.reason, 200)}`;
}

/** The auto-pause notice: the failed emoji and the sentence, then how to resume. No buttons. */
export function jobPausedMessage(notice: JobPausedNotice): OutgoingMessage {
  return { text: `${NOTICE_EMOJI.failed} ${jobPausedTitle(notice)}\nResume it: tidegap jobs resume ${notice.jobId}` };
}

/** The first line of a job's final notice: `Job ended: "<title>"`. */
export function jobEndedTitle(notice: JobEndedNotice): string {
  return `Job ended: "${cleanJobTitle(notice.title) ?? notice.jobId}"`;
}

/** The body of a job's final notice: why it ended, then its last run with its verdict, or its first error line. */
export function jobEndedBody(notice: JobEndedNotice, last: TaskRecord<unknown>): string {
  const title = cleanJobTitle(notice.title) ?? notice.jobId;
  const verdict = runVerdict(last);
  return `"${title}" ended: ${jobEndText(notice.reason, notice.until)}.\nLast run: ${last.taskId} ${notice.lastOutcome}${verdict ? `: ${verdict}` : "."}`;
}

/** A job's final notice: the ended emoji, the title line and the body. No buttons. */
export function jobEndedMessage(notice: JobEndedNotice, last: TaskRecord<unknown>): OutgoingMessage {
  return { text: `${NOTICE_EMOJI.ended} ${jobEndedTitle(notice)}\n${jobEndedBody(notice, last)}` };
}

/** A clean window starting. No buttons. */
export function cleanWindowMessage(window: CleanWindowEvent, now: Date = new Date()): OutgoingMessage {
  const start = when(window.start, now) ?? window.start;
  const end = when(window.end, now) ?? window.end;
  const g = typeof window.g === "number" ? `, ${Math.round(window.g)} gCO2e/kWh` : "";
  return { text: `Clean window starting: ${start} to ${end}${g}. Queued tasks run in it when their deadline allows.` };
}

/**
 * Tasks will not run (R26): "the tick daemon stopped" for ticker problems,
 * "tasks cannot run" otherwise; `recovered` heads it "running again". No buttons.
 */
export function notReadyMessage(problems: readonly ReadinessProblem[], recovered = false): OutgoingMessage {
  const ticker = problems.some((p) => TICKER_CODES.includes(p.code));
  const head = recovered
    ? "Tidegap: the tick daemon is running again."
    : ticker
      ? "Tidegap: the tick daemon is not running."
      : "Tidegap: queued tasks cannot run.";
  return { text: [head, ...problems.map(problemLine)].join("\n") };
}

/** The message for a planned event. */
export function eventMessage(event: ChannelEvent, now: Date = new Date()): OutgoingMessage {
  switch (event.kind) {
    case "task_done":
      if (event.jobEnded) return jobEndedMessage(event.jobEnded, event.task);
      return taskDoneMessage(event.task, now, event.jobTitle, event.jobNext);
    case "task_failed":
      if (event.jobEnded) return jobEndedMessage(event.jobEnded, event.task);
      return event.jobPaused ? jobPausedMessage(event.jobPaused) : taskFailedMessage(event.task, now, event.jobTitle);
    case "clean_window":
      return cleanWindowMessage(event.window, now);
    case "not_ready":
      return notReadyMessage(event.problems, event.recovered === true);
    case "digest":
      return { text: `${event.title}\n${event.text}` };
  }
}

/** The planned start a listing shows: `running`, else the future plan, else "next tick". */
function plannedLabel(record: TaskRecord<unknown>, now: Date): string {
  if (record.status === "running") return "running";
  if (record.status === "submitted") return "at the provider";
  const iso = [record.scheduledFor, record.notBefore].find((v) => v && Date.parse(v) > now.getTime());
  return iso ? when(iso, now)! : "next tick";
}

/** `/queue` (R27): numbered tasks and one button row per task. `ids[n-1]` is task n. */
export function queueMessage(records: readonly TaskRecord<unknown>[], now: Date = new Date()): OutgoingMessage & { ids: string[] } {
  const listed = records.slice(0, QUEUE_LIST_MAX);
  if (listed.length === 0) return { text: "The queue is empty.", ids: [] };
  const lines = [`Queue, next ${listed.length}:`];
  const buttons: InlineKeyboard = [];
  listed.forEach((r, i) => {
    const n = i + 1;
    lines.push(`${n}. ${messageTitle(r)} · ${plannedLabel(r, now)}`);
    const a = callbackFits(r.taskId) ? taskActions(r) : { later: false, runNow: false, cancel: false };
    const row = [];
    if (a.later) row.push({ text: `${n} Later ▾`, data: encodeCallback("later", r.taskId) });
    if (a.runNow) row.push({ text: `${n} Run now`, data: encodeCallback("run", r.taskId) });
    if (a.cancel) row.push({ text: `${n} Cancel`, data: encodeCallback("cancel", r.taskId) });
    if (row.length > 0) buttons.push(row);
  });
  lines.push("", "Numbers stay valid for 10 minutes. Example: /later 1 tonight");
  return { text: lines.join("\n"), buttons, ids: listed.map((r) => r.taskId) };
}

/** A job's title: one line, at most 80 characters, else the job id. */
export function jobTitle(job: JobRecord): string {
  const t = stripControlChars(job.title).trim();
  return t ? clip(t, 80) : job.jobId;
}

const WEEKDAY_NAMES: Record<string, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };

function cadenceText(cadence: JobCadence): string {
  switch (cadence.kind) {
    case "daily":
      return "every day";
    case "weekdays":
      return "every weekday";
    case "weekly":
      return `every ${cadence.days.map((d) => WEEKDAY_NAMES[d] ?? d).join(", ")}`;
    case "hours":
      return `at least every ${cadence.every} h`;
  }
}

/** The {@link jobNextLabel} of a job whose occurrence is running. */
export const JOB_RUNNING_NOW = "running now";

/**
 * The next run of a job from its live occurrence: running, the planned
 * hour of a scheduled one, or `~` and the earliest start of a queued one.
 * Undefined without a live occurrence.
 */
export function jobNextLabel(job: JobRecord, pending: TaskRecord<unknown> | undefined, now: Date): string | undefined {
  if (!pending) return undefined;
  if (pending.status === "running" || pending.status === "submitted") return JOB_RUNNING_NOW;
  if (pending.status !== "scheduled" && pending.status !== "queued") return undefined;
  const planned = pending.status === "scheduled" ? pending.scheduledFor : undefined;
  const label = when(planned ?? pending.notBefore ?? pending.scheduledFor, now, (t) => zoneTimeLabel(t, now, job.timeZone));
  return label && `${planned ? "" : "~"}${label}`;
}

/** Why a paused job is paused, one line, default-redacted. */
function pausedText(job: JobRecord): string {
  const reason = job.pauseReason ?? "manual";
  if (reason === "manual") return "paused";
  const safe = (text: string) => clip(stripControlChars(redactPrompt(text, undefined)).trim(), 120);
  const auto = jobAutoPauseReason(reason);
  if (auto !== undefined) return `paused after ${job.consecutiveFailures || JOB_AUTO_PAUSE_FAILURES} failures: ${safe(auto)}`;
  return `paused: ${safe(reason)}`;
}

/** One `/jobs` line without its number. */
function jobLine(job: JobRecord, taskOf: (id: string) => TaskRecord<unknown> | undefined, now: Date): string {
  if (job.status === "paused") return `${jobTitle(job)} - ${pausedText(job)}`;
  const parts = [jobTitle(job)];
  parts.push(job.window ? `${cadenceText(job.cadence)} ${job.window.start}-${job.window.end}` : cadenceText(job.cadence));
  const next = jobNextLabel(job, jobNextRun({ get: taskOf }, job), now);
  if (next) parts.push(next === JOB_RUNNING_NOW ? next : `next ${next}`);
  // The last run is an occurrence that ran, never a cancelled one.
  const last = jobLastRun({ get: taskOf }, job);
  const outcome = last && runOutcome(last);
  if (outcome) {
    const at = when(last.completedAt, now, (t) => zoneTimeLabel(t, now, job.timeZone));
    const count = outcome === "failed" && job.consecutiveFailures > 0 ? ` (${job.consecutiveFailures} of ${JOB_AUTO_PAUSE_FAILURES})` : "";
    parts.push(`last ${outcome}${at ? ` ${at}` : ""}${count}`);
  }
  return parts.join(" - ");
}

/**
 * `/jobs` (R28): counts, then one numbered line per job, active ones first, at most
 * {@link JOBS_LIST_MAX}, then "and N more". Times are in each job's zone.
 * `ids[n-1]` is job n.
 */
export function jobsMessage(
  jobs: readonly JobRecord[],
  taskOf: (id: string) => TaskRecord<unknown> | undefined,
  now: Date = new Date(),
): OutgoingMessage & { ids: string[] } {
  if (jobs.length === 0) return { text: "No jobs. Create one on the page: tidegap ui", ids: [] };
  const active = jobs.filter((j) => j.status === "active").length;
  const paused = jobs.filter((j) => j.status === "paused").length;
  // Active first, then paused; each group keeps the ledger's order (oldest first).
  const listed = [...jobs].sort((x, y) => Number(x.status === "paused") - Number(y.status === "paused")).slice(0, JOBS_LIST_MAX);
  const lines = [`Jobs (${[active ? `${active} active` : "", paused ? `${paused} paused` : ""].filter(Boolean).join(", ")})`];
  listed.forEach((j, i) => lines.push(`${i + 1}. ${jobLine(j, taskOf, now)}`));
  if (jobs.length > listed.length) lines.push(`and ${jobs.length - listed.length} more`);
  lines.push("", "Numbers stay valid for 10 minutes. Example: /jobs pause 1", "Edit jobs on the page: tidegap ui");
  return { text: lines.join("\n"), ids: listed.map((j) => j.jobId) };
}

/** The Later ▾ menu of one task: one button per available option. */
export function laterMenuMessage(record: TaskRecord<unknown>, options: readonly PostponeOption[], now: Date = new Date()): OutgoingMessage {
  const available = callbackFits(record.taskId) ? options.filter((o) => o.available && o.not_before) : [];
  if (available.length === 0) {
    const why = options.map((o) => `${o.label}: ${o.reason ?? "unavailable"}`).join("\n");
    return { text: `Later: ${messageTitle(record)}\nNo option is available now.\n${why}` };
  }
  return {
    text: `Later: ${messageTitle(record)}`,
    buttons: available.map((o) => [
      { text: `${o.label} · ${localTimeLabel(new Date(o.not_before!), now)}`, data: encodeCallback("later", record.taskId, o.preset) },
    ]),
  };
}

/** Split text into parts of at most `max` characters, preferring line breaks. */
export function splitMessage(text: string, max: number = TELEGRAM_MESSAGE_MAX): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = max;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest.length > 0 || parts.length === 0) parts.push(rest);
  return parts;
}

/**
 * `/result` and the Result button (R27): no result text and no file for a
 * redacted task; otherwise the result in parts of 4096 characters, at most
 * {@link RESULT_MAX_PARTS}, then a pointer to `tidegap queue show`; the
 * run's sendable files go after the last part.
 */
export function resultMessages(record: TaskRecord<unknown>): OutgoingMessage[] {
  const title = messageTitle(record);
  if (isRedactedTask(record)) {
    return [{ text: `${title}\nThis task is redacted; run \`${showCommand(record)}\`.` }];
  }
  if (record.status !== "completed") {
    return [{ text: `${title} is ${record.status}; it has no result.` }];
  }
  const body = safeResult(record);
  const out: OutgoingMessage[] = [];
  if (!body) out.push({ text: `${title}\nThe result is empty.` });
  else {
    const parts = splitMessage(body, TELEGRAM_MESSAGE_MAX - 100);
    out.push(...parts.slice(0, RESULT_MAX_PARTS).map((p) => ({ text: p })));
    out[0] = { text: `${title}\n\n${out[0]!.text}` };
    if (parts.length > RESULT_MAX_PARTS) out.push({ text: `The result is longer. Run \`${showCommand(record)}\` for the rest.` });
  }
  out[out.length - 1] = { ...out[out.length - 1]!, ...messageFiles(record) };
  return out;
}

/** `/later` grammar (KTD15), quoted by `/help` and the reset-time reply. */
export const LATER_GRAMMAR = "/later <n|id> <1h|tonight|tomorrow|reset [HH:MM]|HH:MM>";

/** `/jobs` grammar, quoted by `/help` and the usage reply. */
export const JOBS_GRAMMAR = "/jobs [pause|resume|run <n|id>]";

/** `/help`. */
export const HELP_TEXT = [
  "Tidegap commands:",
  "/queue - the next 10 tasks, numbered",
  `${LATER_GRAMMAR} - run a task later`,
  "/run <n|id> - run a task at the next tick",
  "/cancel <n|id> - cancel a task",
  "/result <n|id> - the result of a finished task",
  `${JOBS_GRAMMAR} - list recurring jobs; pause, resume or run one`,
  "/help - this list",
  "Numbers come from the last /queue or /jobs and stay valid for 10 minutes.",
].join("\n");

/** The bot's command menu (`setMyCommands`), parsed from {@link HELP_TEXT}: one source of truth. */
export function telegramCommands(help: string = HELP_TEXT): { command: string; description: string }[] {
  const out: { command: string; description: string }[] = [];
  for (const line of help.split("\n")) {
    // Bot API: command 1-32 chars of a-z, 0-9, _; description 1-256 chars.
    const sep = line.indexOf(" - ");
    if (!line.startsWith("/") || sep < 0) continue;
    const name = /^\/([a-z0-9_]{1,32})(?:\s|$)/.exec(line.slice(0, sep));
    const description = line.slice(sep + 3).trim();
    const m = name && description ? [line, name[1], description] : null;
    if (m) out.push({ command: m[1]!, description: m[2]!.slice(0, 256) });
  }
  return out;
}
