/**
 * `tidegap ui` — serve the local task page (timeline, inbox, task detail) on
 * 127.0.0.1 with a per-run bearer token. The page can cancel, reschedule,
 * run now and reply (ui v2): each action writes the ledger through a
 * Scheduler with no adapters. It never dispatches; `tidegap tick` (or the
 * OpenClaw loop) does, and the page can start `tidegap tick --daemon` when no
 * dispatcher is running.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

import {
  buildDefaultGridFeed,
  loadQuotaResetConfig,
  resolveRegion,
  resolveTidegapHome,
  Scheduler,
} from "@tidegap/core";

import { readEnvCredentials, readUsageEnv } from "../env.js";
import { daemonStatus } from "../platform/index.js";
import { gatherReadiness } from "../readiness.js";
import { usageLimitResetSource } from "../usage/reset-source.js";
import { DEFAULT_UI_PORT, removeDiscovery, writeDiscovery } from "../ui/discovery.js";
import { startUiServer, type UiServer, type UiServerOptions } from "../ui/server.js";
import { loadEnvFileIntoProcess } from "./env-file.js";
import { resolveLauncher } from "./install.js";
import { defaultDbPath } from "./tick.js";

export interface UiCommandOptions {
  db?: string;
  /** Explicit port (0 = any free one). Absent: DEFAULT_UI_PORT, else a free port. */
  port?: number;
  /** Port tried when `port` is absent; default DEFAULT_UI_PORT (tests inject one). */
  defaultPort?: number;
  /** Directory of `ui.json` and `ui-clients.json`; default: the Tidegap home. */
  stateDir?: string;
  /** CLI version written to `ui.json`. */
  cliVersion?: string;
  /** `false` (`--no-open`) only prints the URL. */
  open?: boolean;
  region?: string;
}

/** Open a URL in the default browser; failure is silent (the URL is printed). */
export function openBrowser(url: string, platform: NodeJS.Platform = process.platform): void {
  const [cmd, args] =
    platform === "darwin"
      ? ["open", [url]]
      : platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args as string[], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // ignore: the URL is on the terminal
  }
}

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Start the server on `port`. When `fallback` is true and that port is
 * taken, serve on a free port and return the warning to print.
 */
async function listenWithFallback(
  opts: UiServerOptions,
  port: number,
  fallback: boolean,
): Promise<{ server: UiServer; warning?: string }> {
  try {
    return { server: await startUiServer({ ...opts, port }) };
  } catch (err) {
    if (!fallback || (err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
    const server = await startUiServer({ ...opts, port: 0 });
    return {
      server,
      warning:
        `tidegap ui: port ${port} is in use, serving on ${server.port} instead. ` +
        `The browser extension and the Mac app look for port ${port} and will not find this server.`,
    };
  }
}

export async function startUi(
  opts: UiCommandOptions = {},
): Promise<{ server: UiServer; link: string; warning?: string }> {
  // Grid-feed credentials live in the same secrets file the tick reads.
  loadEnvFileIntoProcess();
  const env = readEnvCredentials();
  const token = newToken();
  const dbPath = opts.db ?? defaultDbPath();
  const stateDir = opts.stateDir ?? resolveTidegapHome();
  const feed = buildDefaultGridFeed(env.grid);
  const defaultRegion = resolveRegion(undefined, opts.region).region;
  // Later → after limit reset reads this machine's Claude limits; the API
  // resolves `later_options` with the same source.
  const limitReset = usageLimitResetSource({ env: readUsageEnv() });
  // Writes only: no adapters, so it never dispatches (as `actionScheduler`).
  const scheduler = new Scheduler({
    dbPath,
    feed,
    defaultRegion,
    signing: false,
    eager: false,
    quotaConfig: () => loadQuotaResetConfig(),
    limitReset,
  });
  const { server, warning } = await listenWithFallback(
    {
      token,
      dbPath,
      stateDir,
      feed,
      defaultRegion,
      ...(env.defaultModel ? { defaultModel: env.defaultModel } : {}),
      quota: () => loadQuotaResetConfig(),
      daemonStatus: () => daemonStatus(),
      readiness: () => gatherReadiness({ dbPath }),
      limitReset,
      // Writes only: this scheduler has no adapters and never dispatches.
      scheduler,
      // Start dispatcher spawns this same binary: `<launcher> tick --daemon`.
      launcher: resolveLauncher(undefined, []),
    },
    opts.port ?? opts.defaultPort ?? DEFAULT_UI_PORT,
    opts.port === undefined,
  ).catch((err: unknown) => {
    scheduler.shutdown();
    throw err;
  });
  writeDiscovery(stateDir, {
    pid: process.pid,
    port: server.port,
    url: server.url,
    started_at: new Date().toISOString(),
    cli_version: opts.cliVersion ?? "0.0.0",
  });
  const close = server.close.bind(server);
  server.close = async () => {
    removeDiscovery(stateDir, process.pid);
    await close();
    scheduler.shutdown();
  };
  return { server, link: `${server.url}#token=${token}`, ...(warning ? { warning } : {}) };
}

export async function runUi(opts: UiCommandOptions = {}): Promise<number> {
  const { server, link, warning } = await startUi(opts);
  // eslint-disable-next-line no-console
  if (warning) console.warn(warning);
  // eslint-disable-next-line no-console
  console.log(
    `tidegap ui: ${link}\n` +
      `Serving on 127.0.0.1 only. The link carries a one-run access token; ` +
      `do not share it. Press Ctrl-C to stop.`,
  );
  if (opts.open !== false) openBrowser(link);
  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await server.close();
  return 0;
}
