/**
 * `tidegap channels add telegram | list | remove <id> | serve [--once]`
 * (coherence U14, U15). `installListener` writes and loads the listener
 * unit (`com.tidegap.channels` / `tidegap-channels.service`) through
 * `loadAgent`, and unloads it when pairing starts or the last telegram
 * channel is removed.
 */

import { TaskStore, TelegramClient, telegramChatId, type Channel } from "@tidegap/core";

import { pairTelegram, printCode, type InstallListenerHook } from "../channels/pair.js";
import { runListener, type RunListenerOptions } from "../channels/listener.js";
import { createInstallListener } from "../channels/telegram-setup.js";
import { envFileTelegramToken, loadEnvFileIntoProcess } from "./env-file.js";
import { defaultDbPath } from "./tick.js";
import { readTelegramEnv } from "../env.js";
import { channelsUnitPath } from "../platform/index.js";

export interface ChannelsOptions {
  db?: string;
  envFile?: string;
  installListener?: InstallListenerHook;
  out?: (line: string) => void;
  /** Tests: the fetch the Telegram client uses. */
  fetch?: typeof fetch;
  /** Tests: pairing overrides. */
  pairCode?: string;
  pairTimeoutMs?: number;
  pairPollTimeoutS?: number;
}

const ENV_FILE = "~/.config/tidegap/env";

function store(opts: ChannelsOptions): TaskStore {
  return new TaskStore({ dbPath: opts.db ?? defaultDbPath() });
}

/** `tidegap channels add <kind> [--no-load]`; returns the exit code. */
export async function runChannelsAdd(kind: string, input: { noLoad?: boolean } = {}, opts: ChannelsOptions = {}): Promise<number> {
  const out = opts.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  if (kind !== "telegram") {
    out(`tidegap channels add: unknown kind ${JSON.stringify(kind)}; the only kind is telegram (os is built in)`);
    return 1;
  }
  loadEnvFileIntoProcess(opts.envFile);
  const env = readTelegramEnv();
  if (env.apiBaseRejected) out("tidegap channels add telegram: TIDEGAP_TELEGRAM_API_BASE is not a loopback http URL; using the public Bot API");
  if (!env.token) {
    out(`tidegap channels add telegram: no bot token. Create a bot with @BotFather, then add TIDEGAP_TELEGRAM_BOT_TOKEN=<token> to ${ENV_FILE}.`);
    return 1;
  }
  // The listener unit reads the env file only: a token exported in this
  // shell alone would pair a chat that the listener can never answer.
  if (!opts.installListener && !input.noLoad && channelsUnitPath() !== null && envFileTelegramToken(opts.envFile) !== env.token) {
    out(
      `tidegap channels add telegram: put TIDEGAP_TELEGRAM_BOT_TOKEN in ${ENV_FILE}; the listener reads only that file, ` +
        "and the token in this shell is missing there or differs. Or pass --no-load and run `tidegap channels serve` yourself.",
    );
    return 1;
  }
  const s = store(opts);
  try {
    const res = await pairTelegram({
      store: s,
      client: new TelegramClient({ token: env.token, baseUrl: env.apiBase, fetch: opts.fetch }),
      out,
      onCode: printCode(out),
      installListener: opts.installListener ?? createInstallListener({ out, dbPath: opts.db }),
      noLoad: input.noLoad,
      code: opts.pairCode,
      timeoutMs: opts.pairTimeoutMs,
      pollTimeoutS: opts.pairPollTimeoutS,
    });
    return res.exitCode;
  } finally {
    s.close();
  }
}

function describeChannel(c: Channel): string {
  const chat = telegramChatId(c);
  const who = typeof c.config.label === "string" ? ` ${c.config.label}` : "";
  return chat !== undefined ? `chat ${chat}${who}` : "";
}

/** `tidegap channels list [--json]`. */
export function runChannelsList(input: { json?: boolean } = {}, opts: ChannelsOptions = {}): string {
  const s = store(opts);
  let channels: Channel[];
  try {
    channels = s.listChannels();
  } finally {
    s.close();
  }
  if (input.json) return JSON.stringify({ channels });
  if (channels.length === 0) return "No channels. Pair Telegram with `tidegap channels add telegram`. Desktop notifications (os) are built in.";
  const rows = channels.map((c) => [c.id, c.kind, c.enabled ? "on" : "off", c.events.join(","), describeChannel(c)]);
  const header = ["ID", "KIND", "ENABLED", "EVENTS", "TARGET"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  return [header, ...rows].map((r) => r.map((cell, i) => (i < 4 ? cell.padEnd(widths[i]!) : cell)).join("  ")).join("\n");
}

/** `tidegap channels remove <id>`; throws when no channel has that id. Removing the last telegram channel unloads the listener. */
export async function runChannelsRemove(id: string, opts: ChannelsOptions = {}): Promise<string> {
  const s = store(opts);
  let lastTelegram = false;
  try {
    if (!s.removeChannel(id)) throw new Error(`no channel with id ${id}`);
    lastTelegram = !s.listChannels().some((c) => c.kind === "telegram");
  } finally {
    s.close();
  }
  if (lastTelegram) await (opts.installListener ?? createInstallListener({ dbPath: opts.db }))("unload");
  return `Removed channel ${id}. The chat loses access on its next message.`;
}

/** `tidegap channels serve [--once]`: the listener process. */
export function runChannelsServe(input: { once?: boolean } = {}, opts: ChannelsOptions & Omit<RunListenerOptions, "db" | "envFile" | "once"> = {}): Promise<number> {
  return runListener({ ...opts, once: input.once });
}
