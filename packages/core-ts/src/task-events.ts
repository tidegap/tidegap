/**
 * Task events (audit trail): one row per change of a task, in the ledger's
 * `task_events` table, written in the same transaction as the task write.
 * Shared by both cores; the Python core writes `dispatched`, `completed`,
 * `failed` and `cancelled` rows with the same shape.
 */

import type { TaskRecord } from "./types.js";

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
