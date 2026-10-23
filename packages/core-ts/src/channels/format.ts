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

import { displayTitle, stripControlChars, taskActions, taskResultText } from "../history.js";
import { JOB_AUTO_PAUSE_FAILURES } from "../jobs.js";
import { clip } from "../notify.js";
import { localTimeLabel, type PostponeOption, type PostponePreset } from "../postpone.js";
import { problemLine, TICKER_CODES, type ReadinessProblem } from "../readiness.js";
import { isValidTimeZone } from "../quota.js";
import { redactPrompt } from "../redact.js";
import { freshReasonText, shortSessionId } from "../run-session.js";
import type { JobCadence, JobRecord, ProviderCallSpec, TaskRecord } from "../types.js";
import { TELEGRAM_CALLBACK_MAX_BYTES, TELEGRAM_MESSAGE_MAX, type InlineKeyboard } from "./telegram.js";
import type { ChannelEvent, CleanWindowEvent } from "./types.js";

/** Characters of result text a done message previews (Q4). */
export const TELEGRAM_PREVIEW_CHARS = 600;

/** Most messages one `/result` sends before pointing to `tidegap queue show`. */
export const RESULT_MAX_PARTS = 4;

/** Tasks one `/queue` lists. */
export const QUEUE_LIST_MAX = 10;

/** Jobs one `/jobs` lists; the same cap as the digest's lists. */
export const JOBS_LIST_MAX = 10;

/** A message a host sends: text and optional inline buttons. */
export interface OutgoingMessage {
  text: string;
  buttons?: InlineKeyboard;
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

/** True when the task asked for receipt redaction (`redactInReceipt` with patterns): no result text leaves the machine. */
export function isRedactedTask(record: TaskRecord<unknown>): boolean {
  try {
    const spec = JSON.parse(record.bodyJson ?? "") as Partial<ProviderCallSpec>;
    return Array.isArray(spec.redactInReceipt) && spec.redactInReceipt.length > 0;
  } catch {
    return false;
  }
}

/** The title a message shows: `displayTitle`, one line, at most 80 characters, else the task id. */
export function messageTitle(record: TaskRecord<unknown>): string {
  const t = stripControlChars(displayTitle(record) ?? "").trim();
  return t ? clip(t, 80) : record.taskId;
}

/** Result text safe to send: default-redacted, control characters removed, newlines kept. */
function safeResult(record: TaskRecord<unknown>): string {
  return stripControlChars(redactPrompt(taskResultText(record) ?? "", undefined), { multiline: true }).trim();
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

/** Task done (R26): title, time, where it ran, the preview or the redaction note, and a [Result] button. */
export function taskDoneMessage(record: TaskRecord<unknown>, now: Date = new Date()): OutgoingMessage {
  const lines = [`Done: ${messageTitle(record)}`];
  const at = when(record.completedAt, now);
  if (at) lines.push(`Finished ${at}`);
  const ran = runSessionLine(record);
  if (ran) lines.push(ran);
  if (isRedactedTask(record)) {
    lines.push("", `The result is not sent here: this task redacts its receipt. Run \`${showCommand(record)}\`.`);
  } else {
    const preview = clip(safeResult(record), TELEGRAM_PREVIEW_CHARS);
    if (preview) lines.push("", preview);
  }
  const buttons = callbackFits(record.taskId) ? [[{ text: "Result", data: encodeCallback("result", record.taskId) }]] : undefined;
  return { text: lines.join("\n"), ...(buttons ? { buttons } : {}) };
}

/** Task failed: title, time, the first error line, the show command. No buttons. */
export function taskFailedMessage(record: TaskRecord<unknown>, now: Date = new Date()): OutgoingMessage {
  const lines = [`Failed: ${messageTitle(record)}`];
  const at = when(record.completedAt, now);
  if (at) lines.push(`Failed ${at}`);
  const firstErr = (record.error ?? "").split(/\r?\n/).find((l) => l.trim()) ?? "unknown error";
  lines.push(clip(stripControlChars(redactPrompt(firstErr, undefined)).trim(), 300));
  lines.push(`Run \`${showCommand(record)}\`.`);
  return { text: lines.join("\n") };
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
      return taskDoneMessage(event.task, now);
    case "task_failed":
      return taskFailedMessage(event.task, now);
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

/** `HH:MM` in `timeZone` when `at` falls on the same day there as `now`, else `Ddd HH:MM`. */
export function zoneTimeLabel(at: Date, now: Date, timeZone: string): string {
  const parts = (d: Date) => {
    // An unknown zone falls back to the system zone.
    const fmt = new Intl.DateTimeFormat("en-US", { timeZone: isValidTimeZone(timeZone) ? timeZone : undefined, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
    return { day: `${p.year}-${p.month}-${p.day}`, weekday: p.weekday!, time: `${p.hour}:${p.minute}` };
  };
  const a = parts(at);
  return a.day === parts(now).day ? a.time : `${a.weekday} ${a.time}`;
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
  if (reason.startsWith("auto: ")) {
    return `paused after ${job.consecutiveFailures || JOB_AUTO_PAUSE_FAILURES} failures: ${safe(reason.slice(6))}`;
  }
  return `paused: ${safe(reason)}`;
}

/** One `/jobs` line without its number. */
function jobLine(job: JobRecord, taskOf: (id: string) => TaskRecord<unknown> | undefined, now: Date): string {
  if (job.status === "paused") return `${jobTitle(job)} - ${pausedText(job)}`;
  const parts = [jobTitle(job)];
  parts.push(job.window ? `${cadenceText(job.cadence)} ${job.window.start}-${job.window.end}` : cadenceText(job.cadence));
  const next = jobNextLabel(job, job.pendingTaskId ? taskOf(job.pendingTaskId) : undefined, now);
  if (next) parts.push(next === JOB_RUNNING_NOW ? next : `next ${next}`);
  if (job.lastOutcome) {
    const last = job.lastTaskId ? taskOf(job.lastTaskId) : undefined;
    const at = when(last?.completedAt ?? job.lastRunStartedAt, now, (t) => zoneTimeLabel(t, now, job.timeZone));
    const count = job.lastOutcome === "failed" && job.consecutiveFailures > 0 ? ` (${job.consecutiveFailures} of ${JOB_AUTO_PAUSE_FAILURES})` : "";
    parts.push(`last ${job.lastOutcome}${at ? ` ${at}` : ""}${count}`);
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
 * `/result` and the Result button (R27): no result text for a redacted
 * task; otherwise the result in parts of 4096 characters, at most
 * {@link RESULT_MAX_PARTS}, then a pointer to `tidegap queue show`.
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
  if (!body) return [{ text: `${title}\nThe result is empty.` }];
  const max = TELEGRAM_MESSAGE_MAX - 100;
  const parts = splitMessage(body, max);
  const out = parts.slice(0, RESULT_MAX_PARTS).map((p) => ({ text: p }));
  out[0] = { text: `${title}\n\n${out[0]!.text}` };
  if (parts.length > RESULT_MAX_PARTS) out.push({ text: `The result is longer. Run \`${showCommand(record)}\` for the rest.` });
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
