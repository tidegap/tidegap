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
 * - The update offset is stored in meta after each update, so a restart
 *   never replays a command.
 * - 401: log and sleep 10 minutes. 409 or a network error: back off 5 s
 *   doubling to 60 s.
 * - Log lines carry the Bot API method and status only, never the token.
 */

import {
  assessReadiness,
  LAST_TICK_META_KEY,
  parseCommand,
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
import { notReadyEvent, sendJobs, TICKER_CODES, channelSender, type EmitStore } from "./emit.js";

/** Meta key of the next `getUpdates` offset (KTD11). */
export const OFFSET_META_KEY = "telegram_update_offset";

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
  /** The ledger-only ticker readiness; default {@link tickerReadiness} on this machine. */
  readiness?: () => Readiness;
  log?: (line: string) => void;
  pollTimeoutS?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
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

  constructor(private readonly opts: ListenerOptions) {
    this.log = opts.log ?? ((line) => process.stderr.write(`${line}\n`));
    this.sleep = opts.sleep ?? abortableSleep;
    this.readiness = opts.readiness ?? (() => tickerReadiness(opts.store));
  }

  private offset(): number | undefined {
    const n = Number(this.opts.store.getMeta(OFFSET_META_KEY));
    return Number.isSafeInteger(n) && n > 0 ? n : undefined;
  }

  /** The ticker check (KTD11): send `not_ready` for ticker codes once per change. Never throws. */
  async checkTicker(): Promise<void> {
    try {
      const event = notReadyEvent(this.opts.store, this.readiness(), TICKER_CODES);
      if (!event) return;
      const jobs = pairedChannels(this.opts.store)
        .filter((c) => c.events.includes("not_ready"))
        .map((channel) => ({ channel, event }));
      await sendJobs(jobs, channelSender({ telegram: this.opts.client }), this.log);
    } catch (err) {
      this.log(`tidegap channels: ticker check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** One poll cycle: the ticker check, one `getUpdates`, each update in order. Throws `TelegramError` from `getUpdates`. */
  async cycle(): Promise<number> {
    await this.checkTicker();
    const updates = await this.opts.client.getUpdates({
      offset: this.offset(),
      timeoutS: this.opts.pollTimeoutS ?? POLL_TIMEOUT_S,
      signal: this.opts.signal,
    });
    for (const u of updates) {
      try {
        await this.handle(u);
      } catch (err) {
        this.log(`tidegap channels: update ${u.update_id} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.opts.store.setMeta(OFFSET_META_KEY, String(u.update_id + 1));
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
    while (!signal?.aborted) {
      try {
        await this.cycle();
        backoff = BACKOFF_MIN_MS;
        ok = true;
      } catch (err) {
        ok = false;
        if (signal?.aborted) break;
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
    return ok;
  }
}
