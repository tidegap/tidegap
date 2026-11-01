/**
 * `tidegap queue events | wait | notices` — follow handed-off tasks from a
 * script or an agent session. `events` only reads the ledger. A `wait` that
 * printed a task's outcome, and `notices` once it printed a session's
 * notice, record that the session was told (a `notified` event) and mark
 * the task read, as `queue show` does.
 *
 * Every task string printed here is untrusted (prompts, model output) and
 * goes through `stripControlChars`.
 */

import { existsSync } from "node:fs";

import {
  assessReadiness,
  formatTaskEvent,
  isValidSessionId,
  LAST_TICK_META_KEY,
  latestResultFile,
  resultFileText,
  stripControlChars,
  taskResultText,
  TaskStore,
  tickIntervalFor,
} from "@tidegap/core";
import type { TaskEvent, TaskRecord, TaskStatus } from "@tidegap/core";

import { noticesDir, removeNoticeMarker, renderNoticeBlock } from "../handoff/notices.js";
import { requireOwnSession, resolveSessionArg, UsageError, type SessionSources } from "../handoff/session.js";
import { daemonStatus, type DaemonStatus } from "../platform/index.js";
import { hookSessionId, parseWhen } from "./queue.js";
import { defaultDbPath, tickRunning } from "./tick.js";

const TERMINAL: ReadonlySet<TaskStatus> = new Set(["completed", "failed", "cancelled"]);

/** How often `queue wait` checks the ledger for a change. */
export const WAIT_POLL_MS = 2_000;

/**
 * Exit codes of `queue wait`: completed (with its result file written, when
 * it asked for one); failed, cancelled or the result file not written;
 * usage (or an unknown id, or a ledger it cannot read); timeout.
 */
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

/** A ledger file that does not exist holds no task: say so instead of creating an empty one. */
function requireLedger(command: string, taskId: string, dbPath: string): void {
  if (dbPath !== ":memory:" && !existsSync(dbPath)) throw noTask(command, taskId);
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
  const dbPath = opts.db ?? defaultDbPath();
  requireLedger("queue events", taskId, dbPath);
  const store = new TaskStore({ dbPath });
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
  /** Tests: whether the tick daemon's unit file is on disk; default probes it. */
  daemon?: DaemonStatus;
}

export interface QueueWaitResult {
  exitCode: number;
  rendered: string;
}

/** The stdout of a finished wait: the result text (or error), then the result file line. */
function renderOutcome(record: TaskRecord<unknown>, resultFile: Record<string, unknown> | undefined): string {
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
  if (path) {
    const state = record.status !== "completed" || resultFile?.written === true ? "" : ` (${resultFileText(resultFile)})`;
    lines.push(`result_path: ${stripControlChars(path)}${stripControlChars(state)}`);
  }
  return lines.join("\n");
}

function waitJson(record: TaskRecord<unknown>, resultFile: Record<string, unknown> | undefined): string {
  return JSON.stringify(
    {
      task_id: record.taskId,
      status: record.status,
      result: record.status === "completed" ? (taskResultText(record) ?? record.result ?? null) : null,
      error: record.error ?? null,
      result_path: taskResultPath(record) ?? null,
      result_file: resultFile ?? null,
      completed_at: record.completedAt ?? null,
    },
    null,
    2,
  );
}

/** True when a wait on `record` also waits for its result file: it completed and asked for one. */
function needsResultFile(record: TaskRecord<unknown>): boolean {
  return record.status === "completed" && taskResultPath(record) !== undefined;
}

/** The stderr line of a wait whose result file a Node tick has not written one tick interval after the task completed. */
function resultFileWaitHint(taskId: string, daemon: DaemonStatus): string {
  const fix =
    daemon === "installed" ? "Run `tidegap tick --once` and check the error." : "Run `tidegap tick --once`, or `tidegap install` to start the tick daemon.";
  return `queue wait: ${stripControlChars(taskId)} is completed, but its result file waits for a Node tick. ${fix}`;
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
  requireLedger("queue wait", taskId, dbPath);
  const store = opts.openStore ? opts.openStore(dbPath) : new TaskStore({ dbPath });
  try {
    // The version before the first read: a commit between the two shows as a change.
    let version = store.dataVersion();
    const first = store.get(taskId);
    if (!first) throw noTask("queue wait", taskId);
    let record: TaskRecord<unknown> = first;
    if (store.getMeta(LAST_TICK_META_KEY) === undefined) {
      const line = assessReadiness({ daemon: "unknown", lastTickAt: null, runners: null, pendingByProvider: {}, now: start }).line;
      if (line) stderr(stripControlChars(line));
    }
    let cursor = 0;
    if (opts.events) {
      const seen = store.listTaskEventsAfter(taskId, 0);
      cursor = seen.length > 0 ? seen[seen.length - 1]!.id : 0;
    }
    // A completed task that asked for a result file is done once the tick
    // recorded the file's outcome.
    const fileEvent = () => latestResultFile(store.listTaskEventsAfter(taskId, 0));
    let resultFile = needsResultFile(record) ? fileEvent() : undefined;
    const finished = () => TERMINAL.has(record.status) && (!needsResultFile(record) || resultFile !== undefined);
    // Only a Node tick writes result files, also for rows the Python core completed.
    const daemon = opts.daemon ?? daemonStatus();
    const intervalMs = tickIntervalFor(daemon) * 1000;
    let completedSeenAt: number | undefined;
    let hinted = false;
    const hintIfNoTick = () => {
      if (hinted || !needsResultFile(record) || resultFile !== undefined) return;
      const at = now();
      const t = at.getTime();
      const completedAt = Date.parse(record.completedAt ?? "");
      const since = Number.isFinite(completedAt) ? completedAt : (completedSeenAt ??= t);
      if (t - since <= intervalMs) return;
      // A running tick writes the file at its end, after its other tasks.
      if (tickRunning(dbPath, at)) return;
      // A tick that ended since the last poll may have recorded the file just now.
      resultFile = fileEvent();
      if (resultFile !== undefined) return;
      hinted = true;
      stderr(resultFileWaitHint(taskId, daemon));
    };
    while (!finished()) {
      hintIfNoTick();
      if (finished()) break;
      if (deadline !== undefined && now().getTime() >= deadline) {
        const state = TERMINAL.has(record.status) ? `${record.status}; its result file is not written yet` : `still ${record.status}`;
        stderr(`queue wait: timed out; ${stripControlChars(taskId)} is ${state}`);
        return { exitCode: WAIT_EXIT.timeout, rendered: opts.json ? waitJson(record, undefined) : "" };
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
      if (needsResultFile(record)) resultFile = fileEvent();
    }
    const fileFailed = needsResultFile(record) && resultFile?.written !== true;
    if (fileFailed) stderr(`queue wait: the result file was not written: ${stripControlChars(resultFileText(resultFile))}`);
    if (opts.markRead !== false) {
      try {
        if (record.originSessionId) store.claimNotice(taskId, { via: "wait", session_id: record.originSessionId }, "cli");
        store.markRead(taskId);
      } catch (err) {
        stderr(`queue wait: could not record that the outcome was read: ${stripControlChars((err as Error).message)}`);
      }
    }
    return {
      exitCode: record.status === "completed" && !fileFailed ? WAIT_EXIT.completed : WAIT_EXIT.failed,
      rendered: opts.json ? waitJson(record, resultFile) : renderOutcome(record, resultFile),
    };
  } finally {
    store.close();
  }
}

/**
 * `queue notices --hook` prints and claims nothing new this long after its
 * process started. The hook's timeout is 10 s, and Claude Code drops the
 * output of a hook that runs over it, so every claim must leave time to exit.
 */
export const NOTICE_HOOK_DEADLINE_MS = 5_000;
/** How long `queue notices --hook` waits for a busy ledger. */
const NOTICE_HOOK_BUSY_MS = 1_000;

export interface QueueNoticesOptions {
  db?: string;
  /** The session: an id or `current` (default). Ignored with `hook`. */
  session?: string;
  /** Claude Code `UserPromptSubmit` mode: the session comes from `hookInput`; never fails, prints only the notice. */
  hook?: boolean;
  /** The hook's stdin JSON. */
  hookInput?: string;
  /** Print without claiming or marking read (any session). */
  peek?: boolean;
  /** Where the notice goes; default stdout. Called before anything is claimed. */
  print?: (text: string) => void;
  /** When the deadline of `hook` starts, in epoch ms; default now. The CLI passes its process start. */
  startedAt?: number;
  /** Tests: the clock, the session sources and the markers folder. */
  now?: () => Date;
  sessionSources?: SessionSources;
  dir?: string;
}

export interface QueueNoticesResult {
  rendered: string;
  /** Tasks this call claimed. */
  claimed: string[];
}

/**
 * `tidegap queue notices`: print the notice of a session's finished tasks,
 * then claim each printed task (`notified`, `via: "prompt"` from the hook,
 * `"cli"` otherwise), mark it read and remove the session's marker once
 * nothing is left. `--hook` trusts the `session_id` of its input (the
 * plugin hook's), and stops once {@link NOTICE_HOOK_DEADLINE_MS} passed since
 * `startedAt` (the process start): before the print it prints nothing, after it it
 * claims no more, so a notice whose output Claude Code may drop comes back
 * on the next prompt. Throws {@link UsageError} outside `--hook` when the
 * session is not this one (without `--peek`).
 */
export async function runQueueNotices(opts: QueueNoticesOptions = {}): Promise<QueueNoticesResult> {
  const now = opts.now ?? (() => new Date());
  const startedAt = opts.startedAt ?? now().getTime();
  const late = (): boolean => opts.hook === true && now().getTime() - startedAt > NOTICE_HOOK_DEADLINE_MS;
  const print = opts.print ?? ((text: string) => console.log(text)); // eslint-disable-line no-console
  const none: QueueNoticesResult = { rendered: "", claimed: [] };
  const dir = opts.dir ?? noticesDir();
  let sessionId: string | undefined;
  if (opts.hook) {
    sessionId = hookSessionId(opts.hookInput);
    if (!sessionId || !isValidSessionId(sessionId)) return none;
  } else if (opts.peek) {
    sessionId = resolveSessionArg("queue notices", opts.session ?? "current", opts.sessionSources);
  } else {
    sessionId = requireOwnSession("queue notices", opts.session ?? "current", opts.sessionSources).sessionId;
  }
  const dbPath = opts.db ?? defaultDbPath();
  // Do not create a ledger just to say there is nothing in it.
  if (dbPath !== ":memory:" && !existsSync(dbPath)) return none;
  let store: TaskStore | undefined;
  try {
    store = new TaskStore({ dbPath, ...(opts.hook ? { busyTimeoutMs: NOTICE_HOOK_BUSY_MS } : {}) });
    const notices = store.listSessionNotices({ sessionId, now: now() });
    if (late()) return none;
    const { text: rendered, listed } = renderNoticeBlock(notices);
    if (!rendered) {
      if (!opts.peek) removeNoticeMarker(sessionId, dir);
      return none;
    }
    print(rendered);
    if (opts.peek) return { rendered, claimed: [] };
    const via = opts.hook ? "prompt" : "cli";
    const actor = opts.hook ? "agent:claude-code" : "cli";
    const claimed: string[] = [];
    for (const n of notices.slice(0, listed)) {
      // Too late to be sure the output arrives: the rest stays for the next prompt.
      if (late()) return { rendered, claimed };
      if (store.claimNotice(n.record.taskId, { via, session_id: sessionId }, actor)) claimed.push(n.record.taskId);
      store.markRead(n.record.taskId);
    }
    if (!late() && store.listSessionNotices({ sessionId, now: now() }).length === 0) removeNoticeMarker(sessionId, dir);
    return { rendered, claimed };
  } catch (err) {
    if (opts.hook) return none;
    throw err;
  } finally {
    try {
      store?.close();
    } catch {
      // ignore
    }
  }
}
