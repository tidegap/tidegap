/**
 * `tidegap channels add telegram` pairing (coherence U14, KTD14). Runs in
 * the foreground and long-polls the bot itself for up to 10 minutes:
 *
 * 1. `getMe` checks the token; a webhook on the bot refuses (a dedicated bot).
 * 2. The listener unit is unloaded through the hook, so only one `getUpdates` consumer exists.
 * 3. A one-time 6-digit code (memory only) is shown; only a private chat that
 *    sends `/pair <code>` (or `/start <code>`, the t.me deep link) pairs.
 *    Five wrong codes end the pairing. A 409 ends it with the dedicated-bot message.
 * 4. The channel row is written and the stored offset moves past the `/pair` update.
 * 5. The listener unit is loaded through the hook, unless `--no-load`. A pairing
 *    that does not finish loads it again when an earlier paired chat remains.
 */

import { randomInt } from "node:crypto";

import {
  EVENT_KINDS,
  parseCommand,
  TelegramError,
  type Channel,
  type TelegramClient,
  type TelegramMessage,
} from "@tidegap/core";

import { abortableSleep, OFFSET_META_KEY, syncBotId } from "./serve.js";

/** Loads or unloads the listener unit (KTD14). S4a ships a no-op; U15 wires it to the platform loader. */
export type InstallListenerHook = (action: "load" | "unload") => void | Promise<void>;

export const noopInstallListener: InstallListenerHook = () => {};

export const PAIR_TIMEOUT_MS = 10 * 60_000;
export const PAIR_MAX_WRONG = 5;

export const DEDICATED_BOT =
  "this bot is used elsewhere; create a dedicated bot with @BotFather and put its token in ~/.config/tidegap/env";

/** The ledger calls pairing needs (a `TaskStore` satisfies it). */
export interface PairStore {
  getMeta(key: string): string | undefined;
  setMeta(key: string, value: string): void;
  deleteMeta(key: string): void;
  listChannels(): Channel[];
  insertChannel(channel: Channel): void;
  removeChannel(id: string): boolean;
}

/** The code to send, shown once pairing listens (KTD3). */
export interface PairCode {
  code: string;
  botUsername: string;
  /** Epoch ms. */
  expiresAt: number;
}

export interface PairOptions {
  store: PairStore;
  client: TelegramClient;
  out: (line: string) => void;
  /** Called once the bot is checked and pairing listens; default prints the three CLI lines through `out`. */
  onCode?: (code: PairCode) => void;
  /** Aborts the pairing; it then ends with reason `aborted`. */
  signal?: AbortSignal;
  installListener?: InstallListenerHook;
  noLoad?: boolean;
  timeoutMs?: number;
  /** Long-poll wait per `getUpdates`, seconds. */
  pollTimeoutS?: number;
  /** The code to show; default a random 6-digit code. */
  code?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Why a pairing ended without a chat. */
export type PairFailure = "refused" | "webhook" | "conflict" | "timeout" | "wrong_codes" | "aborted" | "error";

export interface PairResult {
  exitCode: number;
  channel?: Channel;
  reason?: PairFailure;
}

/** The CLI's three lines for a code (unchanged since 0.19). */
export function printCode(out: (line: string) => void): (c: PairCode) => void {
  return ({ code, botUsername }) => {
    out(`Send this to @${botUsername} from a private chat within 10 minutes:`);
    out(`  /pair ${code}`);
    out(`Or open https://t.me/${botUsername}?start=${code}`);
  };
}

function label(m: TelegramMessage): string | undefined {
  const u = m.from ?? m.chat;
  return u.username ? `@${u.username}` : u.first_name;
}

/** The channel id of a paired chat. */
export function telegramChannelId(chatId: number): string {
  return `telegram-${chatId}`;
}

export async function pairTelegram(opts: PairOptions): Promise<PairResult> {
  const { store, client, out } = opts;
  const hook = opts.installListener ?? noopInstallListener;
  const fail = (line: string, reason: PairFailure): PairResult => {
    out(`tidegap channels add telegram: ${line}`);
    return { exitCode: 1, reason };
  };

  let bot: string;
  try {
    const me = await client.getMe();
    bot = me.username ?? "your bot";
    const webhook = await client.getWebhookInfo();
    if (webhook.url) return fail(DEDICATED_BOT, "webhook");
    // Update ids are per bot: another bot's stored offset would drop every update (KTD6).
    syncBotId(store, me.id);
  } catch (err) {
    if (err instanceof TelegramError && err.kind === "unauthorized") {
      return fail("Telegram refused the bot token; check TIDEGAP_TELEGRAM_BOT_TOKEN in ~/.config/tidegap/env", "refused");
    }
    return fail(err instanceof Error ? err.message : String(err), "error");
  }

  await hook("unload");
  let paired = false;
  try {
    const res = await pollForCode(opts, bot, fail);
    paired = res.exitCode === 0;
    return res;
  } finally {
    // A pairing that did not finish leaves an earlier pairing in place: start its listener again.
    if (!paired && store.listChannels().some((c) => c.kind === "telegram" && c.enabled)) {
      await hook("load");
    }
  }
}

async function pollForCode(opts: PairOptions, bot: string, fail: (line: string, reason: PairFailure) => PairResult): Promise<PairResult> {
  const { store, client, out, signal } = opts;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => abortableSleep(ms, signal));
  const hook = opts.installListener ?? noopInstallListener;
  const code = opts.code ?? String(randomInt(0, 1_000_000)).padStart(6, "0");
  const started = now();
  const deadline = started + (opts.timeoutMs ?? PAIR_TIMEOUT_MS);
  (opts.onCode ?? printCode(out))({ code, botUsername: bot, expiresAt: deadline });

  const stored = Number(store.getMeta(OFFSET_META_KEY));
  let offset = Number.isSafeInteger(stored) && stored > 0 ? stored : undefined;
  let wrong = 0;
  let backoff = 1_000;
  while (now() < deadline) {
    if (signal?.aborted) return fail("pairing stopped", "aborted");
    let updates;
    try {
      const left = Math.max(0, Math.floor((deadline - now()) / 1000));
      updates = await client.getUpdates({ offset, timeoutS: Math.min(opts.pollTimeoutS ?? 30, left), signal });
      backoff = 1_000;
    } catch (err) {
      if (signal?.aborted) return fail("pairing stopped", "aborted");
      if (err instanceof TelegramError && err.kind === "conflict") return fail(DEDICATED_BOT, "conflict");
      if (err instanceof TelegramError && err.kind === "unauthorized") return fail("Telegram refused the bot token", "refused");
      out(`tidegap channels add telegram: ${err instanceof Error ? err.message : String(err)}; retrying`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 30_000);
      continue;
    }
    for (const u of updates) {
      offset = u.update_id + 1;
      store.setMeta(OFFSET_META_KEY, String(offset));
      const m = u.message;
      // Only private chats, and only messages sent after the code was shown.
      if (!m?.text || m.chat.type !== "private" || (m.date !== undefined && m.date * 1000 < started - 5_000)) continue;
      const cmd = parseCommand(m.text);
      if (cmd.kind !== "pair" || cmd.code === undefined) continue;
      if (cmd.code !== code) {
        wrong++;
        if (wrong >= PAIR_MAX_WRONG) {
          await client.sendMessage(m.chat.id, "Wrong code. Pairing stopped.").catch(() => {});
          return fail("pairing stopped: five wrong codes", "wrong_codes");
        }
        await client.sendMessage(m.chat.id, "Wrong code.").catch(() => {});
        continue;
      }
      const who = label(m);
      const channel: Channel = {
        id: telegramChannelId(m.chat.id),
        kind: "telegram",
        enabled: true,
        events: [...EVENT_KINDS],
        config: { chat_id: m.chat.id, ...(who ? { label: who } : {}) },
        createdAt: new Date(now()).toISOString(),
      };
      // v1 pairs one chat: a new pairing replaces the earlier one.
      for (const c of store.listChannels()) {
        if (c.kind === "telegram" && c.id !== channel.id) store.removeChannel(c.id);
      }
      store.insertChannel(channel);
      await client.sendMessage(m.chat.id, "Paired with Tidegap. Send /help for the commands.").catch(() => {});
      out(`Paired chat ${channel.config.label ?? m.chat.id} as channel ${channel.id}.`);
      if (!opts.noLoad) await hook("load");
      return { exitCode: 0, channel };
    }
  }
  return fail("pairing timed out: no /pair code arrived within 10 minutes", "timeout");
}
