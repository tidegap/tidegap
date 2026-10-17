/**
 * Channel events from a tick and from readiness (coherence U14, KTD12):
 * turn what the host observed into events, drop the ones already sent
 * (ledger meta), plan the jobs and send them. A send failure is one log
 * line; it never throws into the tick. `tidegap tick` calls {@link emitEvents};
 * the listener calls {@link notReadyEvent} for the ticker codes.
 */

import {
  eventMessage,
  planNotifications,
  telegramChatId,
  TICKER_CODES,
  type Channel,
  type ChannelEvent,
  type CleanWindowEvent,
  type OutgoingMessage,
  type Readiness,
  type ReadinessCode,
  type ReadinessProblem,
  type SendJob,
  type TaskRecord,
  type TelegramClient,
  type TickResultEntry,
} from "@tidegap/core";

/** Meta key holding the last-sent not-ready problem keys (KTD12). */
export const NOT_READY_META_KEY = "notified:not_ready";

/** Meta key prefix of a sent clean window: `notified:clean_window:<start>`. */
export const CLEAN_WINDOW_META_PREFIX = "notified:clean_window:";

/** Problems only a running process outside the tick can see: the listener reports these (KTD11). */
export { TICKER_CODES };

/** Problems the tick reports. */
export const RUNNER_CODES: readonly ReadinessCode[] = ["no_runner"];

/** The ledger calls emit needs. */
export interface EmitStore {
  get(taskId: string): TaskRecord<unknown> | undefined;
  getMeta(key: string): string | undefined;
  setMeta(key: string, value: string): void;
  deleteMeta(key: string): void;
  listChannels(): Channel[];
}

/** Sends one message to one channel; throws on failure. `event` is what the message was built from. */
export type ChannelSender = (channel: Channel, message: OutgoingMessage, event: ChannelEvent) => Promise<void>;

/** A sender over the host's side effects: the Telegram client and the OS toast (which formats from the event). */
export function channelSender(deps: {
  telegram?: TelegramClient;
  os?: (message: OutgoingMessage, event: ChannelEvent) => void | Promise<void>;
}): ChannelSender {
  return async (channel, message, event) => {
    if (channel.kind === "telegram") {
      const chatId = telegramChatId(channel);
      if (!deps.telegram || chatId === undefined) throw new Error(`channel ${channel.id}: no Telegram client or chat id`);
      await deps.telegram.sendMessage(chatId, message.text, { buttons: message.buttons });
    } else if (deps.os) {
      await deps.os(message, event);
    }
  };
}

/** Done and failed events for the tasks this tick finished (KTD12: only those). */
export function tickResultEvents(store: Pick<EmitStore, "get">, results: readonly TickResultEntry[]): ChannelEvent[] {
  const out: ChannelEvent[] = [];
  for (const r of results) {
    if (r.status !== "completed" && r.status !== "failed") continue;
    const task = store.get(r.taskId);
    if (!task || (task.status !== "completed" && task.status !== "failed")) continue;
    out.push(task.status === "completed" ? { kind: "task_done", task } : { kind: "task_failed", task });
  }
  return out;
}

function problemKey(p: ReadinessProblem): string {
  return p.provider ? `${p.code}:${p.provider}` : p.code;
}

function readKeys(store: Pick<EmitStore, "getMeta">): string[] {
  try {
    const v = JSON.parse(store.getMeta(NOT_READY_META_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * The not-ready event for the problems in `scope`, once per change (KTD12):
 * sent when the current non-empty set differs from the last sent one,
 * forgotten when the scope turns ready, so a problem that clears and
 * returns is sent again. The tick and the listener share one meta key and
 * each touches only its own codes.
 */
export function notReadyEvent(
  store: Pick<EmitStore, "getMeta" | "setMeta" | "deleteMeta">,
  readiness: Readiness,
  scope: readonly ReadinessCode[],
): ChannelEvent | null {
  const inScope = (key: string) => scope.includes(key.split(":")[0] as ReadinessCode);
  const stored = readKeys(store);
  const others = stored.filter((k) => !inScope(k));
  const problems = readiness.problems.filter((p) => scope.includes(p.code));
  const current = [...new Set(problems.map(problemKey))].sort();
  const before = stored.filter(inScope).sort();
  const write = (keys: string[]) => (keys.length > 0 ? store.setMeta(NOT_READY_META_KEY, JSON.stringify(keys)) : store.deleteMeta(NOT_READY_META_KEY));
  if (current.length === 0) {
    if (before.length > 0) write(others);
    return null;
  }
  if (current.join("\n") === before.join("\n")) return null;
  write([...others, ...current]);
  return { kind: "not_ready", problems };
}

/** The clean-window event once per window start; null when the window has not started or was sent. */
export function cleanWindowEvent(
  store: Pick<EmitStore, "getMeta" | "setMeta">,
  window: CleanWindowEvent | null | undefined,
  now: Date,
): ChannelEvent | null {
  if (!window) return null;
  const start = Date.parse(window.start);
  const end = Date.parse(window.end);
  if (!(start <= now.getTime() && now.getTime() < end)) return null;
  const key = `${CLEAN_WINDOW_META_PREFIX}${window.start}`;
  if (store.getMeta(key)) return null;
  store.setMeta(key, now.toISOString());
  return { kind: "clean_window", window };
}

export interface EmitInput {
  store: EmitStore;
  send: ChannelSender;
  /** Entries of the tick that just ran. */
  results?: readonly TickResultEntry[];
  /** The tick's readiness; only problems in `readinessScope` are reported. */
  readiness?: Readiness;
  /** Default {@link RUNNER_CODES} (the tick's share). */
  readinessScope?: readonly ReadinessCode[];
  /** The clean window the host computed, if any (`tidegap ui` summary `nextCleanWindow`, without fallback). */
  cleanWindow?: CleanWindowEvent | null;
  /** Channels besides the ledger rows, e.g. `osChannel(...)`. */
  extraChannels?: readonly Channel[];
  log?: (line: string) => void;
  now?: Date;
}

/** Plan and send this run's events. Returns the counts; never throws. */
export async function emitEvents(input: EmitInput): Promise<{ sent: number; failed: number }> {
  const now = input.now ?? new Date();
  const log = input.log ?? (() => {});
  let jobs: SendJob[];
  try {
    const events: ChannelEvent[] = [...tickResultEvents(input.store, input.results ?? [])];
    const window = cleanWindowEvent(input.store, input.cleanWindow, now);
    if (window) events.push(window);
    if (input.readiness) {
      const nr = notReadyEvent(input.store, input.readiness, input.readinessScope ?? RUNNER_CODES);
      if (nr) events.push(nr);
    }
    jobs = planNotifications(events, [...(input.extraChannels ?? []), ...input.store.listChannels()]);
  } catch (err) {
    log(`tidegap: channel events skipped: ${err instanceof Error ? err.message : String(err)}`);
    return { sent: 0, failed: 0 };
  }
  return sendJobs(jobs, input.send, log, now);
}

/** Send planned jobs; a failure is one log line naming the channel and the error. */
export async function sendJobs(
  jobs: readonly SendJob[],
  send: ChannelSender,
  log: (line: string) => void,
  now: Date = new Date(),
): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  for (const job of jobs) {
    try {
      await send(job.channel, eventMessage(job.event, now), job.event);
      sent++;
    } catch (err) {
      failed++;
      log(`tidegap: ${job.channel.id}: ${job.event.kind} not sent: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { sent, failed };
}
