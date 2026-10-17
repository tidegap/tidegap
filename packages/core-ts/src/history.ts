/**
 * Task-visibility helpers (v0.17): title derivation, message history and
 * display text. Pure functions; no I/O.
 */

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
  const r = record.result as { text?: unknown } | undefined;
  return r && typeof r === "object" && typeof r.text === "string" ? r.text : undefined;
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
}

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
    reply: record.status === "completed" && providerCall,
    markRead: record.status === "completed" || record.status === "failed",
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
