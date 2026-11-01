/**
 * Task events (audit trail): one row per change of a task, in the ledger's
 * `task_events` table, written in the same transaction as the task write.
 * Shared by both cores; the Python core writes `dispatched`, `completed`,
 * `failed` and `cancelled` rows with the same shape.
 */

import { includesWebTool } from "./claude-tools.js";
import { stripControlChars } from "./history.js";
import type { ProviderCallSpec, TaskRecord } from "./types.js";

export const TASK_EVENT_KINDS = [
  "created",
  "rescheduled",
  "postponed",
  "expedited",
  "cancelled",
  "dispatched",
  "completed",
  "failed",
  "deferred",
  "replied",
  // A Claude Code session was told the task finished (its prompt hook, a
  // `queue wait` that printed the result, or a wake). At most one per finish:
  // details carry the task's `completed_at`.
  "notified",
  // The tick wrote the task's result file, or could not (`written: false`
  // with the error). At most one per task.
  "result_file",
  // A line a long `command` run printed while it ran (`line`, `seq`), within
  // the caps of `createProgressRecorder`.
  "progress",
] as const;

export type TaskEventKind = (typeof TASK_EVENT_KINDS)[number];

/**
 * Who made the change: `agent:<host>`, `page`, `client:<name>`, `cli`,
 * `tick`, `telegram`, `openclaw` or `system`.
 */
export type TaskEventActor = string;

export interface TaskEvent {
  id: number;
  taskId: string;
  /** ISO-8601. */
  at: string;
  kind: TaskEventKind;
  actor: TaskEventActor;
  /** snake_case keys: `from` / `to` timing, `reason`, `preset`, `provider`, `model`, `error`… */
  details: Record<string, unknown>;
}

/** An event to write with a task change; `taskId` and `at` come from the write. */
export interface TaskEventInput {
  kind: TaskEventKind;
  actor?: TaskEventActor;
  details?: Record<string, unknown>;
}

const FIXED_ACTORS: ReadonlySet<string> = new Set(["page", "cli", "tick", "telegram", "openclaw", "system"]);
const NAME_MAX = 64;

/**
 * A valid actor string, or `system`. `agent:` and `client:` names lose
 * control characters and are cut to 64 characters. Never throws: an audit
 * write must not block a task action.
 */
export function normalizeActor(actor: unknown): TaskEventActor {
  if (typeof actor !== "string") return "system";
  if (FIXED_ACTORS.has(actor)) return actor;
  const m = /^(agent|client):(.*)$/s.exec(actor);
  if (!m) return "system";
  // eslint-disable-next-line no-control-regex
  const name = m[2]!.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, NAME_MAX);
  return name ? `${m[1]}:${name}` : "system";
}

export function isTaskEventKind(kind: unknown): kind is TaskEventKind {
  return typeof kind === "string" && (TASK_EVENT_KINDS as readonly string[]).includes(kind);
}

type Timing = { scheduled_for: string | null; not_before: string | null; deadline: string | null };

function timing(r: TaskRecord<unknown>): Timing {
  return { scheduled_for: r.scheduledFor ?? null, not_before: r.notBefore ?? null, deadline: r.deadline ?? null };
}

/**
 * The run facts of a `created` or `dispatched` event. Every `claude-code`
 * row gets its planned mode: `fork` when it can run in a copy of its origin
 * session (a checked origin, which a job occurrence never has, no web
 * tool, and its folder is the session's), else `fresh`; the receipt's `session` records
 * what the run did. A `claude-code` row with handoff fields also gets its
 * profile, tools and folder, and a one-off command its folder. Empty for
 * every other row.
 */
function handoffDetails(r: TaskRecord<unknown>): Record<string, unknown> {
  if (!r.bodyJson) return {};
  let spec: ProviderCallSpec;
  try {
    spec = JSON.parse(r.bodyJson) as ProviderCallSpec;
  } catch {
    return {};
  }
  if (spec?.provider === "command" && spec.command?.origin === "cli") return { cwd: spec.command.cwd ?? null };
  if (spec?.provider !== "claude-code") return {};
  const handoff = spec.handoff && typeof spec.handoff === "object" ? spec.handoff : undefined;
  const tools = Array.isArray(spec.tools) ? spec.tools : null;
  const cwd = typeof handoff?.cwd === "string" ? handoff.cwd : null;
  const fork =
    spec.origin?.agent === "claude-code" &&
    !!r.originSessionId &&
    !!r.originCwd &&
    !(tools && includesWebTool(tools)) &&
    (cwd === null || cwd === r.originCwd);
  const planned_mode = fork ? "fork" : "fresh";
  if (!handoff) return { planned_mode };
  return { profile: handoff.profile ?? null, tools, cwd, planned_mode };
}

function providerModel(bodyJson: string | undefined): Record<string, unknown> {
  if (!bodyJson) return {};
  try {
    const spec = JSON.parse(bodyJson) as { provider?: unknown; model?: unknown };
    return {
      ...(typeof spec.provider === "string" ? { provider: spec.provider } : {}),
      ...(typeof spec.model === "string" ? { model: spec.model } : {}),
    };
  } catch {
    return {};
  }
}

const MOVE_KINDS: ReadonlySet<TaskEventKind> = new Set(["rescheduled", "postponed", "expedited"]);
const SPEC_KINDS: ReadonlySet<TaskEventKind> = new Set(["created", "dispatched", "completed", "failed"]);

/**
 * The details of one event: `from` / `to` timing for moves and run-now,
 * provider and model for created / dispatched / completed / failed, the
 * first line of the error for failed, then `extra`.
 */
export function eventDetails(
  kind: TaskEventKind,
  prev: TaskRecord<unknown> | undefined,
  next: TaskRecord<unknown>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (MOVE_KINDS.has(kind)) {
    if (prev) out.from = timing(prev);
    out.to = timing(next);
  }
  if (kind === "created") {
    const t = timing(next);
    if (t.deadline) out.deadline = t.deadline;
    if (t.not_before) out.not_before = t.not_before;
  }
  if (SPEC_KINDS.has(kind)) Object.assign(out, providerModel(next.bodyJson));
  if (kind === "created" || kind === "dispatched") Object.assign(out, handoffDetails(next));
  if (kind === "failed" && next.error) out.error = next.error.split("\n")[0]!.slice(0, 300);
  return { ...out, ...extra };
}

/** The kind a status change implies when the writer named none (terminal moves only). */
export function impliedEventKind(prevStatus: string, nextStatus: string): TaskEventKind | undefined {
  if (prevStatus === nextStatus) return undefined;
  if (nextStatus === "completed" || nextStatus === "failed" || nextStatus === "cancelled") return nextStatus;
  return undefined;
}

function short(iso: unknown): string {
  return typeof iso === "string" ? iso : "none";
}

/** A one-line summary of the details, or "". */
export function eventSummary(e: Pick<TaskEvent, "kind" | "details">): string {
  const d = e.details ?? {};
  const from = (d.from ?? {}) as Partial<Timing>;
  const to = (d.to ?? {}) as Partial<Timing>;
  const parts: string[] = [];
  switch (e.kind) {
    case "expedited":
      parts.push(`not_before was ${short(from.not_before)}`, `scheduled_for ${short(from.scheduled_for)} -> ${short(to.scheduled_for)}`);
      break;
    case "rescheduled":
    case "postponed":
      if (typeof d.preset === "string") parts.push(`preset ${d.preset}`);
      parts.push(`scheduled_for ${short(from.scheduled_for)} -> ${short(to.scheduled_for)}`);
      if (from.not_before !== to.not_before) parts.push(`not_before ${short(from.not_before)} -> ${short(to.not_before)}`);
      break;
    case "deferred":
      parts.push(`retry at ${short(d.retry_at)}`);
      break;
    case "replied":
      parts.push(`reply ${short(d.child_task_id)}`);
      break;
    case "notified":
      parts.push(`via ${short(d.via)}`);
      break;
    case "result_file":
      parts.push(d.written === true ? `written ${short(d.path)}` : `not written: ${short(d.error)}`);
      break;
    case "progress":
      if (typeof d.line === "string") parts.push(d.line);
      break;
    case "failed":
      if (typeof d.error === "string") parts.push(d.error);
      break;
    default:
      if (typeof d.provider === "string") parts.push(`${d.provider}${typeof d.model === "string" ? `/${d.model}` : ""}`);
  }
  if (typeof d.reason === "string") parts.push(d.reason);
  return parts.join("; ");
}

/** `<at> <kind> by <actor>[ - <summary>]`, one line. */
export function formatTaskEvent(e: Pick<TaskEvent, "at" | "kind" | "actor" | "details">): string {
  const summary = eventSummary(e);
  return `${e.at} ${e.kind} by ${e.actor}${summary ? ` - ${summary}` : ""}`;
}

/** The API / JSON shape of one event. */
export function taskEventJson(e: TaskEvent): { at: string; kind: TaskEventKind; actor: string; details: Record<string, unknown> } {
  return { at: e.at, kind: e.kind, actor: e.actor, details: e.details };
}

/** A run reports no progress in its first 5 seconds: a fast run writes none. */
export const PROGRESS_QUIET_MS = 5_000;
/** At most one progress event per 15 seconds. */
export const PROGRESS_GAP_MS = 15_000;
/** At most 24 progress events per task, so its `created` event stays inside a page of 50. */
export const PROGRESS_MAX_EVENTS = 24;
/** Longest progress line. */
export const PROGRESS_LINE_MAX_CHARS = 200;

/** Terminal escape sequences (CSI, OSC and two-character escapes): removed whole, not only their ESC. */
const TERMINAL_ESCAPES = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-Z\\-_]/g;
/** Line and paragraph separators (become a space) and bidirectional controls (removed). */
const LINE_SEPARATORS = /[\u2028\u2029]/g;
const BIDI_CONTROLS = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
/** The most of a raw line {@link progressLine} reads, so a huge line costs no more than this. */
const PROGRESS_SCAN_CHARS = 8_192;

/**
 * Untrusted output text without terminal escape sequences, control
 * characters (a tab becomes a space), line separators or bidirectional
 * controls. An adapter cleans a line with this before it scrubs secrets, so
 * a removed character cannot join a secret after the scrub.
 */
export function cleanProgressText(raw: string): string {
  return stripControlChars(raw.replace(TERMINAL_ESCAPES, "").replace(LINE_SEPARATORS, " ").replace(BIDI_CONTROLS, ""));
}

/**
 * One progress line as it is stored: cleaned by {@link cleanProgressText},
 * trailing space trimmed, cut to {@link PROGRESS_LINE_MAX_CHARS}
 * characters. Undefined for a blank line.
 */
export function progressLine(raw: string): string | undefined {
  const clean = cleanProgressText(raw.length > PROGRESS_SCAN_CHARS ? raw.slice(0, PROGRESS_SCAN_CHARS) : raw).trimEnd();
  if (clean.trim() === "") return undefined;
  const chars = Array.from(clean);
  return chars.length > PROGRESS_LINE_MAX_CHARS ? chars.slice(0, PROGRESS_LINE_MAX_CHARS).join("") : clean;
}

/** The `progress` callback of one run and its end. */
export interface ProgressRecorder {
  /** A line the run printed. Lines that come while no slot is open replace each other; the newest is written when one opens. */
  onLine(line: string): void;
  /** The run ended: a line still waiting for its slot is dropped, and nothing is written after this. */
  close(): void;
}

/**
 * The caps of a run's progress events, for every adapter: nothing in the
 * first {@link PROGRESS_QUIET_MS}, then at most one event per
 * {@link PROGRESS_GAP_MS} and {@link PROGRESS_MAX_EVENTS} per task, each line
 * cleaned by {@link progressLine}. A line that comes before its slot waits
 * for it, and a newer line takes its place, so the event shows the newest
 * line. `write` gets the details of each event (`line`, `seq`); `seq`
 * counts the task's progress events from 1, after the `existing` ones (read
 * once, when the first event is due). The caller scrubs secrets from each
 * line first. Never throws.
 */
export function createProgressRecorder(
  write: (details: { line: string; seq: number }) => void,
  opts: { existing?: () => number } = {},
): ProgressRecorder {
  const started = Date.now();
  let count: number | undefined;
  let lastAt: number | undefined;
  let pending: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const written = (): number => {
    if (count === undefined) {
      try {
        count = Math.max(0, Math.floor(opts.existing?.() ?? 0));
      } catch {
        count = 0;
      }
    }
    return count;
  };
  const flush = (): void => {
    timer = undefined;
    const line = pending;
    pending = undefined;
    if (closed || line === undefined || written() >= PROGRESS_MAX_EVENTS) return;
    const seq = written() + 1;
    count = seq;
    lastAt = Date.now();
    try {
      write({ line, seq });
    } catch {
      // A busy ledger costs this line, not the run.
    }
  };
  return {
    onLine(raw: string): void {
      if (closed || (count !== undefined && count >= PROGRESS_MAX_EVENTS)) return;
      const line = progressLine(raw);
      if (line === undefined) return;
      pending = line;
      if (timer !== undefined) return;
      const due = Math.max(started + PROGRESS_QUIET_MS, lastAt !== undefined ? lastAt + PROGRESS_GAP_MS : 0);
      const wait = due - Date.now();
      if (wait <= 0) return flush();
      timer = setTimeout(flush, wait);
      (timer as { unref?: () => void }).unref?.();
    },
    close(): void {
      closed = true;
      pending = undefined;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}
