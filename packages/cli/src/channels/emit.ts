/**
 * Channel events from a tick and from readiness (coherence U14, KTD12):
 * turn what the host observed into events, drop the ones already sent
 * (ledger meta), plan the jobs and send them. A send failure is one log
 * line; it never throws into the tick. `tidegap tick` calls {@link emitEvents};
 * the listener calls {@link notReadyEvent} for the ticker codes.
 */

import {
  eventMessage,
  KIND_DESCRIPTORS,
  payloadFor,
  planNotifications,
  telegramChatId,
  TICKER_CODES,
  type Channel,
  type ChannelEvent,
  type CleanWindowEvent,
  type EventKind,
  type NotificationPayload,
  type OutgoingMessage,
  type Readiness,
  type ReadinessCode,
  type ReadinessProblem,
  type SendJob,
  type TaskRecord,
  type TelegramClient,
  type TickResultEntry,
  validateFields,
} from "@tidegap/core";

import { DRIVERS, type ChannelDriver, type DriverContext, type DriverKind } from "./drivers/index.js";
import { DeliveryError } from "./http.js";

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

/** Meta key prefix of a channel's last delivery: `channel_last:<id>` = {@link LastDelivery} (KTD11). */
export const CHANNEL_LAST_META_PREFIX = "channel_last:";

/** The last delivery to a channel: no secret and no response body, only a mapped code. */
export interface LastDelivery {
  at: string;
  ok: boolean;
  code?: string;
}

/** Longest payload text a registry kind sends; the host-built digest text has no other bound. */
export const MAX_PAYLOAD_TEXT = 4000;

/** Longest payload title a registry kind sends. */
export const MAX_PAYLOAD_TITLE = 256;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The payload with its title and text cut to the transport caps. */
export function capPayload(p: NotificationPayload): NotificationPayload {
  return { ...p, title: clip(p.title, MAX_PAYLOAD_TITLE), text: clip(p.text, MAX_PAYLOAD_TEXT) };
}

export interface ChannelSenderDeps {
  telegram?: TelegramClient;
  os?: (message: OutgoingMessage, event: ChannelEvent) => void | Promise<void>;
  /** The secrets of a registry channel (`readSecrets`). Absent: registry kinds fail `not_configured`. */
  secrets?: (channelId: string) => Readonly<Record<string, string>> | undefined;
  /** What the registry drivers need (the URL policy's UI ports). Absent: registry kinds fail `not_configured`. */
  driver?: DriverContext;
  /** Tests: drivers instead of {@link DRIVERS}. */
  drivers?: Readonly<Record<DriverKind, ChannelDriver>>;
  now?: () => Date;
}

/**
 * A sender over the host's side effects: the Telegram client, the OS toast
 * (which formats from the event), and the registry drivers (KTD3), which
 * format the event's payload with the kind's descriptor, the row's
 * non-secret config and the channel's secrets.
 */
export function channelSender(deps: ChannelSenderDeps): ChannelSender {
  return async (channel, message, event) => {
    if (channel.kind === "telegram") {
      const chatId = telegramChatId(channel);
      if (!deps.telegram || chatId === undefined) throw new Error(`channel ${channel.id}: no Telegram client or chat id`);
      await deps.telegram.sendMessage(chatId, message.text, { buttons: message.buttons });
    } else if (channel.kind === "os") {
      if (deps.os) await deps.os(message, event);
    } else {
      await sendRegistry(channel, event, deps);
    }
  };
}

/** One registry-kind send. Any failure becomes a {@link DeliveryError}, so no exception text (a URL) reaches a log. */
async function sendRegistry(channel: Channel, event: ChannelEvent, deps: ChannelSenderDeps): Promise<void> {
  const kind = channel.kind as DriverKind;
  try {
    const descriptor = KIND_DESCRIPTORS[kind];
    if (!descriptor.ready || !descriptor.format) throw new DeliveryError("not_ready");
    if (!deps.secrets || !deps.driver) throw new DeliveryError("not_configured");
    const checked = validateFields(descriptor, { ...channel.config, ...deps.secrets(channel.id) });
    if (!checked.ok) throw new DeliveryError("invalid_config");
    const payload = capPayload(payloadFor(event, deps.now?.() ?? new Date()));
    const spec = descriptor.format(payload, { ...checked.values, ...checked.secrets });
    await (deps.drivers ?? DRIVERS)[kind].send(spec, deps.driver);
  } catch (err) {
    throw err instanceof DeliveryError ? err : new DeliveryError("error");
  }
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
  const undo = new Map<EventKind, () => void>();
  try {
    const events: ChannelEvent[] = [...tickResultEvents(input.store, input.results ?? [])];
    const window = cleanWindowEvent(input.store, input.cleanWindow, now);
    if (window) {
      events.push(window);
      const key = `${CLEAN_WINDOW_META_PREFIX}${input.cleanWindow!.start}`;
      undo.set("clean_window", () => input.store.deleteMeta(key));
    }
    if (input.readiness) {
      const before = input.store.getMeta(NOT_READY_META_KEY);
      const nr = notReadyEvent(input.store, input.readiness, input.readinessScope ?? RUNNER_CODES);
      if (nr) {
        events.push(nr);
        undo.set("not_ready", restoreMeta(input.store, NOT_READY_META_KEY, before));
      }
    }
    jobs = planNotifications(events, [...(input.extraChannels ?? []), ...input.store.listChannels()], now);
  } catch (err) {
    log(`tidegap: channel events skipped: ${err instanceof Error ? err.message : String(err)}`);
    return { sent: 0, failed: 0 };
  }
  const res = await sendJobs(jobs, input.send, log, now, input.store);
  undoUnsent(res, undo, log);
  return { sent: res.sent, failed: res.failed };
}

/** A function that puts meta `key` back to `before` (deleted when it was absent). */
export function restoreMeta(store: Pick<EmitStore, "setMeta" | "deleteMeta">, key: string, before: string | undefined): () => void {
  return () => (before === undefined ? store.deleteMeta(key) : store.setMeta(key, before));
}

/** Forget the "sent" mark of an event kind whose every send failed, so the next run sends it again. */
export function undoUnsent(res: SendResult, undo: ReadonlyMap<EventKind, () => void>, log: (line: string) => void): void {
  for (const [kind, fn] of undo) {
    if (!res.failedKinds.has(kind) || res.sentKinds.has(kind)) continue;
    try {
      fn();
    } catch (err) {
      log(`tidegap: ${kind} will not be resent: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** What {@link sendJobs} did, with the event kinds that reached at least one channel and those that failed somewhere. */
export interface SendResult {
  sent: number;
  failed: number;
  sentKinds: Set<EventKind>;
  failedKinds: Set<EventKind>;
}

/**
 * Send planned jobs; a failure is one log line naming the channel and the
 * error (a `DeliveryError` carries its code only). With `store`, each job's
 * result is written to `channel_last:<id>` (KTD11; not for the implicit `os`).
 */
export async function sendJobs(
  jobs: readonly SendJob[],
  send: ChannelSender,
  log: (line: string) => void,
  now: Date = new Date(),
  store?: Pick<EmitStore, "setMeta">,
): Promise<SendResult> {
  let sent = 0;
  let failed = 0;
  const sentKinds = new Set<EventKind>();
  const failedKinds = new Set<EventKind>();
  for (const job of jobs) {
    try {
      await send(job.channel, eventMessage(job.event, now), job.event);
      sent++;
      sentKinds.add(job.event.kind);
      recordLast(store, job.channel, { at: new Date().toISOString(), ok: true }, log);
    } catch (err) {
      failed++;
      failedKinds.add(job.event.kind);
      log(`tidegap: ${job.channel.id}: ${job.event.kind} not sent: ${err instanceof Error ? err.message : String(err)}`);
      recordLast(store, job.channel, { at: new Date().toISOString(), ok: false, code: err instanceof DeliveryError ? err.code : "error" }, log);
    }
  }
  return { sent, failed, sentKinds, failedKinds };
}

/** Write `channel_last:<id>`; a ledger error is one log line. */
function recordLast(store: Pick<EmitStore, "setMeta"> | undefined, channel: Channel, last: LastDelivery, log: (line: string) => void): void {
  if (!store || channel.kind === "os") return;
  try {
    store.setMeta(`${CHANNEL_LAST_META_PREFIX}${channel.id}`, JSON.stringify(last));
  } catch (err) {
    log(`tidegap: ${channel.id}: last delivery not recorded: ${err instanceof Error ? err.message : String(err)}`);
  }
}
