/**
 * The listener process entry point (coherence U14, KTD11):
 * `tidegap channels serve [--once]`. S4b registers the command and runs it
 * under its own KeepAlive unit (`com.tidegap.channels` /
 * `tidegap-channels.service`).
 *
 * Reads the env file and `TIDEGAP_TELEGRAM_BOT_TOKEN`, opens the ledger and
 * a write-only scheduler (no adapters, no signing; the usage module as the
 * limit-reset source), and polls until SIGTERM or SIGINT.
 */

import {
  buildDefaultGridFeed,
  commandContextFor,
  loadQuotaResetConfig,
  resolveRegion,
  Scheduler,
  TaskStore,
  TelegramClient,
} from "@tidegap/core";

import { dirname } from "node:path";

import { loadEnvFileIntoProcess } from "../commands/env-file.js";
import { defaultDbPath } from "../commands/tick.js";
import { readEnvCredentials, readTelegramEnv } from "../env.js";
import { usageLimitResetSource } from "../usage/reset-source.js";
import { channelSender } from "./emit.js";
import { channelSecretsPath, readSecrets } from "./secrets.js";
import { ChannelListener, type ListenerOptions } from "./serve.js";
import { uiPortsFor } from "./url-policy.js";

export interface RunListenerOptions {
  db?: string;
  envFile?: string;
  /** Default `~/.config/tidegap/channel-secrets.json`. */
  secretsFile?: string;
  /** One poll cycle, then exit (QA). */
  once?: boolean;
  log?: (line: string) => void;
  /** Tests: a scheduler or fetch instead of the defaults. */
  scheduler?: Scheduler;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  pollTimeoutS?: number;
  readiness?: ListenerOptions["readiness"];
  sleep?: ListenerOptions["sleep"];
}

/** Run the listener; returns the process exit code. */
export async function runListener(opts: RunListenerOptions = {}): Promise<number> {
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  loadEnvFileIntoProcess(opts.envFile);
  const env = readTelegramEnv();
  if (env.apiBaseRejected) log("tidegap channels: TIDEGAP_TELEGRAM_API_BASE is not a loopback http URL; using the public Bot API");
  if (!env.token) {
    log("tidegap channels serve: no TIDEGAP_TELEGRAM_BOT_TOKEN in ~/.config/tidegap/env; run `tidegap channels add telegram`");
    return 1;
  }
  const dbPath = opts.db ?? defaultDbPath();
  const store = new TaskStore({ dbPath });
  const scheduler =
    opts.scheduler ??
    new Scheduler({
      store,
      feed: buildDefaultGridFeed(readEnvCredentials().grid),
      defaultRegion: resolveRegion(undefined).region,
      signing: false,
      eager: false,
      quotaConfig: () => loadQuotaResetConfig(),
      limitReset: usageLimitResetSource(),
    });
  if (!store.listChannels().some((c) => c.kind === "telegram" && c.enabled)) {
    log("tidegap channels serve: no paired Telegram chat; run `tidegap channels add telegram`");
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  opts.signal?.addEventListener("abort", stop, { once: true });
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    const client = new TelegramClient({ token: env.token, baseUrl: env.apiBase, fetch: opts.fetch });
    const secretsFile = opts.secretsFile ?? channelSecretsPath();
    const listener = new ChannelListener({
      store,
      client,
      send: channelSender({
        telegram: client,
        secrets: (id) => readSecrets(id, secretsFile, log),
        driver: { http: { uiPorts: uiPortsFor(dirname(dbPath)) } },
      }),
      commands: commandContextFor(scheduler, store),
      log,
      signal: controller.signal,
      pollTimeoutS: opts.pollTimeoutS,
      readiness: opts.readiness,
      sleep: opts.sleep,
    });
    const ok = await listener.run({ once: opts.once });
    return ok ? 0 : 1;
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    if (!opts.scheduler) scheduler.shutdown();
    else store.close();
  }
}
