/**
 * Task-visibility helpers (v0.17): title derivation, message history and
 * display text. Pure functions; no I/O.
 */

import { cutPreview, stripBidiControls } from "./channels/notice.js";
import type { QuotaResetConfig } from "./quota.js";
import { redactPrompt } from "./redact.js";
import type { ProviderCallSpec, TaskMessage, TaskRecord, TaskStatus } from "./types.js";

/** Maximum stored title length, in characters. */
export const TITLE_MAX_CHARS = 80;

// C0 controls except TAB and LF, DEL, and C1 controls. CR is stripped too:
// a bare CR rewinds the terminal line and can hide text.
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
const CONTROL_CHARS_WITH_NEWLINES = /[\u0000-\u0008\u000A-\u001F\u007F-\u009F]/g;

/**
 * Remove control characters (C0 and C1, including ESC) from untrusted text
 * before it reaches a terminal or a hook line, so a prompt or a model reply
 * cannot inject terminal escape sequences. `multiline: true` keeps newlines
 * and tabs; otherwise every newline and tab becomes a space.
 */
export function stripControlChars(
  text: string,
  opts: { multiline?: boolean } = {},
): string {
  if (opts.multiline) return text.replace(CONTROL_CHARS, "");
  return text
    .replace(/[\t\n]/g, " ")
    .replace(CONTROL_CHARS_WITH_NEWLINES, "");
}

/**
 * Derive a task title: the first non-empty line of `text`, redacted with
 * the spec's patterns (or the defaults), control characters removed,
 * whitespace collapsed, cut to {@link TITLE_MAX_CHARS} with an ellipsis.
 * Returns undefined when nothing printable remains.
 */
export function deriveTitle(
  text: string,
  redactPatterns?: string[],
): string | undefined {
  const redacted = redactPrompt(text, redactPatterns);
  const firstLine =
    redacted
      .split(/\r?\n/)
      .map((l) => stripControlChars(l).replace(/\s+/g, " ").trim())
      .find((l) => l.length > 0) ?? "";
  if (firstLine.length === 0) return undefined;
  const chars = Array.from(firstLine);
  if (chars.length <= TITLE_MAX_CHARS) return firstLine;
  return `${chars.slice(0, TITLE_MAX_CHARS - 1).join("").trimEnd()}…`;
}

function parseSpec(bodyJson: string | undefined): Partial<ProviderCallSpec> | undefined {
  if (!bodyJson) return undefined;
  try {
    const spec = JSON.parse(bodyJson) as Partial<ProviderCallSpec> | null;
    return spec && typeof spec === "object" ? spec : undefined;
  } catch {
    return undefined;
  }
}

/** The stored prompt of a provider-call task (redacted once the task finished). */
export function taskPrompt(record: TaskRecord<unknown>): string | undefined {
  const spec = parseSpec(record.bodyJson);
  return typeof spec?.prompt === "string" ? spec.prompt : undefined;
}

/** The model's reply text of a completed provider-call task, when present. */
export function taskResultText(record: TaskRecord<unknown>): string | undefined {
  return resultString(record, "text");
}

/** A command job's summary (the reply of its summarize step), when the run has one. */
export function taskSummaryText(record: TaskRecord<unknown>): string | undefined {
  return resultString(record, "summary");
}

/** Why a command job's summarize step gave no summary, when it failed. */
export function taskSummaryError(record: TaskRecord<unknown>): string | undefined {
  return resultString(record, "summaryError");
}

function resultString(record: TaskRecord<unknown>, key: "text" | "summary" | "summaryError"): string | undefined {
  const r = record.result as Record<string, unknown> | null | undefined;
  const v = r && typeof r === "object" ? r[key] : undefined;
  return typeof v === "string" ? v : undefined;
}

/**
 * The task's full conversation, oldest first: prior turns stored in
 * `body_json.messages`, then the prompt as the user turn, then the result
 * text as the assistant turn when the task completed. A corrupt or
 * closure-task body yields an empty list.
 */
export function taskHistory(record: TaskRecord<unknown>): TaskMessage[] {
  const spec = parseSpec(record.bodyJson);
  if (!spec || typeof spec.prompt !== "string") return [];
  const out: TaskMessage[] = [];
  if (Array.isArray(spec.messages)) {
    for (const m of spec.messages) {
      if (
        m &&
        typeof m === "object" &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string"
      ) {
        out.push({ role: m.role, content: m.content });
      }
    }
  }
  out.push({ role: "user", content: spec.prompt });
  const reply = record.status === "completed" ? taskResultText(record) : undefined;
  if (reply !== undefined) out.push({ role: "assistant", content: reply });
  return out;
}

/**
 * Character budget of the history a reply sends (about 50k tokens), so a
 * long reply chain cannot grow a request past the provider's context.
 */
export const HISTORY_MAX_CHARS = 200_000;

/**
 * Drop the oldest turns, a user/assistant pair at a time, until the history
 * fits `maxChars`. The newest pair is always kept, and the result still
 * starts with a user turn, as every provider requires.
 */
export function capHistory(
  messages: TaskMessage[],
  maxChars: number = HISTORY_MAX_CHARS,
): TaskMessage[] {
  let start = 0;
  let total = messages.reduce((n, m) => n + m.content.length, 0);
  while (total > maxChars && messages.length - start > 2) {
    total -= messages[start]!.content.length;
    start++;
    // Keep the first kept turn a user turn.
    while (start < messages.length - 2 && messages[start]!.role !== "user") {
      total -= messages[start]!.content.length;
      start++;
    }
  }
  return start === 0 ? messages : messages.slice(start);
}

/**
 * Display label for a task's deadline kind (R21). `absolute` for a plain
 * deadline; `quota reset (claude)` for a quota deadline, extended with
 * `, reset_at <iso>, margin_h <n>` when `quota` has the label (the reset is
 * the stored deadline plus the margin configured now).
 */
export function deadlineKindLabel(
  record: Pick<TaskRecord<unknown>, "deadlineKind" | "quotaProvider" | "deadline">,
  quota: QuotaResetConfig = {},
): string {
  if (record.deadlineKind !== "quota_reset") return "absolute";
  const label = `quota reset (${record.quotaProvider ?? "unknown"})`;
  const schedule = quota[record.quotaProvider ?? ""];
  const deadlineMs = record.deadline ? Date.parse(record.deadline) : Number.NaN;
  if (!schedule || !Number.isFinite(deadlineMs)) return label;
  const resetAt = new Date(deadlineMs + schedule.marginH * 3_600_000);
  return `${label}, reset_at ${resetAt.toISOString()}, margin_h ${schedule.marginH}`;
}

/**
 * The actions a task's state allows (ui v2). Computed once here so the API,
 * the CLI, MCP and OpenClaw refuse the same things with the same rules.
 */
export interface TaskActions {
  /** Pending (queued, scheduled, submitted, running): cancel. */
  cancel: boolean;
  /** Pending occurrence of a repeating series: cancel it and end the series. */
  stopSeries: boolean;
  /** Queued or scheduled provider-call task: move its deadline, time or day. */
  reschedule: boolean;
  /** Queued or scheduled provider-call task: mark it due for the next tick. */
  runNow: boolean;
  /** Queued or scheduled provider-call task: move it later ("Later", same rule as `reschedule`). */
  later: boolean;
  /** Completed provider-call task: enqueue a reply child. */
  reply: boolean;
  /** Finished (completed or failed): mark read or unread. */
  markRead: boolean;
  /**
   * Failed provider-call one-off task, a `command` task included: retry it
   * by hand (due on the next tick). A run of a job, and a run that stopped
   * during its Batch submit, are refused.
   */
  retry: boolean;
}

/**
 * The error of a row whose Batch submit a forced stop interrupted (batch 25
 * KTD5). The provider may hold a batch for it, so no path runs it again:
 * `retryTask` and the Python `retry_task` refuse it, and the sweep does not
 * retry it. The text is the marker; `test/fixtures/interrupted-batch-submit.json`
 * shares it with the Python core. It lives here, not in `jobs.ts`, so this
 * module imports nothing from `jobs.ts` (which imports `deriveTitle` from here).
 */
export const BATCH_SUBMIT_INTERRUPTED_ERROR =
  "interrupted: the tick stopped during the Batch submit; the provider may have accepted the batch, so check the provider's batch list before you enqueue the task again";

const PENDING: ReadonlySet<TaskStatus> = new Set(["queued", "scheduled", "submitted", "running"]);

/** True when the task repeats (a stored rule other than `none`). */
export function isRepeating(record: Pick<TaskRecord<unknown>, "repeat">): boolean {
  return record.repeat !== undefined && record.repeat !== "none";
}

/** Allowed actions for `record`; see {@link TaskActions}. */
export function taskActions(record: TaskRecord<unknown>): TaskActions {
  const spec = parseSpec(record.bodyJson);
  const providerCall = spec?.type === "provider_call" && typeof spec.prompt === "string";
  const pending = PENDING.has(record.status);
  const movable = record.status === "queued" || record.status === "scheduled";
  return {
    cancel: pending,
    stopSeries: pending && isRepeating(record),
    reschedule: movable && providerCall,
    runNow: movable && providerCall,
    later: movable && providerCall,
    // A command job's occurrence has no conversation to continue.
    reply: record.status === "completed" && providerCall && spec?.provider !== "command",
    markRead: record.status === "completed" || record.status === "failed",
    // The same rule as `Scheduler.retryLater` refuses by.
    retry: record.status === "failed" && providerCall && !record.jobId && record.error !== BATCH_SUBMIT_INTERRUPTED_ERROR,
  };
}

/**
 * The title to show for a task: the stored title, else one derived from
 * the stored prompt with the task's redaction patterns (ui v2). Ledgers
 * written before titles existed have none stored.
 */
export function displayTitle(record: TaskRecord<unknown>): string | undefined {
  if (record.title) return record.title;
  const spec = parseSpec(record.bodyJson);
  if (typeof spec?.prompt !== "string") return undefined;
  return deriveTitle(spec.prompt, spec.redactInReceipt);
}

/**
 * A Claude Code session id we store (ui v2, KTD10): 8 to 128 letters,
 * digits, `-` or `_`. An unsubstituted `${CLAUDE_SESSION_ID}` literal fails.
 */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

/** True when `value` is a session id we accept (see {@link SESSION_ID_PATTERN}). */
export function isValidSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}

/** Quote one word for a POSIX shell; plain path characters stay as they are. */
export function shellQuote(word: string): string {
  if (/^[A-Za-z0-9_./+:@%-]+$/.test(word)) return word;
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * The command that returns to the Claude Code session a task came from:
 * `cd <cwd> && claude --resume <session>`, with the cwd shell-quoted and
 * control characters removed. Undefined unless both values exist and the
 * session id is valid.
 */
export function resumeCommand(
  record: Pick<TaskRecord<unknown>, "originCwd" | "originSessionId">,
): string | undefined {
  if (!record.originCwd || !isValidSessionId(record.originSessionId)) return undefined;
  const cwd = stripControlChars(record.originCwd);
  return `cd ${shellQuote(cwd)} && claude --resume ${record.originSessionId}`;
}

/** True when the task asked for receipt redaction (`redactInReceipt` with patterns): no result text and no attachment leaves the machine. */
export function isRedactedTask(record: TaskRecord<unknown>): boolean {
  const spec = parseSpec(record.bodyJson);
  return Array.isArray(spec?.redactInReceipt) && spec.redactInReceipt.length > 0;
}

/**
 * The file types a command run can attach: the stored extension, a label for
 * people, whether Telegram takes it as a photo, and whether the page shows
 * it inline (an SVG can hold script, so it is a download).
 */
export const ATTACHMENT_TYPES = {
  "image/png": { ext: "png", label: "PNG image", photo: true, inline: true },
  "image/jpeg": { ext: "jpg", label: "JPEG image", photo: true, inline: true },
  "image/webp": { ext: "webp", label: "WebP image", photo: true, inline: true },
  "image/gif": { ext: "gif", label: "GIF image", photo: false, inline: true },
  "application/pdf": { ext: "pdf", label: "PDF", photo: false, inline: false },
  "text/csv": { ext: "csv", label: "CSV", photo: false, inline: false },
  "text/plain": { ext: "txt", label: "text", photo: false, inline: false },
  "application/json": { ext: "json", label: "JSON", photo: false, inline: false },
  "image/svg+xml": { ext: "svg", label: "SVG image", photo: false, inline: false },
} as const;

export type AttachmentType = keyof typeof ATTACHMENT_TYPES;

/** One stored attachment of a run, as the result JSON holds it: `file` is `<n>.<ext>` in the task's attachment folder. */
export interface StoredAttachment {
  name: string;
  type: AttachmentType;
  bytes: number;
  file: string;
}

/** A file the command wrote that was not attached, and why. */
export interface SkippedAttachment {
  name: string;
  reason: string;
}

/** A stored attachment as a reader sees it: its 1-based index, and `expired` when its file is gone. */
export interface TaskAttachment extends StoredAttachment {
  index: number;
  expired?: boolean;
}

/** A file name for people: one line, no control or bidirectional characters, whitespace runs joined, at most 80 characters; "" when nothing is left. */
export function attachmentDisplayName(name: string): string {
  return cutPreview(stripBidiControls(stripControlChars(name)).replace(/\s+/g, " ").trim(), TITLE_MAX_CHARS);
}

function attachmentName(value: unknown): string | undefined {
  return typeof value === "string" ? attachmentDisplayName(value) || undefined : undefined;
}

function resultList(record: TaskRecord<unknown>, key: "attachments" | "attachmentsSkipped"): unknown[] {
  const r = record.result as Record<string, unknown> | null | undefined;
  const v = r && typeof r === "object" ? r[key] : undefined;
  return Array.isArray(v) ? v : [];
}

/**
 * The stored attachments of a completed run, in order. An entry whose shape
 * is wrong is left out; its `file` must be `<index>.<ext>` of its type, so
 * a reader never builds a path from anything else. With `exists` (whether
 * a `file` is still in the task's attachment folder), a file that is gone is
 * marked `expired`.
 */
export function taskAttachments(record: TaskRecord<unknown>, exists?: (file: string) => boolean): TaskAttachment[] {
  if (record.status !== "completed") return [];
  const out: TaskAttachment[] = [];
  resultList(record, "attachments").forEach((raw, i) => {
    const a = raw as Partial<StoredAttachment> | null;
    const name = attachmentName(a?.name);
    const type = a?.type;
    if (!a || !name || typeof type !== "string" || !Object.hasOwn(ATTACHMENT_TYPES, type)) return;
    const index = i + 1;
    const file = `${index}.${ATTACHMENT_TYPES[type as AttachmentType].ext}`;
    if (a.file !== file || typeof a.bytes !== "number" || !Number.isSafeInteger(a.bytes) || a.bytes < 0) return;
    const expired = exists !== undefined && !exists(file);
    out.push({ name, type: type as AttachmentType, bytes: a.bytes, file, index, ...(expired ? { expired: true } : {}) });
  });
  return out;
}

/** The files a completed run wrote that were not attached, with the reason. */
export function taskAttachmentsSkipped(record: TaskRecord<unknown>): SkippedAttachment[] {
  if (record.status !== "completed") return [];
  const out: SkippedAttachment[] = [];
  for (const raw of resultList(record, "attachmentsSkipped")) {
    const s = raw as Partial<SkippedAttachment> | null;
    const name = attachmentName(s?.name);
    const reason = attachmentName(s?.reason);
    if (name && reason) out.push({ name, reason });
  }
  return out;
}

/**
 * The attachments a channel may send: none for a task that redacts its
 * receipt, else the stored ones whose file is still there (with `exists`).
 * Every path that sends a file takes its list from here.
 */
export function sendableAttachments(record: TaskRecord<unknown>, exists?: (file: string) => boolean): TaskAttachment[] {
  if (isRedactedTask(record)) return [];
  return taskAttachments(record, exists).filter((a) => !a.expired);
}

/** A size for people: `512 B`, `48 KB`, `14 MB`, `1.5 MB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  // Below 1 MB but rounding to 1024 KB reads as `1 MB`.
  if (Math.round(bytes / 1024) < 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(Math.round((bytes / (1024 * 1024)) * 10) / 10).toString()} MB`;
}
