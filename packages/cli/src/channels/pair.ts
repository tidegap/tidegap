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
 * 5. The listener unit is loaded through the hook, unless `--no-load`.
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

import { OFFSET_META_KEY } from "./serve.js";

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
  listChannels(): Channel[];
  insertChannel(channel: Channel): void;
  removeChannel(id: string): boolean;
}

export interface PairOptions {
  store: PairStore;
  client: TelegramClient;
  out: (line: string) => void;
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

export interface PairResult {
  exitCode: number;
  channel?: Channel;
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
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const hook = opts.installListener ?? noopInstallListener;
  const fail = (line: string): PairResult => {
    out(`tidegap channels add telegram: ${line}`);
    return { exitCode: 1 };
  };

  let bot: string;
  try {
    const me = await client.getMe();
    bot = me.username ?? "your bot";
    const hook_ = await client.getWebhookInfo();
    if (hook_.url) return fail(DEDICATED_BOT);
  } catch (err) {
    if (err instanceof TelegramError && err.kind === "unauthorized") {
      return fail("Telegram refused the bot token; check TIDEGAP_TELEGRAM_BOT_TOKEN in ~/.config/tidegap/env");
    }
    return fail(err instanceof Error ? err.message : String(err));
  }

  await hook("unload");

  const code = opts.code ?? String(randomInt(0, 1_000_000)).padStart(6, "0");
  const started = now();
  const deadline = started + (opts.timeoutMs ?? PAIR_TIMEOUT_MS);
  out(`Send this to @${bot} from a private chat within 10 minutes:`);
  out(`  /pair ${code}`);
  out(`Or open https://t.me/${bot}?start=${code}`);

  const stored = Number(store.getMeta(OFFSET_META_KEY));
  let offset = Number.isSafeInteger(stored) && stored > 0 ? stored : undefined;
  let wrong = 0;
  let backoff = 1_000;
  while (now() < deadline) {
    let updates;
    try {
      const left = Math.max(0, Math.floor((deadline - now()) / 1000));
      updates = await client.getUpdates({ offset, timeoutS: Math.min(opts.pollTimeoutS ?? 30, left) });
      backoff = 1_000;
    } catch (err) {
      if (err instanceof TelegramError && err.kind === "conflict") return fail(DEDICATED_BOT);
      if (err instanceof TelegramError && err.kind === "unauthorized") return fail("Telegram refused the bot token");
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
          return fail("pairing stopped: five wrong codes");
        }
        await client.sendMessage(m.chat.id, "Wrong code.").catch(() => {});
        continue;
      }
      const channel: Channel = {
        id: telegramChannelId(m.chat.id),
        kind: "telegram",
        enabled: true,
        events: [...EVENT_KINDS],
        config: { chat_id: m.chat.id, ...(label(m) ? { label: label(m) } : {}) },
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
  return fail("pairing timed out: no /pair code arrived within 10 minutes");
}
