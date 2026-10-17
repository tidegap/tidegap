/**
 * `tidegap channels add telegram | list | remove <id> | serve [--once]`
 * (coherence U14, U15). `installListener` writes and loads the listener
 * unit (`com.tidegap.channels` / `tidegap-channels.service`) through
 * `loadAgent`, and unloads it when pairing starts or the last telegram
 * channel is removed.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { resolveTidegapHome, TaskStore, TelegramClient, telegramChatId, type Channel } from "@tidegap/core";

import { pairTelegram, type InstallListenerHook } from "../channels/pair.js";
import { runListener, type RunListenerOptions } from "../channels/listener.js";
import { loadEnvFileIntoProcess } from "./env-file.js";
import { defaultDbPath } from "./tick.js";
import { readTelegramEnv } from "../env.js";
import {
  channelsUnitPath,
  defaultPlatformExec,
  loadAgent,
  unloadAgent,
  type LoadResult,
  type PlatformExec,
} from "../platform/index.js";
import { CHANNELS_LAUNCHD_LABEL, channelsLaunchdPlist } from "../platform/macos.js";
import { CHANNELS_SYSTEMD_UNIT, channelsSystemdService } from "../platform/linux.js";
import { resolveLauncher } from "./install.js";

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

export interface ListenerUnitOptions {
  platform?: NodeJS.Platform;
  home?: string;
  /** Runs `launchctl` / `systemctl` (tests inject a fake). */
  exec?: PlatformExec;
  /** macOS user id for `gui/<uid>`; default `process.getuid()`. */
  uid?: number;
  /** The argv that invokes `tidegap`; default the resolved install launcher. */
  launcher?: string[];
  dbPath?: string;
  out?: (line: string) => void;
}

function readOr(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * The real `installListener` hook (KTD14). `load` writes the unit file and
 * loads it through `loadAgent` (an unchanged, loaded unit is left alone);
 * `unload` stops the unit and removes its file, so it does not start at the
 * next login. Windows has no unit: `load` prints the command to run.
 */
export function createInstallListener(opts: ListenerUnitOptions = {}): InstallListenerHook {
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? homedir();
  const exec = opts.exec ?? defaultPlatformExec;
  const out = opts.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  return (action) => {
    const path = channelsUnitPath(platform, home);
    if (!path) {
      if (action === "load") out("This platform has no listener unit: keep `tidegap channels serve` running to answer the bot.");
      return;
    }
    const uid = opts.uid ?? process.getuid?.() ?? 0;
    const launchd = platform === "darwin";
    let res: LoadResult;
    if (action === "unload") {
      res = unloadAgent(launchd ? { kind: "launchd", label: CHANNELS_LAUNCHD_LABEL, uid } : { kind: "systemd", unit: `${CHANNELS_SYSTEMD_UNIT}.service` }, exec);
      if (res.ok) rmSync(path, { force: true });
    } else {
      const launcher = resolveLauncher(opts.launcher, []);
      const dataHome = resolveTidegapHome(opts.home !== undefined ? { home } : {});
      const dbPath = opts.dbPath ?? defaultDbPath();
      const logPath = join(dataHome, "logs", "channels.log");
      const content = launchd
        ? channelsLaunchdPlist({ launcher, dbPath, logPath })
        : channelsSystemdService({ launcher, dbPath, logPath });
      const changed = readOr(path) !== content;
      mkdirSync(dirname(path), { recursive: true });
      mkdirSync(dirname(logPath), { recursive: true });
      if (changed) writeFileSync(path, content, "utf8");
      res = loadAgent(
        launchd
          ? { kind: "launchd", label: CHANNELS_LAUNCHD_LABEL, plistPath: path, uid, changed, busy: false }
          : { kind: "systemd", unit: `${CHANNELS_SYSTEMD_UNIT}.service`, changed },
        exec,
      );
    }
    out(res.message);
  };
}

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
  const s = store(opts);
  try {
    const res = await pairTelegram({
      store: s,
      client: new TelegramClient({ token: env.token, baseUrl: env.apiBase, fetch: opts.fetch }),
      out,
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
  return runListener({ ...opts, db: opts.db, envFile: opts.envFile, once: input.once });
}
