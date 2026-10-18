/**
 * Bot commands and button presses (KTD15, R27): parse text and callback
 * data into typed commands, then run them through the same `Scheduler`
 * methods the page uses. Every write re-reads the task and checks it is
 * still in a state that allows the action; a `/queue` number resolves only
 * against the last listing and expires after {@link LISTING_TTL_MS}.
 */

import { taskActions } from "../history.js";
import {
  localTimeLabel,
  NEEDS_RESET_TIME,
  type PostponeOption,
  type PostponePreset,
  type PostponeTarget,
} from "../postpone.js";
import type { Scheduler } from "../scheduler.js";
import type { TaskStore } from "../storage/sqlite.js";
import type { TaskRecord, TaskStatus } from "../types.js";
import {
  CALLBACK_ACTIONS,
  CALLBACK_PRESETS,
  HELP_TEXT,
  LATER_GRAMMAR,
  laterMenuMessage,
  messageTitle,
  QUEUE_LIST_MAX,
  queueMessage,
  resultMessages,
  type CallbackActionName,
  type OutgoingMessage,
} from "./format.js";

/** `/queue` numbers expire after this long (R27). */
export const LISTING_TTL_MS = 10 * 60_000;

/** A task named by its `/queue` number or by its id. */
export type TaskRef = { n: number } | { id: string };

/** The `/later` argument (KTD15 Telegram column). `HH:MM` is local time, the next such time after now. */
export type LaterArg =
  | { preset: Exclude<PostponePreset, "after_limit_reset"> }
  | { preset: "after_limit_reset"; resetClock?: string }
  | { clock: string };

export type ChannelCommand =
  | { kind: "help" }
  | { kind: "queue" }
  /** `/pair <code>` or the deep-link form `/start <code>`. */
  | { kind: "pair"; code?: string }
  | { kind: "later"; ref: TaskRef; arg: LaterArg }
  | { kind: "cancel"; ref: TaskRef }
  | { kind: "run"; ref: TaskRef }
  | { kind: "result"; ref: TaskRef }
  /** A known command with bad arguments; `reply` says how to use it. */
  | { kind: "invalid"; reply: string }
  | { kind: "unknown" };

const CLOCK = /^([01]?\d|2[0-3]):([0-5]\d)$/;

function parseRef(word: string | undefined): TaskRef | undefined {
  if (!word) return undefined;
  if (/^\d{1,3}$/.test(word)) return { n: Number(word) };
  return /^[A-Za-z0-9_~.-]{1,100}$/.test(word) ? { id: word } : undefined;
}

function refLabel(ref: TaskRef): string {
  return "n" in ref ? String(ref.n) : ref.id;
}

function parseLaterArg(words: string[]): LaterArg | undefined {
  const [w, extra] = words.map((x) => x.toLowerCase());
  if (w === "1h" && extra === undefined) return { preset: "1h" };
  if (w === "tonight" && extra === undefined) return { preset: "tonight" };
  if (w === "tomorrow" && extra === undefined) return { preset: "tomorrow_morning" };
  if (w === "reset") {
    if (extra === undefined) return { preset: "after_limit_reset" };
    return CLOCK.test(extra) && words.length === 2 ? { preset: "after_limit_reset", resetClock: extra } : undefined;
  }
  if (w !== undefined && CLOCK.test(w) && extra === undefined) return { clock: w };
  return undefined;
}

/** Parse a message text. A text that is not a command is `unknown`. */
export function parseCommand(text: string): ChannelCommand {
  const words = text.trim().split(/\s+/);
  const head = words.shift() ?? "";
  if (!head.startsWith("/")) return { kind: "unknown" };
  const name = head.slice(1).split("@")[0]!.toLowerCase();
  switch (name) {
    case "help":
      return { kind: "help" };
    case "queue":
      return { kind: "queue" };
    case "start":
    case "pair":
      return words[0] ? { kind: "pair", code: words[0] } : { kind: "pair" };
    case "later": {
      const ref = parseRef(words[0]);
      const arg = parseLaterArg(words.slice(1));
      return ref && arg ? { kind: "later", ref, arg } : { kind: "invalid", reply: `Usage: ${LATER_GRAMMAR}` };
    }
    case "cancel":
    case "run":
    case "result": {
      const ref = parseRef(words[0]);
      if (!ref || words.length > 1) return { kind: "invalid", reply: `Usage: /${name} <n|id>` };
      return { kind: name, ref };
    }
    default:
      return { kind: "unknown" };
  }
}

/** A parsed button press. `later` without a preset opens the Later ▾ menu. */
export interface CallbackAction {
  action: CallbackActionName;
  taskId: string;
  preset?: PostponePreset;
}

/** Parse `callback_data` (`<action>:<task_id>[:<preset code>]`); null when malformed. */
export function parseCallback(data: string): CallbackAction | null {
  const m = /^([a-z]):([A-Za-z0-9_~.-]{1,100}?)(?::([a-z]))?$/.exec(data);
  if (!m) return null;
  const action = CALLBACK_ACTIONS[m[1]!];
  if (!action) return null;
  if (m[3] === undefined) return { action, taskId: m[2]! };
  const preset = CALLBACK_PRESETS[m[3]];
  if (action !== "later" || !preset) return null;
  return { action, taskId: m[2]!, preset };
}

/** The next local `HH:MM` after `now` (today, else tomorrow). */
export function nextClockTime(clock: string, now: Date): Date {
  const m = CLOCK.exec(clock);
  if (!m) throw new Error(`not HH:MM: ${clock}`);
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(m[1]), Number(m[2]), 0, 0);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return at;
}

/** The core postpone target of a `/later` argument. */
export function laterTarget(arg: LaterArg, now: Date): PostponeTarget {
  if ("clock" in arg) return { until: nextClockTime(arg.clock, now) };
  if (arg.preset === "after_limit_reset") {
    return arg.resetClock ? { preset: "after_limit_reset", resetAt: nextClockTime(arg.resetClock, now) } : { preset: "after_limit_reset" };
  }
  return { preset: arg.preset };
}

/** The last `/queue` listing of one chat: task n is `ids[n-1]`. In memory only, so a restart drops it. */
export class QueueListing {
  private ids: string[] = [];
  private at = 0;

  constructor(private readonly ttlMs: number = LISTING_TTL_MS) {}

  set(ids: readonly string[], now: Date): void {
    this.ids = [...ids];
    this.at = now.getTime();
  }

  /** The id of task `n`, or null with no valid listing (none yet, or expired). */
  resolve(n: number, now: Date): string | null | undefined {
    if (this.at === 0 || now.getTime() - this.at > this.ttlMs) return null;
    return this.ids[n - 1];
  }
}

/** What a command needs from the host: the ledger and the scheduler's task actions. */
export interface CommandContext {
  getTask(id: string): TaskRecord<unknown> | undefined;
  /** Pending tasks, soonest first. */
  pendingTasks(): TaskRecord<unknown>[];
  postpone(id: string, target: PostponeTarget): Promise<unknown>;
  cancel(id: string): unknown;
  runNow(id: string): unknown;
  laterOptions(record: TaskRecord<unknown>, now: Date): Promise<PostponeOption[]>;
  now(): Date;
}

const PENDING: readonly TaskStatus[] = ["running", "submitted", "scheduled", "queued"];

function plannedMs(r: TaskRecord<unknown>): number {
  const t = Date.parse(r.scheduledFor ?? r.notBefore ?? r.enqueuedAt);
  return Number.isFinite(t) ? t : Number.MAX_SAFE_INTEGER;
}

/** A {@link CommandContext} over a core `Scheduler` and its `TaskStore`. */
export function commandContextFor(scheduler: Scheduler, store: TaskStore): CommandContext {
  return {
    getTask: (id) => store.get(id),
    pendingTasks: () =>
      PENDING.flatMap((status) => store.list({ status }))
        .sort((a, b) => plannedMs(a) - plannedMs(b))
        .slice(0, QUEUE_LIST_MAX),
    postpone: (id, target) => scheduler.postponeTask(id, target, { actor: "telegram" }),
    cancel: (id) => scheduler.cancelTask(id, { actor: "telegram" }),
    runNow: (id) => scheduler.runNow(id, { actor: "telegram" }),
    laterOptions: (record, now) => scheduler.postponeOptionsFor(record, now),
    now: () => new Date(),
  };
}

/** The refusal text of a scheduler error, without its `action: task <id>:` prefix. */
function refusalText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/^[a-zA-Z]+: task \S+?:? /, "");
}

type Resolved = { ok: true; record: TaskRecord<unknown> } | { ok: false; reply: string };

function resolveTask(ref: TaskRef, ctx: CommandContext, listing: QueueListing): Resolved {
  let id: string;
  if ("n" in ref) {
    const hit = listing.resolve(ref.n, ctx.now());
    if (hit === null) return { ok: false, reply: "Send /queue first: task numbers come from the last /queue and expire after 10 minutes." };
    if (hit === undefined) return { ok: false, reply: `The last /queue has no task ${ref.n}.` };
    id = hit;
  } else {
    id = ref.id;
  }
  const record = ctx.getTask(id);
  return record ? { ok: true, record } : { ok: false, reply: `There is no task ${refLabel(ref)}.` };
}

/** "<title> is already completed." */
function notAllowed(record: TaskRecord<unknown>): string {
  return `${messageTitle(record)} is already ${record.status}.`;
}

/** The confirmation of a move: the title and the new earliest start, read back from the ledger. */
function movedText(id: string, ctx: CommandContext, now: Date): string {
  const after = ctx.getTask(id);
  const nb = after?.notBefore ?? after?.scheduledFor;
  const at = nb ? localTimeLabel(new Date(nb), now) : "later";
  return `Moved: ${after ? messageTitle(after) : id}. Not before ${at}.`;
}

/** Run a parsed command for the paired chat. `pair` and `unknown` answer with help; the caller handles pairing. */
export async function runCommand(cmd: ChannelCommand, ctx: CommandContext, listing: QueueListing): Promise<OutgoingMessage[]> {
  const now = ctx.now();
  switch (cmd.kind) {
    case "help":
    case "unknown":
      return [{ text: HELP_TEXT }];
    case "pair":
      return [{ text: "This chat is already paired." }];
    case "invalid":
      return [{ text: cmd.reply }];
    case "queue": {
      const msg = queueMessage(ctx.pendingTasks(), now);
      listing.set(msg.ids, now);
      return [{ text: msg.text, buttons: msg.buttons }];
    }
    case "result": {
      const res = resolveTask(cmd.ref, ctx, listing);
      return res.ok ? resultMessages(res.record) : [{ text: res.reply }];
    }
    case "cancel": {
      const res = resolveTask(cmd.ref, ctx, listing);
      if (!res.ok) return [{ text: res.reply }];
      if (!taskActions(res.record).cancel) return [{ text: notAllowed(res.record) }];
      try {
        ctx.cancel(res.record.taskId);
      } catch (err) {
        return [{ text: `Not cancelled: ${refusalText(err)}` }];
      }
      return [{ text: `Cancelled: ${messageTitle(res.record)}.` }];
    }
    case "run": {
      const res = resolveTask(cmd.ref, ctx, listing);
      if (!res.ok) return [{ text: res.reply }];
      if (!taskActions(res.record).runNow) return [{ text: `${messageTitle(res.record)} is ${res.record.status}; it cannot run now.` }];
      try {
        ctx.runNow(res.record.taskId);
      } catch (err) {
        return [{ text: `Not started: ${refusalText(err)}` }];
      }
      return [{ text: `Runs at the next tick: ${messageTitle(res.record)}.` }];
    }
    case "later": {
      const res = resolveTask(cmd.ref, ctx, listing);
      if (!res.ok) return [{ text: res.reply }];
      if (!taskActions(res.record).later) return [{ text: `${messageTitle(res.record)} is ${res.record.status}; it cannot move.` }];
      try {
        await ctx.postpone(res.record.taskId, laterTarget(cmd.arg, now));
      } catch (err) {
        const why = refusalText(err);
        if (why.includes(NEEDS_RESET_TIME)) {
          return [{ text: `${NEEDS_RESET_TIME}: /later ${refLabel(cmd.ref)} reset HH:MM (for example /later ${refLabel(cmd.ref)} reset 14:05)` }];
        }
        return [{ text: `Not moved: ${messageTitle(res.record)}: ${why}` }];
      }
      return [{ text: movedText(res.record.taskId, ctx, now) }];
    }
  }
}

/** What a host does for a button press: answer the query, maybe remove the pressed message's buttons, send messages. */
export interface CallbackOutcome {
  answer: { text?: string; showAlert?: boolean };
  removeButtons: boolean;
  messages: OutgoingMessage[];
}

/**
 * Run a button press. A press on a task whose state no longer allows the
 * action answers with an alert naming the state, removes the buttons and
 * writes nothing.
 */
export async function runCallback(data: string, ctx: CommandContext): Promise<CallbackOutcome> {
  const action = parseCallback(data);
  if (!action) return { answer: { text: "This button is not valid any more." }, removeButtons: true, messages: [] };
  const now = ctx.now();
  const record = ctx.getTask(action.taskId);
  if (!record) return { answer: { text: "This task no longer exists.", showAlert: true }, removeButtons: true, messages: [] };
  const allowed = taskActions(record);
  const gone = (): CallbackOutcome => ({ answer: { text: notAllowed(record), showAlert: true }, removeButtons: true, messages: [] });
  const title = messageTitle(record);
  switch (action.action) {
    case "result":
      return { answer: {}, removeButtons: false, messages: resultMessages(record) };
    case "cancel":
      if (!allowed.cancel) return gone();
      try {
        ctx.cancel(record.taskId);
      } catch (err) {
        return { answer: { text: refusalText(err), showAlert: true }, removeButtons: false, messages: [] };
      }
      return { answer: { text: "Cancelled" }, removeButtons: true, messages: [{ text: `Cancelled: ${title}.` }] };
    case "run":
      if (!allowed.runNow) return gone();
      try {
        ctx.runNow(record.taskId);
      } catch (err) {
        return { answer: { text: refusalText(err), showAlert: true }, removeButtons: false, messages: [] };
      }
      return { answer: { text: "Runs at the next tick" }, removeButtons: true, messages: [{ text: `Runs at the next tick: ${title}.` }] };
    case "later": {
      if (!allowed.later) return gone();
      if (!action.preset) {
        return { answer: {}, removeButtons: false, messages: [laterMenuMessage(record, await ctx.laterOptions(record, now), now)] };
      }
      try {
        await ctx.postpone(record.taskId, { preset: action.preset });
      } catch (err) {
        return { answer: { text: refusalText(err), showAlert: true }, removeButtons: false, messages: [] };
      }
      return { answer: { text: "Moved" }, removeButtons: true, messages: [{ text: movedText(record.taskId, ctx, now) }] };
    }
  }
}
