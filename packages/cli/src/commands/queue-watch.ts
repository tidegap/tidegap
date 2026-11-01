/**
 * `tidegap queue events | wait` — follow one task from a script or an agent
 * session. Both only read the ledger, with one exception: a `wait` that
 * printed a task's outcome records that the session was told (a `notified`
 * event, `via: "wait"`) and marks the task read, as `queue show` does.
 *
 * Every task string printed here is untrusted (prompts, model output) and
 * goes through `stripControlChars`.
 */

import {
  assessReadiness,
  formatTaskEvent,
  LAST_TICK_META_KEY,
  stripControlChars,
  taskResultText,
  TaskStore,
} from "@tidegap/core";
import type { TaskEvent, TaskRecord, TaskStatus } from "@tidegap/core";

import { UsageError } from "../handoff/session.js";
import { parseWhen } from "./queue.js";
import { defaultDbPath } from "./tick.js";

const TERMINAL: ReadonlySet<TaskStatus> = new Set(["completed", "failed", "cancelled"]);

/** How often `queue wait` checks the ledger for a change. */
export const WAIT_POLL_MS = 2_000;

/** Exit codes of `queue wait`: completed, failed or cancelled, usage or unknown id, timeout. */
export const WAIT_EXIT = { completed: 0, failed: 1, usage: 2, timeout: 3 } as const;

/** The result file a task asked for (`handoff.resultPath` of its body), or undefined. */
export function taskResultPath(record: Pick<TaskRecord<unknown>, "bodyJson">): string | undefined {
  if (!record.bodyJson) return undefined;
  try {
    const path = (JSON.parse(record.bodyJson) as { handoff?: { resultPath?: unknown } })?.handoff?.resultPath;
    return typeof path === "string" && path !== "" ? path : undefined;
  } catch {
    return undefined;
  }
}

/** One event in the JSON of `queue events`, with its cursor id. */
function eventJson(e: TaskEvent): { id: number; at: string; kind: string; actor: string; details: Record<string, unknown> } {
  return { id: e.id, at: e.at, kind: e.kind, actor: e.actor, details: e.details };
}

/** `<id> <at> <kind> by <actor>[ - <summary>]`, terminal-safe. */
function eventLine(e: TaskEvent): string {
  return stripControlChars(`${e.id} ${formatTaskEvent(e)}`);
}

function noTask(command: string, taskId: string): UsageError {
  return new UsageError(`${command}: no task with id ${JSON.stringify(taskId)}`);
}

export interface QueueEventsOptions {
  db?: string;
  json?: boolean;
  /** Only events with an id greater than this one (the cursor). */
  after?: string;
}

/**
 * `tidegap queue events <id>`: the task's events, oldest first, one line
 * each (`<id> <at> <kind> by <actor>`), or the JSON envelope with the task's
 * timing. Throws {@link UsageError} on an unknown id or a bad `--after`.
 */
export async function runQueueEvents(taskId: string, opts: QueueEventsOptions = {}): Promise<string> {
  let after = 0;
  if (opts.after !== undefined) {
    if (!/^\d+$/.test(opts.after.trim())) throw new UsageError("queue events: --after must be an event id (a whole number)");
    after = Number(opts.after.trim());
  }
  const store = new TaskStore({ dbPath: opts.db ?? defaultDbPath() });
  try {
    const record = store.get(taskId);
    if (!record) throw noTask("queue events", taskId);
    const events = store.listTaskEventsAfter(taskId, after);
    if (opts.json) {
      return JSON.stringify(
        {
          task_id: record.taskId,
          status: record.status,
          scheduled_for: record.scheduledFor ?? null,
          deadline: record.deadline ?? null,
          completed_at: record.completedAt ?? null,
          result_path: taskResultPath(record) ?? null,
          events: events.map(eventJson),
        },
        null,
        2,
      );
    }
    return events.map(eventLine).join("\n");
  } finally {
    store.close();
  }
}

export interface QueueWaitOptions {
  db?: string;
  /** A duration (`9m`, `2h`) or an ISO-8601 time; default: no limit. */
  timeout?: string;
  json?: boolean;
  /** Print each new event to stderr while waiting. */
  events?: boolean;
  /** Default true: record the notice and mark the task read once it printed the outcome. */
  markRead?: boolean;
  /** Tests: the clock, the sleep between polls, the poll interval and the stderr sink. */
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  stderr?: (line: string) => void;
  /** Tests: open the store (for a counting wrapper). */
  openStore?: (dbPath: string) => TaskStore;
}

export interface QueueWaitResult {
  exitCode: number;
  rendered: string;
}

/** The stdout of a finished wait: the result text (or error), then the result file line. */
function renderOutcome(record: TaskRecord<unknown>): string {
  const lines: string[] = [];
  if (record.status === "completed") {
    const text = taskResultText(record);
    if (text !== undefined) lines.push(stripControlChars(text, { multiline: true }));
    else if (record.result !== undefined) lines.push(stripControlChars(JSON.stringify(record.result, null, 2), { multiline: true }));
  } else if (record.status === "failed") {
    lines.push(`error: ${stripControlChars(record.error ?? "the task failed", { multiline: true })}`);
  } else {
    lines.push("cancelled");
  }
  const path = taskResultPath(record);
  if (path) lines.push(`result_path: ${stripControlChars(path)}`);
  return lines.join("\n");
}

function waitJson(record: TaskRecord<unknown>): string {
  return JSON.stringify(
    {
      task_id: record.taskId,
      status: record.status,
      result: record.status === "completed" ? (taskResultText(record) ?? record.result ?? null) : null,
      error: record.error ?? null,
      result_path: taskResultPath(record) ?? null,
      completed_at: record.completedAt ?? null,
    },
    null,
    2,
  );
}

/**
 * `tidegap queue wait <id>`: block until the task is completed, failed or
 * cancelled, then print its outcome. Polls every {@link WAIT_POLL_MS} and
 * reads the row only when the ledger's `data_version` changed. Exit codes:
 * {@link WAIT_EXIT}. Throws {@link UsageError} on an unknown id or a bad
 * `--timeout`.
 */
export async function runQueueWait(taskId: string, opts: QueueWaitOptions = {}): Promise<QueueWaitResult> {
  const now = opts.now ?? (() => new Date());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((ok) => setTimeout(ok, ms)));
  const stderr = opts.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const pollMs = opts.pollMs ?? WAIT_POLL_MS;
  const start = now();
  let deadline: number | undefined;
  if (opts.timeout !== undefined) {
    let at: Date;
    try {
      at = parseWhen(opts.timeout, start);
    } catch (err) {
      throw new UsageError(`queue wait: --timeout: ${(err as Error).message}`);
    }
    if (!(at.getTime() > start.getTime())) throw new UsageError("queue wait: --timeout must be in the future");
    deadline = at.getTime();
  }
  const dbPath = opts.db ?? defaultDbPath();
  const store = opts.openStore ? opts.openStore(dbPath) : new TaskStore({ dbPath });
  try {
    // The version before the first read: a commit between the two shows as a change.
    let version = store.dataVersion();
    let record = store.get(taskId);
    if (!record) throw noTask("queue wait", taskId);
    if (store.getMeta(LAST_TICK_META_KEY) === undefined) {
      const line = assessReadiness({ daemon: "unknown", lastTickAt: null, runners: null, pendingByProvider: {}, now: start }).line;
      if (line) stderr(stripControlChars(line));
    }
    let cursor = 0;
    if (opts.events) {
      const seen = store.listTaskEventsAfter(taskId, 0);
      cursor = seen.length > 0 ? seen[seen.length - 1]!.id : 0;
    }
    while (!TERMINAL.has(record.status)) {
      if (deadline !== undefined && now().getTime() >= deadline) {
        stderr(`queue wait: timed out; ${stripControlChars(taskId)} is still ${record.status}`);
        return { exitCode: WAIT_EXIT.timeout, rendered: opts.json ? waitJson(record) : "" };
      }
      const left = deadline !== undefined ? deadline - now().getTime() : pollMs;
      await sleep(Math.max(0, Math.min(pollMs, left)));
      const v = store.dataVersion();
      if (v === version) continue;
      version = v;
      record = store.get(taskId) ?? record;
      if (opts.events) {
        for (const e of store.listTaskEventsAfter(taskId, cursor)) {
          stderr(eventLine(e));
          cursor = e.id;
        }
      }
    }
    if (opts.markRead !== false) {
      try {
        if (record.originSessionId) store.claimNotice(taskId, { via: "wait", session_id: record.originSessionId }, "cli");
        store.markRead(taskId);
      } catch (err) {
        stderr(`queue wait: could not record that the outcome was read: ${stripControlChars((err as Error).message)}`);
      }
    }
    return {
      exitCode: record.status === "completed" ? WAIT_EXIT.completed : WAIT_EXIT.failed,
      rendered: opts.json ? waitJson(record) : renderOutcome(record),
    };
  } finally {
    store.close();
  }
}
