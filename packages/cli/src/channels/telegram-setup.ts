/**
 * Telegram setup (integrations plan KTD3): the one module the CLI
 * (`tidegap channels …`) and the page's integrations routes call to read the
 * state, save the token, pair, test, start the listener and disconnect.
 *
 * Rules:
 * - The env file is the token's only store; it is read on every call, never
 *   from `process.env`, so a long-running `tidegap ui` sees a new token (KTD4).
 * - The token never leaves this module: a status carries its last 4
 *   characters only, and errors are fixed sentences (R7, R10).
 * - A bot change resets the update offset and drops the paired chat (KTD6).
 * - Pairing from the page is one in-memory session per process (KTD5).
 * - Listener health is the heartbeat the listener writes to ledger meta (KTD7).
 */

import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { resolveTidegapHome, TelegramClient, TelegramError, telegramChatId, type Channel, type TelegramUser } from "@tidegap/core";

import {
  envFilePath,
  envFileTelegramToken,
  isTelegramBotToken,
  setEnvFileKey,
  TELEGRAM_TOKEN_KEYS,
} from "../commands/env-file.js";
import { readOr, resolveLauncher } from "../commands/install.js";
import { defaultDbPath } from "../commands/tick.js";
import { readTelegramEnv } from "../env.js";
import {
  channelsUnitPath,
  defaultPlatformExec,
  loadAgent,
  unloadAgent,
  type LoadResult,
  type PlatformExec,
} from "../platform/index.js";
import { CHANNELS_LAUNCHD_LABEL, channelsLaunchdPlist, LAUNCHD_LABEL } from "../platform/macos.js";
import { CHANNELS_SYSTEMD_UNIT, channelsSystemdService, SYSTEMD_UNIT } from "../platform/linux.js";
import { pairTelegram, type InstallListenerHook, type PairFailure, type PairStore } from "./pair.js";
import { BOT_ID_META_KEY, LISTENER_META_KEY, readHeartbeat, syncBotId } from "./serve.js";

// ---------------------------------------------------------------------------
// Listener unit (moved from commands/channels.ts)

export interface ListenerUnitOptions {
  platform?: NodeJS.Platform;
  home?: string;
  /** Runs `launchctl` / `systemctl` (tests inject a fake). */
  exec?: PlatformExec;
  /** macOS user id for `gui/<uid>`; default `process.getuid()`. */
  uid?: number;
  /** The argv that invokes `tidegap`; default the installed tick unit's, else the resolved install launcher. */
  launcher?: string[];
  dbPath?: string;
  out?: (line: string) => void;
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * The launcher of the installed tick daemon unit: the `ProgramArguments`
 * (launchd) or `ExecStart` (systemd) words before `tick`; undefined when no
 * unit is installed. A listener unit written from inside `tidegap ui` must not
 * copy that process's own argv, which may be a transient command (KTD3).
 */
export function installedTickLauncher(platform: NodeJS.Platform = process.platform, home: string = homedir()): string[] | undefined {
  let args: string[] | undefined;
  if (platform === "darwin") {
    const xml = readOr(join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`));
    const block = xml && /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml)?.[1];
    if (block) args = [...block.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => unescapeXml(m[1]!));
  } else if (platform !== "win32") {
    const unit = readOr(join(home, ".config", "systemd", "user", `${SYSTEMD_UNIT}.service`));
    const line = unit && /^ExecStart=(.+)$/m.exec(unit)?.[1];
    if (line) args = line.trim().split(/\s+/);
  }
  const i = args?.indexOf("tick") ?? -1;
  return args && i > 0 ? args.slice(0, i) : undefined;
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
      const launcher = opts.launcher ?? installedTickLauncher(platform, home) ?? resolveLauncher(undefined, []);
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

// ---------------------------------------------------------------------------
// Status and actions

/** The card states (R1). */
export type TelegramState = "not_configured" | "token_saved" | "pairing" | "paired" | "error";

/** The listener state of a paired chat (R1, KTD7). */
export type ListenerState = "running" | "not_running" | "conflict" | "unauthorized" | "manual";

export interface TelegramStatus {
  state: TelegramState;
  /** Last 4 characters of the saved token; never more. */
  token_hint?: string;
  bot_username?: string;
  /** The paired chat. */
  chat?: { channel_id: string; label?: string };
  pairing?: { code: string; bot_username: string; link: string; expires_at: string };
  listener?: { state: ListenerState; message?: string };
  /** The error sentence (state `error`). */
  error?: string;
}

/** Why an action was refused; the API maps it to a status code. */
export type SetupErrorCode = "format" | "refused" | "webhook" | "network" | "no_token" | "not_paired" | "manual" | "telegram";

/** A refused action with its one plain sentence (R7). */
export class TelegramSetupError extends Error {
  override name = "TelegramSetupError";
  constructor(
    readonly code: SetupErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** The plain sentences (R7). No sentence holds a token or a path. */
export const SETUP_TEXT = {
  format: "This does not look like a bot token. Copy the whole token from @BotFather.",
  refused: "Telegram refused this token. Copy it again from @BotFather.",
  webhook: "Another program uses this bot (it has a webhook). Create a new bot for Tidegap.",
  network: "Could not reach Telegram. Check the internet connection and try again.",
  no_token: "Save a bot token first.",
  not_paired: "Connect a chat first.",
  manual: "This computer has no listener service. Keep `tidegap channels serve` running.",
  telegram: "Telegram did not accept the test message. Try again in a minute.",
  pair_conflict: "Another program or another pairing reads this bot's messages. Close it, or create a new bot for Tidegap.",
  pair_timeout: "No code arrived within 10 minutes. Press Connect to get a new code.",
  pair_wrong_codes: "Five wrong codes arrived, so pairing stopped. Press Connect to try again.",
  pair_error: "Pairing stopped with an error. Press Connect to try again.",
  listener_conflict: "Another program reads this bot's messages. Create a new bot for Tidegap.",
  listener_unauthorized: "Telegram refused the saved token. Paste a new token from @BotFather.",
  listener_network: "The listener cannot reach Telegram. Check the internet connection.",
  listener_not_running: "The listener is not running. Press Start listener.",
} as const;

/** The test message text (U2). */
export const TEST_MESSAGE = "Test message from Tidegap. Notifications work.";

const PAIR_FAILURE_TEXT: Record<PairFailure, string> = {
  refused: SETUP_TEXT.refused,
  webhook: SETUP_TEXT.webhook,
  conflict: SETUP_TEXT.pair_conflict,
  timeout: SETUP_TEXT.pair_timeout,
  wrong_codes: SETUP_TEXT.pair_wrong_codes,
  aborted: SETUP_TEXT.pair_error,
  error: SETUP_TEXT.pair_error,
};

/** Listener heartbeat ages (KTD7). */
const FRESH_MS = 3 * 60_000;
const UNAUTHORIZED_FRESH_MS = 11 * 60_000;
/** How long a `getMe` answer is reused for the status (KTD7). */
const BOT_CACHE_MS = 10 * 60_000;

/** The ledger calls setup needs (a `TaskStore` satisfies it). */
export type SetupStore = PairStore;

export interface TelegramSetupOptions {
  store: SetupStore;
  /** Default `~/.config/tidegap/env`. */
  envFile?: string;
  /** Default the loopback override from the env, else the public Bot API. */
  apiBase?: string;
  fetch?: typeof fetch;
  /** Default the real listener unit hook, writing nothing to stdout. */
  installListener?: InstallListenerHook;
  /** For the listener state: `manual` where the platform has no unit. */
  platform?: NodeJS.Platform;
  home?: string;
  dbPath?: string;
  now?: () => number;
  /** Tests: pairing overrides. */
  pair?: { code?: string; timeoutMs?: number; pollTimeoutS?: number };
}

interface PairSession {
  code: string;
  botUsername: string;
  expiresAt: number;
  controller: AbortController;
  done: Promise<void>;
}

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function telegramChannels(store: Pick<SetupStore, "listChannels">): Channel[] {
  return store.listChannels().filter((c) => c.kind === "telegram");
}

export class TelegramSetup {
  private readonly store: SetupStore;
  private readonly envFile: string;
  private readonly apiBase: string;
  private readonly hook: InstallListenerHook;
  private readonly now: () => number;
  private session: PairSession | undefined;
  /** The failure of the last pairing; cleared by a new token, pairing or disconnect. */
  private lastFailure: string | undefined;
  private bot: { digest: string; at: number; user?: TelegramUser; refused?: boolean } | undefined;

  constructor(private readonly opts: TelegramSetupOptions) {
    this.store = opts.store;
    this.envFile = opts.envFile ?? envFilePath();
    this.apiBase = opts.apiBase ?? readTelegramEnv().apiBase;
    this.hook = opts.installListener ?? createInstallListener({ platform: opts.platform, home: opts.home, dbPath: opts.dbPath, out: () => {} });
    this.now = opts.now ?? Date.now;
  }

  private client(token: string): TelegramClient {
    return new TelegramClient({ token, baseUrl: this.apiBase, fetch: this.opts.fetch });
  }

  private token(): string | undefined {
    return envFileTelegramToken(this.envFile);
  }

  private hasUnit(): boolean {
    return channelsUnitPath(this.opts.platform ?? process.platform, this.opts.home ?? homedir()) !== null;
  }

  /** `getMe` for the status, cached per token for 10 minutes (KTD7). */
  private async botFor(token: string): Promise<{ user?: TelegramUser; refused?: boolean }> {
    const d = digest(token);
    if (this.bot?.digest === d && this.now() - this.bot.at < BOT_CACHE_MS) return this.bot;
    try {
      this.bot = { digest: d, at: this.now(), user: await this.client(token).getMe() };
    } catch (err) {
      const refused = err instanceof TelegramError && err.kind === "unauthorized";
      // A network failure is retried on the next status; a refusal is kept.
      this.bot = refused ? { digest: d, at: this.now(), refused } : undefined;
      return { refused };
    }
    return this.bot;
  }

  private listenerState(): NonNullable<TelegramStatus["listener"]> {
    if (!this.hasUnit()) return { state: "manual", message: SETUP_TEXT.manual };
    const hb = readHeartbeat(this.store);
    const age = (iso: string | undefined) => (iso ? this.now() - Date.parse(iso) : Infinity);
    if (hb?.state === "unauthorized" && age(hb.at) < UNAUTHORIZED_FRESH_MS) return { state: "unauthorized", message: SETUP_TEXT.listener_unauthorized };
    if (age(hb?.conflict_at) < FRESH_MS) return { state: "conflict", message: SETUP_TEXT.listener_conflict };
    if (hb?.state === "network" && age(hb.at) < FRESH_MS) return { state: "not_running", message: SETUP_TEXT.listener_network };
    if (age(hb?.at) < FRESH_MS) return { state: "running" };
    return { state: "not_running", message: SETUP_TEXT.listener_not_running };
  }

  /** The card's state (R1). Calls Telegram at most once per token per 10 minutes. */
  async status(): Promise<TelegramStatus> {
    const token = this.token();
    const out: TelegramStatus = { state: "not_configured" };
    if (token) {
      out.token_hint = token.slice(-4);
      const bot = await this.botFor(token);
      if (bot.user?.username) out.bot_username = bot.user.username;
      out.state = bot.refused ? "error" : "token_saved";
      if (bot.refused) out.error = SETUP_TEXT.refused;
    }
    const chat = telegramChannels(this.store).find((c) => c.enabled && telegramChatId(c) !== undefined);
    const s = this.session;
    if (s) {
      out.state = "pairing";
      delete out.error;
      out.pairing = {
        code: s.code,
        bot_username: s.botUsername,
        link: `https://t.me/${s.botUsername}?start=${s.code}`,
        expires_at: new Date(s.expiresAt).toISOString(),
      };
    } else if (chat) {
      out.state = "paired";
      delete out.error;
      out.chat = { channel_id: chat.id, ...(typeof chat.config.label === "string" ? { label: chat.config.label } : {}) };
      out.listener = this.listenerState();
    } else if (token && this.lastFailure && out.state !== "error") {
      out.state = "error";
      out.error = this.lastFailure;
    }
    return out;
  }

  /**
   * Save a token (R2, KTD6): format check, `getMe`, no webhook, then the env
   * file. A different bot drops the paired chat and the offset; the same bot
   * with a new token keeps both and restarts the listener; the same token
   * changes nothing.
   */
  async saveToken(token: string): Promise<void> {
    if (!isTelegramBotToken(token)) throw new TelegramSetupError("format", SETUP_TEXT.format);
    if (this.token() === token) return;
    const client = this.client(token);
    let me: TelegramUser;
    try {
      me = await client.getMe();
      if ((await client.getWebhookInfo()).url) throw new TelegramSetupError("webhook", SETUP_TEXT.webhook);
    } catch (err) {
      throw setupError(err);
    }
    setEnvFileKey(this.envFile, TELEGRAM_TOKEN_KEYS[0], token);
    this.bot = { digest: digest(token), at: this.now(), user: me };
    this.lastFailure = undefined;
    await this.abortPairing();
    this.store.deleteMeta(LISTENER_META_KEY);
    const stored = this.store.getMeta(BOT_ID_META_KEY);
    const otherBot = stored !== undefined && stored !== String(me.id);
    syncBotId(this.store, me.id);
    if (otherBot) {
      for (const c of telegramChannels(this.store)) this.store.removeChannel(c.id);
      await this.hook("unload");
    } else if (telegramChannels(this.store).length > 0) {
      // The listener holds the old token in memory.
      await this.restartListener();
    }
  }

  /** Start pairing (R4, KTD5); returns false when a session was already running. */
  async startPairing(): Promise<boolean> {
    if (this.session) return false;
    const token = this.token();
    if (!token) throw new TelegramSetupError("no_token", SETUP_TEXT.no_token);
    this.lastFailure = undefined;
    this.store.deleteMeta(LISTENER_META_KEY);
    const controller = new AbortController();
    let shown!: (c: { code: string; botUsername: string; expiresAt: number }) => void;
    const codeShown = new Promise<{ code: string; botUsername: string; expiresAt: number }>((r) => (shown = r));
    const run = pairTelegram({
      store: this.store,
      client: this.client(token),
      out: () => {},
      onCode: (c) => shown(c),
      signal: controller.signal,
      installListener: this.hook,
      code: this.opts.pair?.code,
      timeoutMs: this.opts.pair?.timeoutMs,
      pollTimeoutS: this.opts.pair?.pollTimeoutS,
    }).catch((): { exitCode: number; reason: PairFailure } => ({ exitCode: 1, reason: "error" }));
    const first = await Promise.race([codeShown, run]);
    if ("exitCode" in first) {
      // Ended before a code was shown: a refused token or a webhook.
      const reason = first.reason ?? "error";
      if (reason === "refused") throw new TelegramSetupError("refused", SETUP_TEXT.refused);
      if (reason === "webhook") throw new TelegramSetupError("webhook", SETUP_TEXT.webhook);
      throw new TelegramSetupError("network", SETUP_TEXT.network);
    }
    const session: PairSession = {
      ...first,
      controller,
      done: run.then((res) => {
        if (this.session === session) this.session = undefined;
        if (res.exitCode !== 0 && res.reason !== "aborted") this.lastFailure = PAIR_FAILURE_TEXT[res.reason ?? "error"];
      }),
    };
    this.session = session;
    return true;
  }

  /** Abort a running pairing and wait for it to settle; its own `finally` reloads an earlier chat's listener. */
  private async abortPairing(): Promise<void> {
    const s = this.session;
    if (!s) return;
    s.controller.abort();
    await s.done;
  }

  /** Cancel pairing (Cancel button). */
  async cancelPairing(): Promise<void> {
    await this.abortPairing();
    this.lastFailure = undefined;
  }

  /** Stop a running pairing because the server closes (KTD5). */
  close(): Promise<void> {
    return this.abortPairing();
  }

  private pairedChatId(): number {
    const chat = telegramChannels(this.store).find((c) => c.enabled && telegramChatId(c) !== undefined);
    const id = chat ? telegramChatId(chat) : undefined;
    if (id === undefined) throw new TelegramSetupError("not_paired", SETUP_TEXT.not_paired);
    return id;
  }

  /** Send the test message to the paired chat (R5). */
  async sendTest(): Promise<void> {
    const chatId = this.pairedChatId();
    const token = this.token();
    if (!token) throw new TelegramSetupError("no_token", SETUP_TEXT.no_token);
    try {
      await this.client(token).sendMessage(chatId, TEST_MESSAGE);
    } catch (err) {
      const e = setupError(err);
      throw e.code === "network" || e.code === "refused" ? e : new TelegramSetupError("telegram", SETUP_TEXT.telegram);
    }
  }

  private async restartListener(): Promise<void> {
    await this.hook("unload");
    await this.hook("load");
  }

  /** Start (restart) the listener unit (R5): unload, then load, so a loaded but stalled unit restarts too. */
  async startListener(): Promise<void> {
    if (!this.hasUnit()) throw new TelegramSetupError("manual", SETUP_TEXT.manual);
    this.pairedChatId();
    await this.restartListener();
  }

  /** Remove the paired chat and stop the listener (R6); `forgetToken` also deletes the token from the env file. */
  async disconnect(input: { forgetToken?: boolean } = {}): Promise<void> {
    await this.abortPairing();
    this.lastFailure = undefined;
    for (const c of telegramChannels(this.store)) this.store.removeChannel(c.id);
    await this.hook("unload");
    this.store.deleteMeta(LISTENER_META_KEY);
    if (input.forgetToken) {
      for (const key of TELEGRAM_TOKEN_KEYS) setEnvFileKey(this.envFile, key, undefined);
      this.bot = undefined;
    }
  }
}

/** A Telegram failure as a refused action with its sentence. */
function setupError(err: unknown): TelegramSetupError {
  if (err instanceof TelegramSetupError) return err;
  if (err instanceof TelegramError && err.kind === "unauthorized") return new TelegramSetupError("refused", SETUP_TEXT.refused);
  if (err instanceof TelegramError && err.kind === "conflict") return new TelegramSetupError("webhook", SETUP_TEXT.webhook);
  return new TelegramSetupError("network", SETUP_TEXT.network);
}
