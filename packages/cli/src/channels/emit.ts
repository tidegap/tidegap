/**
 * Channel events from a tick and from readiness (coherence U14, KTD12):
 * turn what the host observed into events, drop the ones already sent
 * (ledger meta), plan the jobs and send them. A send failure is one log
 * line; it never throws into the tick. `tidegap tick` calls {@link emitEvents};
 * the listener calls {@link notReadyEvent} for the ticker codes.
 */

import { dirname } from "node:path";

import {
  buildDigest,
  DIGEST_AT_META_KEY,
  DIGEST_LAST_META_KEY,
  DIGEST_SENT_META_KEY,
  digestAt,
  digestDue,
  eventMessage,
  foldIntoDigest,
  KIND_DESCRIPTORS,
  payloadFor,
  planNotifications,
  telegramChatId,
  TICK_BY_META_KEY,
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
  type TaskEvent,
  type TaskEventKind,
  type TaskRecord,
  type TaskStatus,
  type TelegramClient,
  type TickResultEntry,
  validateFields,
} from "@tidegap/core";

import { DRIVERS, type ChannelDriver, type DriverContext, type DriverKind } from "./drivers/index.js";
import { DeliveryError } from "./http.js";
import { readSecrets } from "./secrets.js";
import { uiPortsFor } from "./url-policy.js";

/** Meta key holding the last-sent not-ready problem keys (KTD12). */
export const NOT_READY_META_KEY = "notified:not_ready";

/** Meta key prefix of a sent clean window: `notified:clean_window:<start>`. */
export const CLEAN_WINDOW_META_PREFIX = "notified:clean_window:";

/**
 * Ticker problems only a process outside the tick can see: the listener
 * raises these (KTD11). The tick shares them only to send "running again"
 * after a sent alert, since a unit tick proves the ticker runs.
 */
export { TICKER_CODES };

/** Problems the tick raises; it passes these plus {@link TICKER_CODES} as its scope. */
export const RUNNER_CODES: readonly ReadinessCode[] = ["no_runner"];

/** The ledger calls emit needs. */
export interface EmitStore {
  get(taskId: string): TaskRecord<unknown> | undefined;
  getMeta(key: string): string | undefined;
  setMeta(key: string, value: string): void;
  deleteMeta(key: string): void;
  listChannels(): Channel[];
}

/** The ledger calls the daily summary needs (`TaskStore` has them). */
export interface DigestStore extends Pick<EmitStore, "get" | "getMeta" | "setMeta" | "deleteMeta"> {
  listFinishedSince(since: string, until: string): TaskRecord<unknown>[];
  listEventsSince(since: string, until: string, kinds?: readonly TaskEventKind[]): TaskEvent[];
  list(filter?: { status?: TaskStatus }): TaskRecord<unknown>[];
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
  /** Failed event sends in a row (a failed run counts once); absent after a success. */
  fails?: number;
  /** ISO time before which events skip this channel (backoff after a failed event send). */
  retry_at?: string;
}

/** The first wait after a failed send; it doubles per failed run up to {@link BACKOFF_CAP_MS}. */
const BACKOFF_FIRST_MS = 60_000;
const BACKOFF_CAP_MS = 60 * 60_000;

/** The wait after `fails` failed runs in a row: 1 min, 2, 4 … at most 1 h. */
export function backoffMs(fails: number): number {
  return Math.min(BACKOFF_FIRST_MS * 2 ** Math.max(0, Math.min(fails, 32) - 1), BACKOFF_CAP_MS);
}

/** The `channel_last:<id>` record, or undefined when absent or malformed. */
export function readLast(store: Pick<EmitStore, "getMeta">, id: string): LastDelivery | undefined {
  try {
    const v = JSON.parse(store.getMeta(`${CHANNEL_LAST_META_PREFIX}${id}`) ?? "null") as Partial<LastDelivery> | null;
    if (!v || typeof v.at !== "string" || typeof v.ok !== "boolean") return undefined;
    return {
      at: v.at,
      ok: v.ok,
      ...(typeof v.code === "string" ? { code: v.code } : {}),
      ...(!v.ok && typeof v.fails === "number" && v.fails > 0 ? { fails: v.fails } : {}),
      ...(!v.ok && typeof v.retry_at === "string" && Number.isFinite(Date.parse(v.retry_at)) ? { retry_at: v.retry_at } : {}),
    };
  } catch {
    return undefined;
  }
}

/** True while a channel's last event send failed and its backoff has not run out. */
export function backingOff(store: Pick<EmitStore, "getMeta">, channel: Channel, now: Date): boolean {
  if (channel.kind === "os") return false;
  const retryAt = readLast(store, channel.id)?.retry_at;
  return retryAt !== undefined && Date.parse(retryAt) > now.getTime();
}

/** The channels split by {@link backingOff}: `ready` get this run's events, `waiting` get none. */
export function splitBackoff(store: Pick<EmitStore, "getMeta">, channels: readonly Channel[], now: Date): { ready: Channel[]; waiting: Channel[] } {
  const ready: Channel[] = [];
  const waiting: Channel[] = [];
  for (const c of channels) (backingOff(store, c, now) ? waiting : ready).push(c);
  return { ready, waiting };
}

/**
 * Event kinds to treat as unsent: those quiet hours kept from a `ready`
 * channel ({@link quietHeldKinds}) and those a backing-off channel would
 * have got (quiet hours ignored). Their "sent" mark is undone unless another
 * channel got them, so a waiting channel gets them when its wait ends.
 */
export function heldKinds(events: readonly ChannelEvent[], ready: readonly Channel[], waiting: readonly Channel[], planned: readonly SendJob[], now: Date): Set<EventKind> {
  const held = quietHeldKinds(events, ready, planned, now);
  // A waiting channel gets no summary either, so the alerts folded into it are held too.
  const fold = awakeFold(events, waiting, now);
  for (const j of [...fold.jobs, ...fold.dropped]) held.add(j.event.kind);
  return held;
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
  /**
   * What the registry drivers need (the URL policy's UI ports), or a function
   * that builds it per send, so a long-running listener sees a `tidegap ui`
   * started after it. Absent: registry kinds fail `not_configured`.
   */
  driver?: DriverContext | (() => DriverContext);
  /** Tests: drivers instead of {@link DRIVERS}. */
  drivers?: Readonly<Record<DriverKind, ChannelDriver>>;
  now?: () => Date;
}

/**
 * The registry-kind deps of a host process: secrets read from `secretsFile`
 * and the URL policy's UI ports from the Tidegap home that holds the ledger
 * (the UI discovery file lives next to it), both on every send.
 */
export function registryDeps(opts: { dbPath: string; secretsFile: string; log?: (line: string) => void }): Pick<ChannelSenderDeps, "secrets" | "driver"> {
  return {
    secrets: (id) => readSecrets(id, opts.secretsFile, opts.log),
    driver: () => ({ http: { uiPorts: uiPortsFor(dirname(opts.dbPath)) } }),
  };
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

/** One registry-kind send of a ledger row: its config plus its secrets. */
async function sendRegistry(channel: Channel, event: ChannelEvent, deps: ChannelSenderDeps): Promise<void> {
  if (!deps.secrets || !deps.driver) throw new DeliveryError("not_configured");
  const ctx = typeof deps.driver === "function" ? deps.driver() : deps.driver;
  const fields = { ...channel.config, ...deps.secrets(channel.id) };
  await deliverPayload(channel.kind as DriverKind, fields, payloadFor(event, deps.now?.() ?? new Date()), ctx, deps.drivers);
}

/**
 * Format `payload` for a registry kind with its field values (non-secret and
 * secret together) and send it through the kind's driver. The send path of
 * the tick and of `ChannelSetup` (connect and test). Any failure becomes a
 * {@link DeliveryError}, so no exception text (a URL) reaches a log or answer.
 */
export async function deliverPayload(
  kind: DriverKind,
  fields: Readonly<Record<string, unknown>>,
  payload: NotificationPayload,
  ctx: DriverContext,
  drivers: Readonly<Record<DriverKind, ChannelDriver>> = DRIVERS,
): Promise<void> {
  try {
    const descriptor = KIND_DESCRIPTORS[kind];
    if (!descriptor.ready || !descriptor.format) throw new DeliveryError("not_ready");
    const checked = validateFields(descriptor, fields);
    if (!checked.ok) throw new DeliveryError("invalid_config");
    const values = { ...checked.values, ...checked.secrets };
    if (descriptor.validate?.(values)) throw new DeliveryError("invalid_config");
    const spec = descriptor.format(capPayload(payload), values);
    await drivers[kind].send(spec, ctx);
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
 * returns is sent again. The tick and the listener share one meta key;
 * each touches only the codes in its scope. When a ticker problem was sent
 * and the ticker is fine now, the event is `recovered` ("running again"),
 * once: the mark is only there when the alert went out. While the last tick
 * was a manual `tick --once` (`last_tick_by`), a sent ticker mark is kept and
 * nothing is sent: that tick says nothing about the unit.
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
  const ticker = (key: string) => TICKER_CODES.includes(key.split(":")[0] as ReadinessCode);
  const sentTicker = before.filter(ticker);
  const tickerFine = sentTicker.length > 0 && !current.some(ticker);
  const manual = tickerFine && store.getMeta(TICK_BY_META_KEY) === "manual";
  const recovered = tickerFine && !manual;
  const keys = manual ? [...current, ...sentTicker].sort() : current;
  const event = (list: ReadinessProblem[]): ChannelEvent => ({ kind: "not_ready", problems: list, ...(recovered ? { recovered: true as const } : {}) });
  if (keys.length === 0) {
    if (before.length > 0) write(others);
    return recovered ? event([]) : null;
  }
  if (keys.join("\n") === before.join("\n")) return null;
  write([...others, ...keys]);
  return event(problems);
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

/**
 * The daily summary when it is due (U15): null when no enabled channel
 * subscribes to `digest` (and then the ledger is not touched), before the
 * send time, after today's summary, or on an empty day. An empty day still
 * moves `notified:digest`, so tomorrow's window starts here. A built summary
 * sets `notified:digest` too; `undo` puts the old value back.
 */
export async function digestEvent(
  store: DigestStore,
  channels: readonly Channel[],
  opts: { now: Date; problems?: readonly ReadinessProblem[]; nextWindow?: () => Promise<CleanWindowEvent | null> },
): Promise<{ event: ChannelEvent; undo: () => void } | null> {
  if (!channels.some((c) => c.enabled && c.events.includes("digest"))) return null;
  const { now } = opts;
  const before = store.getMeta(DIGEST_LAST_META_KEY);
  const { due, since } = digestDue(now, before, digestAt(store.getMeta(DIGEST_AT_META_KEY)));
  if (!due) return null;
  const [from, until] = [since.toISOString(), now.toISOString()];
  const finished = store.listFinishedSince(from, until);
  const postponedIds = [...new Set(store.listEventsSince(from, until, ["postponed"]).map((e) => e.taskId))];
  const queued = store.list({ status: "queued" }).length + store.list({ status: "scheduled" }).length;
  const event = buildDigest({
    since,
    now,
    done: finished.filter((t) => t.status === "completed"),
    failed: finished.filter((t) => t.status === "failed"),
    postponed: postponedIds.map((id) => store.get(id)).filter((t): t is TaskRecord<unknown> => t !== undefined),
    problems: opts.problems ?? [],
    queued,
    window: queued > 0 && opts.nextWindow ? await opts.nextWindow().catch(() => null) : null,
  });
  store.setMeta(DIGEST_LAST_META_KEY, until);
  return event ? { event, undo: restoreMeta(store, DIGEST_LAST_META_KEY, before) } : null;
}

export interface EmitInput {
  store: EmitStore;
  send: ChannelSender;
  /** Entries of the tick that just ran. */
  results?: readonly TickResultEntry[];
  /** The tick's readiness; only problems in `readinessScope` are reported. */
  readiness?: Readiness;
  /** Default {@link RUNNER_CODES}; the CLI tick passes these plus {@link TICKER_CODES}. */
  readinessScope?: readonly ReadinessCode[];
  /** The clean window the host computed, if any (`tidegap ui` summary `nextCleanWindow`, without fallback). */
  cleanWindow?: CleanWindowEvent | null;
  /**
   * The daily summary's ledger reads and the next clean window it names.
   * Absent: no summary this run.
   */
  digest?: { store: DigestStore; nextWindow?: () => Promise<CleanWindowEvent | null> };
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
  let dropped: SendJob[];
  let held: Set<EventKind>;
  let folded: Set<EventKind>;
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
    // A channel in backoff gets nothing this run, and its summary is not built (no forecast fetch).
    const { ready: channels, waiting } = splitBackoff(input.store, [...(input.extraChannels ?? []), ...input.store.listChannels()], now);
    if (input.digest) {
      // A summary error costs the summary only, never this run's other alerts.
      try {
        const digest = await digestEvent(input.digest.store, channels, { now, problems: input.readiness?.problems, nextWindow: input.digest.nextWindow });
        if (digest) {
          events.push(digest.event);
          undo.set("digest", digest.undo);
        }
      } catch (err) {
        log(`tidegap: daily summary skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const planned = planNotifications(events, channels, now);
    held = heldKinds(events, channels, waiting, planned, now);
    ({ jobs, dropped } = foldIntoDigest(planned));
    // Also the kinds quiet hours kept from a channel whose summary lists them.
    folded = awakeFold(events, channels, now).folded;
  } catch (err) {
    log(`tidegap: channel events skipped: ${err instanceof Error ? err.message : String(err)}`);
    return { sent: 0, failed: 0 };
  }
  const res = await sendJobs(jobs, input.send, log, now, input.store);
  if (!res.sentKinds.has("digest")) {
    // The summary reached no channel: it and the alerts folded into it are sent again next run.
    for (const k of folded) held.add(k);
  } else {
    recordDigestSent(input.store, now, log);
    // A channel whose summary failed gets the alerts the fold removed for it, in this run.
    const missed = new Set(res.failedJobs.filter((j) => j.event.kind === "digest").map((j) => j.channel.id));
    const resend = dropped.filter((j) => missed.has(j.channel.id));
    // An alert a delivered summary carried reached that channel: it is sent, so a waiting channel's hold cannot resend it to it.
    for (const j of dropped) if (!missed.has(j.channel.id)) res.sentKinds.add(j.event.kind);
    if (resend.length > 0) addResult(res, await sendJobs(resend, input.send, log, now, input.store));
  }
  undoUnsent(res, undo, log, held);
  return { sent: res.sent, failed: res.failed };
}

/** Write {@link DIGEST_SENT_META_KEY}; a ledger error is one log line. */
function recordDigestSent(store: Pick<EmitStore, "setMeta">, at: Date, log: (line: string) => void): void {
  try {
    store.setMeta(DIGEST_SENT_META_KEY, at.toISOString());
  } catch (err) {
    log(`tidegap: summary send time not recorded: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Add the result of a second {@link sendJobs} call to `into`. */
function addResult(into: SendResult, more: SendResult): void {
  into.sent += more.sent;
  into.failed += more.failed;
  for (const k of more.sentKinds) into.sentKinds.add(k);
  for (const k of more.failedKinds) into.failedKinds.add(k);
  into.failedJobs.push(...more.failedJobs);
}

/** The plan with quiet hours off, folded into the summary: what each channel gets when it is awake. */
function awakeFold(events: readonly ChannelEvent[], channels: readonly Channel[], now: Date): ReturnType<typeof foldIntoDigest> {
  const awake = channels.map((c) => ({ ...c, config: { ...c.config, quiet: "off" } }));
  return foldIntoDigest(planNotifications(events, awake, now));
}

/**
 * Event kinds that quiet hours kept from a subscribed channel and that got
 * no job at all: their "sent" mark is undone like a failed send, so a
 * daemon-down or not-ready alert held at night still arrives after 09:00.
 * An alert that the same channel's summary lists is not held: the summary
 * carries it.
 */
export function quietHeldKinds(events: readonly ChannelEvent[], channels: readonly Channel[], jobs: readonly SendJob[], now: Date): Set<EventKind> {
  const planned = new Set(jobs.map((j) => j.event.kind));
  return new Set(awakeFold(events, channels, now).jobs.map((j) => j.event.kind).filter((k) => !planned.has(k)));
}

/** A function that puts meta `key` back to `before` (deleted when it was absent). */
export function restoreMeta(store: Pick<EmitStore, "setMeta" | "deleteMeta">, key: string, before: string | undefined): () => void {
  return () => (before === undefined ? store.deleteMeta(key) : store.setMeta(key, before));
}

/**
 * Forget the "sent" mark of an event kind that reached no channel, because
 * every send failed, or quiet hours or a channel's backoff held it
 * ({@link heldKinds}), so the next run sends it again.
 */
export function undoUnsent(res: SendResult, undo: ReadonlyMap<EventKind, () => void>, log: (line: string) => void, held: ReadonlySet<EventKind> = new Set()): void {
  for (const [kind, fn] of undo) {
    if (!(res.failedKinds.has(kind) || held.has(kind)) || res.sentKinds.has(kind)) continue;
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
  /** The jobs whose send failed, in send order. */
  failedJobs: SendJob[];
}

/**
 * Send planned jobs; a failure is one log line naming the channel and the
 * error (a `DeliveryError` carries its code only). With `store`, each job's
 * result is written to `channel_last:<id>` (KTD11; not for the implicit `os`):
 * a failure starts or extends the channel's backoff, a success ends it.
 */
export async function sendJobs(
  jobs: readonly SendJob[],
  send: ChannelSender,
  log: (line: string) => void,
  now: Date = new Date(),
  store?: Pick<EmitStore, "getMeta" | "setMeta">,
): Promise<SendResult> {
  let sent = 0;
  let failed = 0;
  const sentKinds = new Set<EventKind>();
  const failedKinds = new Set<EventKind>();
  const failedJobs: SendJob[] = [];
  for (const job of jobs) {
    try {
      await send(job.channel, eventMessage(job.event, now), job.event);
      sent++;
      sentKinds.add(job.event.kind);
      recordLast(store, job.channel, now, { ok: true }, log);
    } catch (err) {
      failed++;
      failedKinds.add(job.event.kind);
      failedJobs.push(job);
      log(`tidegap: ${job.channel.id}: ${job.event.kind} not sent: ${err instanceof Error ? err.message : String(err)}`);
      recordLast(store, job.channel, now, { ok: false, code: err instanceof DeliveryError ? err.code : "error" }, log);
    }
  }
  return { sent, failed, sentKinds, failedKinds, failedJobs };
}

/** {@link writeLast} for an event send; the implicit `os` has no record, and a ledger error is one log line. */
function recordLast(store: Pick<EmitStore, "getMeta" | "setMeta"> | undefined, channel: Channel, at: Date, result: Pick<LastDelivery, "ok" | "code">, log: (line: string) => void): void {
  if (!store || channel.kind === "os") return;
  try {
    writeLast(store, channel.id, at, result);
  } catch (err) {
    log(`tidegap: ${channel.id}: last delivery not recorded: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Write `channel_last:<id>`, the one writer of that record, so every path
 * follows one backoff rule: a success ends the backoff. A failed event send
 * (`failure: "extend"`) counts one more failed run (two failed jobs of one
 * run count once) and sets `retry_at` by {@link backoffMs}. A failed manual
 * test (`"keep"`) records its code and keeps the current `fails`/`retry_at`.
 * Throws on a ledger error.
 */
export function writeLast(store: Pick<EmitStore, "getMeta" | "setMeta">, id: string, at: Date, result: Pick<LastDelivery, "ok" | "code">, failure: "extend" | "keep" = "extend"): void {
  const record: LastDelivery = { at: at.toISOString(), ...result };
  if (!result.ok) {
    const prev = readLast(store, id);
    if (failure === "keep") {
      if (prev?.fails !== undefined) record.fails = prev.fails;
      if (prev?.retry_at !== undefined) record.retry_at = prev.retry_at;
    } else {
      const prevFails = prev && !prev.ok ? (prev.fails ?? 1) : 0;
      record.fails = prev && !prev.ok && prev.at === record.at && prev.fails ? prev.fails : prevFails + 1;
      record.retry_at = new Date(at.getTime() + backoffMs(record.fails)).toISOString();
    }
  }
  store.setMeta(`${CHANNEL_LAST_META_PREFIX}${id}`, JSON.stringify(record));
}
