/**
 * The channel listener (coherence U14, KTD11): one long-poll loop that
 * takes bot commands and button presses from the paired chat and runs
 * them through the scheduler, plus a ledger-only ticker check once per
 * poll cycle (a stopped tick cannot report itself).
 *
 * Rules:
 * - Auth (R25): an update is handled only when its chat id belongs to an
 *   enabled telegram channel row read at that moment; anything else gets
 *   no reply and writes nothing, so `channels remove` takes effect on the
 *   next update (R29).
 * - The update offset is stored in meta before each update runs, so a
 *   restart never replays a command.
 * - 401: log and sleep 10 minutes. 409 or a network error: back off 5 s
 *   doubling to 60 s.
 * - Log lines carry the Bot API method and status only, never the token.
 */

import {
  assessReadiness,
  LAST_TICK_META_KEY,
  parseCommand,
  planNotifications,
  QueueListing,
  runCallback,
  runCommand,
  telegramChatId,
  TelegramError,
  type Channel,
  type CommandContext,
  type DaemonFact,
  type OutgoingMessage,
  type Readiness,
  type TaskRecord,
  type TaskStatus,
  type TelegramClient,
  type TelegramUpdate,
} from "@tidegap/core";

import { daemonStatus } from "../platform/index.js";
import {
  backoffHeldKinds,
  channelSender,
  NOT_READY_META_KEY,
  notReadyEvent,
  quietHeldKinds,
  restoreMeta,
  sendJobs,
  splitBackoff,
  TICKER_CODES,
  undoUnsent,
  type ChannelSender,
  type EmitStore,
} from "./emit.js";

/** Meta key of the next `getUpdates` offset (KTD11). */
export const OFFSET_META_KEY = "telegram_update_offset";

/** Meta key of the bot id the stored offset belongs to (KTD6); update ids are per bot. */
export const BOT_ID_META_KEY = "telegram_bot_id";

/** Meta key of the listener heartbeat (KTD7). */
export const LISTENER_META_KEY = "telegram_listener";

/** The listener heartbeat in ledger meta (KTD7). */
export interface ListenerHeartbeat {
  at: string;
  state: "ok" | "conflict" | "unauthorized" | "network";
  /** The last 409, kept across later `ok` writes: two pollers take turns. */
  conflict_at?: string;
}

/** The stored heartbeat, or undefined when missing or unreadable. */
export function readHeartbeat(store: { getMeta(key: string): string | undefined }): ListenerHeartbeat | undefined {
  try {
    const v = JSON.parse(store.getMeta(LISTENER_META_KEY) ?? "") as ListenerHeartbeat;
    return typeof v?.at === "string" && typeof v.state === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Note the bot the token belongs to (KTD6). When it differs from the stored
 * one, the stored offset belongs to another bot and is cleared: a higher
 * offset would confirm and drop every update of the new bot. Clearing is safe
 * for the same bot too, since Telegram forgets confirmed updates.
 */
export function syncBotId(store: { getMeta(key: string): string | undefined; setMeta(key: string, value: string): void; deleteMeta(key: string): void }, botId: number): void {
  if (store.getMeta(BOT_ID_META_KEY) === String(botId)) return;
  store.deleteMeta(OFFSET_META_KEY);
  store.setMeta(BOT_ID_META_KEY, String(botId));
}

/** How often an unchanged heartbeat is written again. */
export const HEARTBEAT_EVERY_MS = 60_000;

/** Telegram's long-poll wait per cycle. */
export const POLL_TIMEOUT_S = 50;

const UNAUTHORIZED_SLEEP_MS = 10 * 60_000;
const BACKOFF_MIN_MS = 5_000;
const BACKOFF_MAX_MS = 60_000;

/** The ledger calls the listener needs (a `TaskStore` satisfies it). */
export interface ListenerStore extends EmitStore {
  list(filter: { status: TaskStatus }): TaskRecord<unknown>[];
}

export interface ListenerOptions {
  store: ListenerStore;
  client: TelegramClient;
  commands: CommandContext;
  /**
   * The sender of the ticker check's alerts; default a Telegram-only
   * `channelSender`. The listener entry point passes the driver-aware one,
   * so daemon-down alerts reach every subscribed channel.
   */
  send?: ChannelSender;
  /** The ledger-only ticker readiness; default {@link tickerReadiness} on this machine. */
  readiness?: () => Readiness;
  log?: (line: string) => void;
  pollTimeoutS?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  now?: () => Date;
}

/** Sleep that ends early on abort. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Readiness from the ledger and the unit file only (KTD11): the daemon fact
 * is "installed" when its unit file exists (no `launchctl` spawn every
 * cycle), the ticker fact is `last_tick_at`, and runners are not judged.
 */
export function tickerReadiness(
  store: Pick<ListenerStore, "getMeta" | "list">,
  opts: { platform?: NodeJS.Platform; home?: string; now?: Date } = {},
): Readiness {
  const onDisk = daemonStatus({ platform: opts.platform, home: opts.home });
  const daemon: DaemonFact = onDisk === "installed" ? "installed" : onDisk === "not_installed" ? "not_installed" : "unknown";
  return assessReadiness({
    daemon,
    lastTickAt: store.getMeta(LAST_TICK_META_KEY) ?? null,
    runners: null,
    pendingByProvider: {},
    now: opts.now,
  });
}

/** The chat id an update came from. */
function updateChatId(u: TelegramUpdate): number | undefined {
  return u.message?.chat.id ?? u.callback_query?.message?.chat.id ?? u.callback_query?.from.id;
}

/** The enabled telegram channels, read now. */
function pairedChannels(store: Pick<EmitStore, "listChannels">): Channel[] {
  return store.listChannels().filter((c) => c.kind === "telegram" && c.enabled && telegramChatId(c) !== undefined);
}

export class ChannelListener {
  private readonly listings = new Map<number, QueueListing>();
  private readonly log: (line: string) => void;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly readiness: () => Readiness;
  private readonly now: () => Date;
  private readonly alert: ChannelSender;
  private beat: ListenerHeartbeat | undefined;
  /** The running ticker check, if any (see {@link cycle}). */
  private tickerCheck: Promise<void> | undefined;

  constructor(private readonly opts: ListenerOptions) {
    this.log = opts.log ?? ((line) => process.stderr.write(`${line}\n`));
    this.sleep = opts.sleep ?? abortableSleep;
    this.readiness = opts.readiness ?? (() => tickerReadiness(opts.store));
    this.now = opts.now ?? (() => new Date());
    this.alert = opts.send ?? channelSender({ telegram: opts.client });
  }

  /**
   * Write the heartbeat (KTD7) when its state changed or a minute passed, so
   * idle polling does not churn the ledger. A 409 sets `conflict_at`, which
   * later writes keep. Never throws.
   */
  heartbeat(state: ListenerHeartbeat["state"]): void {
    const now = this.now();
    const conflictAt = state === "conflict" ? now.toISOString() : this.beat?.conflict_at;
    const due = !this.beat || this.beat.state !== state || now.getTime() - Date.parse(this.beat.at) >= HEARTBEAT_EVERY_MS;
    if (!due) {
      if (conflictAt) this.beat = { ...this.beat!, conflict_at: conflictAt };
      return;
    }
    const beat: ListenerHeartbeat = { at: now.toISOString(), state, ...(conflictAt ? { conflict_at: conflictAt } : {}) };
    try {
      this.opts.store.setMeta(LISTENER_META_KEY, JSON.stringify(beat));
      this.beat = beat;
    } catch (err) {
      this.log(`tidegap channels: heartbeat not written: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Start-up (KTD6, KTD7): check the bot, clear another bot's offset, write the first heartbeat. Never throws. */
  async startup(): Promise<void> {
    try {
      const me = await this.opts.client.getMe();
      syncBotId(this.opts.store, me.id);
      this.heartbeat("ok");
    } catch (err) {
      this.heartbeat(errorState(err));
    }
  }

  private offset(): number | undefined {
    const n = Number(this.opts.store.getMeta(OFFSET_META_KEY));
    return Number.isSafeInteger(n) && n > 0 ? n : undefined;
  }

  /**
   * The ticker check (KTD11): send `not_ready` for ticker codes once per
   * change, planned over every enabled channel (quiet hours included), so a
   * stopped tick reaches each subscribed channel, not only Telegram. Never throws.
   */
  async checkTicker(): Promise<void> {
    try {
      const before = this.opts.store.getMeta(NOT_READY_META_KEY);
      const event = notReadyEvent(this.opts.store, this.readiness(), TICKER_CODES);
      if (!event) return;
      const now = this.now();
      const usable = this.opts.store.listChannels().filter((c) => c.kind !== "telegram" || telegramChatId(c) !== undefined);
      // A channel in backoff is skipped; the alert stays unsent for it until its wait ends.
      const { ready: channels, waiting } = splitBackoff(this.opts.store, usable, now);
      const jobs = planNotifications([event], channels, now);
      const res = await sendJobs(jobs, this.alert, this.log, now, this.opts.store);
      const held = quietHeldKinds([event], channels, jobs, now);
      for (const k of backoffHeldKinds([event], waiting, now)) held.add(k);
      undoUnsent(res, new Map([["not_ready", restoreMeta(this.opts.store, NOT_READY_META_KEY, before)]]), this.log, held);
    } catch (err) {
      this.log(`tidegap channels: ticker check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Wait for the ticker check that {@link cycle} started, if one runs. `run`
   * calls it before it returns, so `--once` and a stop finish the alert.
   */
  async tickerSettled(): Promise<void> {
    await this.tickerCheck;
  }

  /**
   * One poll cycle: start the ticker check, one `getUpdates`, each update in
   * order. The ticker check runs beside the poll, at most one at a time: a
   * dead alert receiver can take the 20 s job cap, and Telegram commands must
   * not wait for it. Throws `TelegramError` from `getUpdates`.
   */
  async cycle(): Promise<number> {
    this.tickerCheck ??= this.checkTicker().finally(() => {
      this.tickerCheck = undefined;
    });
    const updates = await this.opts.client.getUpdates({
      offset: this.offset(),
      timeoutS: this.opts.pollTimeoutS ?? POLL_TIMEOUT_S,
      signal: this.opts.signal,
    });
    for (const u of updates) {
      // Stored before the update runs: a crash mid-update drops it rather than running it twice.
      this.opts.store.setMeta(OFFSET_META_KEY, String(u.update_id + 1));
      try {
        await this.handle(u);
      } catch (err) {
        this.log(`tidegap channels: update ${u.update_id} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return updates.length;
  }

  private async send(chatId: number, messages: readonly OutgoingMessage[]): Promise<void> {
    for (const m of messages) await this.opts.client.sendMessage(chatId, m.text, { buttons: m.buttons });
  }

  /** Handle one update from a paired chat; drop every other update silently. */
  async handle(u: TelegramUpdate): Promise<void> {
    const chatId = updateChatId(u);
    if (chatId === undefined) return;
    if (!pairedChannels(this.opts.store).some((c) => telegramChatId(c) === chatId)) return;
    if (u.message?.text !== undefined) {
      let listing = this.listings.get(chatId);
      if (!listing) this.listings.set(chatId, (listing = new QueueListing()));
      await this.send(chatId, await runCommand(parseCommand(u.message.text), this.opts.commands, listing));
      return;
    }
    const cq = u.callback_query;
    if (!cq) return;
    const out = await runCallback(cq.data ?? "", this.opts.commands);
    await this.opts.client.answerCallbackQuery(cq.id, out.answer);
    if (out.removeButtons && cq.message) {
      await this.opts.client.editMessageReplyMarkup(chatId, cq.message.message_id).catch((err: unknown) => {
        this.log(`tidegap channels: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
    await this.send(chatId, out.messages);
  }

  /** Poll until aborted (or one cycle with `once`). Returns false when the last cycle failed. */
  async run(opts: { once?: boolean } = {}): Promise<boolean> {
    let backoff = BACKOFF_MIN_MS;
    let ok = true;
    const signal = this.opts.signal;
    await this.startup();
    while (!signal?.aborted) {
      try {
        await this.cycle();
        backoff = BACKOFF_MIN_MS;
        ok = true;
        this.heartbeat("ok");
      } catch (err) {
        ok = false;
        if (signal?.aborted) break;
        this.heartbeat(errorState(err));
        const msg = err instanceof Error ? err.message : String(err);
        if (err instanceof TelegramError && err.kind === "unauthorized") {
          this.log(`tidegap channels: ${msg}; the bot token was refused, retrying in 10 minutes`);
          if (!opts.once) await this.sleep(UNAUTHORIZED_SLEEP_MS, signal);
        } else {
          const wait = err instanceof TelegramError && err.retryAfterS ? err.retryAfterS * 1000 : backoff;
          const why = err instanceof TelegramError && err.kind === "conflict" ? " (another program polls this bot)" : "";
          this.log(`tidegap channels: ${msg}${why}; retrying in ${Math.round(wait / 1000)} s`);
          if (!opts.once) await this.sleep(wait, signal);
          backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
        }
      }
      if (opts.once) break;
    }
    await this.tickerSettled();
    return ok;
  }
}

/** The heartbeat state of a failed Telegram call. */
function errorState(err: unknown): ListenerHeartbeat["state"] {
  if (err instanceof TelegramError && err.kind === "unauthorized") return "unauthorized";
  if (err instanceof TelegramError && err.kind === "conflict") return "conflict";
  return "network";
}
