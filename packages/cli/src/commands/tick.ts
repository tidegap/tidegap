/**
 * `tidegap tick` — drain due provider-call tasks.
 *
 * One-shot by default; `--daemon` loops on the supplied interval until
 * SIGINT. Reads API keys from the environment and constructs the
 * matching adapters lazily. If neither key is set we still exit 0 with
 * a warning — useful for "this cron only kicks in once a key is added".
 */

import {
  AnthropicAdapter,
  assessReadiness,
  buildDefaultGridFeed,
  carbonBudgetConfigPath,
  GeminiAdapter,
  jobPausedTitle,
  LAST_TICK_META_KEY,
  TICKER_CODES,
  loadCarbonBudgetConfig,
  loadQuotaResetConfig,
  OllamaAdapter,
  OpenAIAdapter,
  osChannel,
  osNotifyCommand,
  parseKeyValues,
  pendingProvidersFromStore,
  resolveTidegapHome,
  prepareTick,
  sweepJobs,
  runnersFromSnapshot,
  Scheduler,
  taskNotificationContent,
  TaskStore,
  TelegramClient,
  writeTickRunners,
  TICK_BY_META_KEY,
  writeTickSleep,
  type CarbonAlert,
  type ChannelEvent,
  type SleepReading,
  type CleanWindowEvent,
  type GridFeed,
  type TickAdapters,
  type TickResultEntry,
  type TickRunnersSnapshot,
} from "@tidegap/core";
import { spawn, type SpawnOptions } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir, platform as osPlatform } from "node:os";
import { dirname, join } from "node:path";
import {
  claudeChildEnv,
  claudeMaxBudget,
  claudeResumeMaxBudget,
  claudeTools,
  findClaudeBinary,
  type ClaudeLookup,
} from "../claude-code.js";
import { macos } from "../platform/index.js";
import { readSleep } from "../platform/sleep.js";
import { resumeSettings } from "../session/plan.js";
import { channelSender, emitEvents, registryDeps, RUNNER_CODES, splitBackoff, type ChannelSender } from "../channels/emit.js";
import { channelSecretsPath } from "../channels/secrets.js";
import { readEnvCredentials, readTelegramEnv, readUsageEnv, underTest, type ProviderCredentials } from "../env.js";
import { ClaudeCodeAdapter, type LimitReset } from "../providers/claude-code.js";
import { CommandAdapter } from "../providers/command.js";
import { jobSecretsPath, readJobSecrets } from "../jobs/secrets.js";
import { nextCleanWindow } from "../ui/summary.js";
import { clockLabel, hostResetTarget, type HostLimitsOptions } from "../usage/index.js";
import { envFileTelegramToken, loadEnvFileIntoProcess } from "./env-file.js";
import { currentRegion } from "../region.js";
import { tryFileLock, type FileLock } from "../atomic-file.js";

export interface TickCommandOptions {
  db?: string;
  daemon?: boolean;
  once?: boolean;
  interval?: number;
  region?: string;
  /** Override the secrets file path (tests). Defaults to ~/.config/tidegap/env. */
  envFile?: string;
  /** Channel secrets file; default `~/.config/tidegap/channel-secrets.json`. */
  secretsFile?: string;
  /**
   * Override the ~/.tidegap/config path (tests): carbon budget and quota
   * reset schedules are both read from it.
   */
  budgetConfig?: string;
  /** `false` (`--no-notify`) posts no OS notification for finished tasks. */
  notify?: boolean;
  /** Channel sender (tests); default Telegram from `readTelegramEnv()` plus the OS toast. */
  channelSend?: ChannelSender;
  /** Spawner for the notification command (tests). Defaults to node's spawn. */
  spawnNotify?: NotifySpawner;
  /** Platform for the notification command (tests). Defaults to os.platform(). */
  platform?: NodeJS.Platform;
  /** Inputs for the `claude` binary lookup (tests). Defaults to the real machine. */
  claudeLookup?: ClaudeLookup;
  /** Usage read overrides for the limit reset (tests). */
  usage?: HostLimitsOptions;
  /** Who started this tick (tests); default {@link tickStartedBy} on this process. */
  startedBy?: TickSource;
  /** The sleep reading (tests); default {@link readSleep}. */
  sleepNow?: SleepReading | null;
  /** Job secrets file; default `~/.config/tidegap/job-secrets.json`. */
  jobSecretsFile?: string;
}

/** Who started a tick: the unit (launchd, systemd, a `tick --daemon` loop) or a person. */
export type TickSource = "unit" | "manual";

/**
 * `unit` for a `--daemon` loop, a launchd job (launchd sets
 * `XPC_SERVICE_NAME` to the job label) or a systemd service (it sets
 * `INVOCATION_ID`); else `manual`, such as `tidegap tick --once` from a shell.
 */
export function tickStartedBy(env: NodeJS.ProcessEnv, daemon = false): TickSource {
  if (daemon) return "unit";
  const label = env.XPC_SERVICE_NAME;
  if (label === macos.LAUNCHD_LABEL || label === macos.LEGACY_LAUNCHD_LABEL) return "unit";
  return env.INVOCATION_ID ? "unit" : "manual";
}

/**
 * The claude-code adapter's limit resolver (KTD13): a forced usage read
 * (skips the TTL, honors a 429 back-off, reuses an entry under 60 s).
 */
function limitResolver(opts: TickCommandOptions): (model: string) => Promise<LimitReset | undefined> {
  return async (model) => {
    const res = await hostResetTarget({ env: readUsageEnv(), ...opts.usage, force: true, model });
    return res.ok ? { at: res.target.at, exhausted: res.target.exhausted } : undefined;
  };
}

/** Starts a notification process; the tick never waits on it. */
export type NotifySpawner = (cmd: string, args: string[], opts: SpawnOptions) => void;

const NOTIFY_TIMEOUT_MS = 5_000;

const defaultSpawnNotify: NotifySpawner = (cmd, args, opts) => {
  // A test that reaches the default spawner must not post a real notification.
  if (underTest()) return;
  const child = spawn(cmd, args, opts);
  // A missing binary (no notify-send) or a failed toast is not a tick error.
  child.on("error", () => {});
  child.unref();
};

/** `TIDEGAP_NOTIFY=0` (or false/off/no) in ~/.tidegap/config turns notifications off. */
export function notifyDisabledInConfig(path: string = carbonBudgetConfigPath()): boolean {
  try {
    if (!existsSync(path)) return false;
    const v = parseKeyValues(readFileSync(path, "utf8")).TIDEGAP_NOTIFY;
    return v !== undefined && /^(0|false|off|no)$/i.test(v.trim());
  } catch {
    return false;
  }
}

/**
 * The OS toast for a done or failed event, the `os` channel's sender.
 * Best-effort: an unknown platform or a spawner that throws posts nothing.
 */
function osToast(event: ChannelEvent, opts: TickCommandOptions): void {
  if (event.kind !== "task_done" && event.kind !== "task_failed") return;
  const { title, body } =
    event.kind === "task_failed" && event.jobPaused
      ? { title: "Tidegap: job paused", body: `${jobPausedTitle(event.jobPaused)}\ntidegap jobs resume ${event.jobPaused.jobId}` }
      : taskNotificationContent(event.task);
  const command = osNotifyCommand(opts.platform ?? osPlatform(), title, body);
  if (!command) return;
  try {
    (opts.spawnNotify ?? defaultSpawnNotify)(command.cmd, command.args, {
      stdio: "ignore",
      timeout: NOTIFY_TIMEOUT_MS,
      ...(command.env ? { env: { ...process.env, ...command.env } } : {}),
    });
  } catch {
    // ignore: a notification never changes the tick outcome
  }
}

/** The next clean window from a live forecast (never the mock, never the fallback hour), with whether it is running now. */
async function forecastCleanWindow(feed: GridFeed, region: string, now: Date): Promise<(CleanWindowEvent & { now: boolean }) | null> {
  try {
    const f = await feed.fetchForecast(region, 24);
    if (f.source === "mock") return null;
    const w = nextCleanWindow(
      f.entries.map((e) => ({ t: e.datetime, g: e.carbonIntensityGCo2PerKwh, band: e.band })),
      now,
    );
    return w && !w.fallback ? { start: w.start, end: w.end, g: w.g, now: w.now } : null;
  } catch {
    return null;
  }
}

/** The clean window that is running now. */
async function currentCleanWindow(feed: GridFeed, region: string, now: Date): Promise<CleanWindowEvent | null> {
  const w = await forecastCleanWindow(feed, region, now);
  return w?.now ? { start: w.start, end: w.end, g: w.g } : null;
}

/** The next clean window, running or not, for the daily summary. */
async function upcomingCleanWindow(feed: GridFeed, region: string, now: Date): Promise<CleanWindowEvent | null> {
  const w = await forecastCleanWindow(feed, region, now);
  return w ? { start: w.start, end: w.end, g: w.g } : null;
}

interface TickEmitInput {
  dbPath: string;
  opts: TickCommandOptions;
  /** The providers this tick can serve (the `tick_runners` snapshot). */
  runners: TickRunnersSnapshot;
  results: readonly TickResultEntry[];
  /** OS toasts on (`--no-notify`, `TIDEGAP_NO_NOTIFY`, `TIDEGAP_NOTIFY=0` turn them off). */
  osEnabled: boolean;
  feed: GridFeed;
  region: string;
}

/**
 * Channel events of this tick (coherence U15): done and failed tasks, a
 * clean window that started, the `no_runner` problems, "running again"
 * after a sent daemon alert and, once a day, the
 * daily summary (integrations U15). The OS toast is
 * the implicit `os` channel. Returns the warning lines; never throws.
 */
async function emitTickEvents(input: TickEmitInput): Promise<string[]> {
  const logs: string[] = [];
  let store: TaskStore | undefined;
  try {
    store = new TaskStore({ dbPath: input.dbPath });
    const now = new Date();
    // A channel in backoff does not count: no forecast fetch for it (emit skips it too).
    const channels = splitBackoff(store, store.listChannels(), now).ready;
    const wantsWindow = channels.some((c) => c.enabled && c.events.includes("clean_window"));
    const readiness = assessReadiness({
      daemon: "unknown",
      lastTickAt: now,
      runners: runnersFromSnapshot(input.runners),
      pendingByProvider: pendingProvidersFromStore(store),
      now,
    });
    let send = input.opts.channelSend;
    if (!send) {
      // The env file first, read on every tick: a `tick --daemon` started by
      // the page inherits a process env that keeps an old token (KTD4).
      const tg = readTelegramEnv();
      const token = envFileTelegramToken(input.opts.envFile) ?? tg.token;
      send = channelSender({
        telegram: token ? new TelegramClient({ token, baseUrl: tg.apiBase }) : undefined,
        os: (_message, event) => osToast(event, input.opts),
        // Secrets are read on every send and never enter `process.env` (KTD4, AE6).
        ...registryDeps({ dbPath: input.dbPath, secretsFile: input.opts.secretsFile ?? channelSecretsPath(), log: (line) => logs.push(line) }),
        now: () => now,
      });
    }
    await emitEvents({
      store,
      send,
      results: input.results,
      readiness,
      readinessScope: [...RUNNER_CODES, ...TICKER_CODES],
      cleanWindow: wantsWindow ? await currentCleanWindow(input.feed, input.region, now) : null,
      digest: { store, nextWindow: () => upcomingCleanWindow(input.feed, input.region, now) },
      extraChannels: [osChannel(input.osEnabled)],
      log: (line) => logs.push(line),
      now,
    });
  } catch (err) {
    logs.push(`tidegap: channel events skipped: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    store?.close();
  }
  return logs;
}

export interface TickRunResult {
  exitCode: number;
  message: string;
}

/**
 * Default queue path. Matches the MCP server's persistence default
 * (`~/.tidegap/queue.db`, established in v0.7.1) so `tidegap tick`,
 * `tidegap queue list`, `tidegap receipts list`, and `tidegap stats` all read
 * the same SQLite ledger the MCP server writes to. Prior versions
 * defaulted to `~/.ebb/queue.sqlite`, which silently diverged from
 * the MCP server's actual path — fixed in v0.8.x.
 *
 * If the legacy `~/.ebb/queue.sqlite` exists and the new path
 * doesn't, the legacy path is returned so users who pre-date v0.7.1
 * keep seeing their historical data. Once they begin writing to
 * the new path (via the MCP server), pass `--db` explicitly to
 * read the old one.
 */
export function defaultDbPath(): string {
  const newPath = join(resolveTidegapHome(), "queue.db");
  const legacyPath = join(homedir(), ".ebb", "queue.sqlite");
  if (!existsSync(newPath) && existsSync(legacyPath)) return legacyPath;
  return newPath;
}

/**
 * Build the tick adapters from host-supplied credentials.
 *
 * `@tidegap/core` no longer reads the environment, so the CLI (the host)
 * reads it once via `readEnvCredentials()` and injects the values here. An
 * API adapter appears exactly when its credential is present, Gemini
 * prefers GEMINI_API_KEY over GOOGLE_API_KEY, and Ollama is an explicit
 * OLLAMA_HOST opt-in.
 *
 * `claudeCode` is the claude-code adapter when the `claude` binary was
 * found. It registers as `claude-code`, and also serves `anthropic` tasks
 * when ANTHROPIC_API_KEY is not set. The receipt still records
 * `claude-code`, the provider that actually ran.
 */
export function buildAdapters(
  creds: ProviderCredentials = readEnvCredentials(),
  claudeCode: ClaudeCodeAdapter | null = null,
): TickAdapters {
  const out: TickAdapters = {};
  if (creds.anthropicApiKey) {
    out.anthropic = new AnthropicAdapter({ apiKey: creds.anthropicApiKey });
  }
  if (creds.openaiApiKey) {
    out.openai = new OpenAIAdapter({ apiKey: creds.openaiApiKey });
  }
  // Gemini reads GEMINI_API_KEY, falling back to GOOGLE_API_KEY (resolved in
  // readEnvCredentials, so `geminiApiKey` here is already the winner).
  if (creds.geminiApiKey) {
    out.gemini = new GeminiAdapter({ apiKey: creds.geminiApiKey });
  }
  // Ollama is local + keyless: register it only when OLLAMA_HOST is set
  // (explicit opt-in). The adapter defaults to http://localhost:11434.
  if (creds.ollamaHost) {
    out.ollama = new OllamaAdapter({ host: creds.ollamaHost });
  }
  if (claudeCode) {
    out["claude-code"] = claudeCode;
    if (!out.anthropic) out.anthropic = claudeCode;
  }
  return out;
}

/**
 * Provider key expected in the env for a given provider name. Ollama has no
 * key (it is local + keyless), so it is intentionally absent — a pending
 * Ollama task is never reported as "missing a key". `claude-code` needs no
 * key; when the tick did not find `claude`, TIDEGAP_CLAUDE_BIN is the fix.
 */
const PROVIDER_KEY: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  "claude-code": "TIDEGAP_CLAUDE_BIN",
};

/**
 * The distinct providers of pending provider-call tasks in the ledger.
 * Best-effort — never throws (a broken/absent DB just yields none).
 */
function pendingProviders(dbPath: string): Set<string> {
  let store: TaskStore | undefined;
  try {
    store = new TaskStore({ dbPath });
    // A command job's summarize provider counts too: it needs its runner.
    return new Set(Object.keys(pendingProvidersFromStore(store)));
  } catch {
    // absent / unreadable DB — nothing to warn about.
    return new Set();
  } finally {
    store?.close();
  }
}

/**
 * True when the ledger has an active or paused command job. Its sweep
 * must run even on a machine with no LLM adapter: a run left `running` by
 * a tick that died is failed and followed only there. Never throws.
 */
function hasCommandJobs(dbPath: string): boolean {
  let store: TaskStore | undefined;
  try {
    store = new TaskStore({ dbPath });
    return store.listJobs({ status: ["active", "paused"] }).some((job) => job.template.runner === "command");
  } catch {
    return false;
  } finally {
    store?.close();
  }
}

/**
 * Inspect the ledger for pending provider-call tasks whose provider key
 * is missing from the environment. Returns the distinct missing keys. A
 * provider that already has an adapter (`anthropic` served by Claude Code)
 * needs no key. Best-effort — never throws.
 */
export function missingProviderKeysForPending(
  dbPath: string,
  adapters: TickAdapters = {},
): string[] {
  const missing = new Set<string>();
  for (const provider of pendingProviders(dbPath)) {
    const key = PROVIDER_KEY[provider];
    if (key && !process.env[key] && !(provider in adapters)) missing.add(key);
  }
  return [...missing];
}

/**
 * Ledger evidence for readiness (coherence KTD2): `last_tick_at`, the
 * `tick_runners` snapshot of the providers this tick can serve, the
 * machine's sleep counter at this tick (`last_tick_sleep`, with the tick
 * time; removed when it cannot be read) and who started the tick
 * (`last_tick_by`). Written before the no-adapter return, so a machine
 * without runners reads as `no_runner`, not `no_daemon`. Best-effort: an
 * unwritable ledger skips it.
 */
function recordTickEvidence(dbPath: string, snapshot: TickRunnersSnapshot, by: TickSource, sleepNow: SleepReading | null): void {
  let store: TaskStore | undefined;
  try {
    store = new TaskStore({ dbPath });
    store.setMeta(LAST_TICK_META_KEY, snapshot.at);
    writeTickRunners(store, snapshot);
    writeTickSleep(store, sleepNow, new Date(snapshot.at));
    store.setMeta(TICK_BY_META_KEY, by);
  } catch {
    // unreadable ledger: the tick itself reports the problem
  } finally {
    store?.close();
  }
}

/**
 * A tick that found another one running still records `last_tick_at`: a
 * job run can hold the lock for many minutes, and readiness must not read
 * that as a dead daemon. The sleep reading moves with it, or readiness
 * could not pair them and would count a later sleep as a dead daemon
 * (`sleep-gap-is-not-a-dead-daemon.md`). Best-effort.
 */
function recordBusyTick(dbPath: string, sleepNow: SleepReading | null): void {
  let store: TaskStore | undefined;
  try {
    store = new TaskStore({ dbPath });
    const at = new Date();
    store.setMeta(LAST_TICK_META_KEY, at.toISOString());
    writeTickSleep(store, sleepNow, at);
  } catch {
    // unreadable ledger: the running tick reports it
  } finally {
    store?.close();
  }
}

/** A tick lock this old belongs to a tick that died; a running tick touches it every {@link TICK_LOCK_TOUCH_MS}. */
export const TICK_LOCK_STALE_MS = 60_000;
const TICK_LOCK_TOUCH_MS = 10_000;

/** The message of a tick that found another one running. */
export const TICK_BUSY_MESSAGE = "tick: another tick is running; skipped";

/**
 * One tick under `<ledger>.tick.lock`: the launchd tick and a manual
 * `tidegap tick` would otherwise both send the daily summary and the same
 * alerts. A second tick exits 0 at once with {@link TICK_BUSY_MESSAGE}. The
 * lock is the env and secrets files' lock (`tryFileLock`): a stale one,
 * left by a crashed tick, is taken over.
 */
export async function runTickOnce(
  opts: TickCommandOptions = {},
): Promise<TickRunResult> {
  const dbPath = opts.db ?? defaultDbPath();
  if (dbPath === ":memory:") return tickBody(opts, dbPath);
  let lock: FileLock | undefined;
  try {
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    lock = tryFileLock(`${dbPath}.tick`, TICK_LOCK_STALE_MS);
  } catch {
    // An unwritable ledger folder: run without the lock; the tick reports the ledger problem.
    return tickBody(opts, dbPath);
  }
  if (!lock) {
    recordBusyTick(dbPath, opts.sleepNow !== undefined ? opts.sleepNow : readSleep());
    return { exitCode: 0, message: TICK_BUSY_MESSAGE };
  }
  const held = lock;
  const touch = setInterval(() => held.touch(), TICK_LOCK_TOUCH_MS);
  touch.unref();
  try {
    return await tickBody(opts, dbPath);
  } finally {
    clearInterval(touch);
    held.release();
  }
}

async function tickBody(opts: TickCommandOptions, dbPath: string): Promise<TickRunResult> {
  // Sync the standardized secrets file into the environment on every tick,
  // so a `--daemon` drops a removed key and picks up a changed one — covers
  // launchd (bare env), systemd, and manual cron uniformly. Explicit env
  // always wins.
  loadEnvFileIntoProcess(opts.envFile);

  // The CLI is the HOST: it reads its environment here, once (after the
  // secrets file has been folded in), and injects the values into the
  // environment-pure core library.
  const env = readEnvCredentials();
  let needsClaude = false;
  const claudeBin = findClaudeBinary(
    env,
    () => {
      const pending = pendingProviders(dbPath);
      needsClaude = pending.has("claude-code") || (!env.anthropicApiKey && pending.has("anthropic"));
      return needsClaude;
    },
    opts.claudeLookup,
  );
  // The macOS login-shell lookup runs only when a pending task needs
  // Claude Code; when it did not run, "no claude" is unknown, not missing.
  const lookupPlatform = opts.claudeLookup?.platform ?? osPlatform();
  const claudeLookup =
    !claudeBin && !env.claudeCodeDisabled && lookupPlatform === "darwin" && !needsClaude ? "skipped" : "done";
  const budget = claudeMaxBudget(env.claudeCodeMaxBudgetUsd);
  const toolSet = claudeTools(env.claudeTools);
  const resumeBudget = claudeResumeMaxBudget(env.claudeCodeResumeMaxBudgetUsd);
  const resume = resumeSettings({
    resume: env.resume,
    maxTokens: env.resumeMaxTokens,
    claudeConfigDir: env.claudeConfigDir,
  });
  const claudeCode = claudeBin
    ? new ClaudeCodeAdapter({
        binaryPath: claudeBin,
        env: claudeChildEnv(),
        maxBudgetUsd: budget.usd,
        resumeMaxBudgetUsd: resumeBudget.usd,
        resume,
        defaultTools: toolSet.tools,
        resetTarget: limitResolver(opts),
      })
    : null;
  const adapters = buildAdapters(env, claudeCode);
  const llmAdapterCount = Object.keys(adapters).length;
  // The scheduler is built below; the command adapter reads job rows through it.
  let ledgerOf: () => TaskStore | undefined = () => undefined;
  adapters.command = new CommandAdapter({
    adapters,
    jobRunner: (jobId) => ledgerOf()?.getJob(jobId)?.template.runner,
    readSecrets: (names) => readJobSecrets(names, opts.jobSecretsFile ?? jobSecretsPath()),
  });
  const runners: TickRunnersSnapshot = { at: new Date().toISOString(), providers: Object.keys(adapters).sort(), claude_lookup: claudeLookup };
  const tickStart = Date.now();
  const sleepNow = opts.sleepNow !== undefined ? opts.sleepNow : readSleep();
  recordTickEvidence(dbPath, runners, opts.startedBy ?? tickStartedBy(process.env, opts.daemon), sleepNow);
  const region = currentRegion({ flag: opts.region, env: env.defaultRegion, configPath: opts.budgetConfig }).region;
  const feed = buildDefaultGridFeed(env.grid);
  const emit = (results: readonly TickResultEntry[]) =>
    emitTickEvents({
      dbPath,
      opts,
      runners,
      results,
      osEnabled: opts.notify !== false && !env.noNotify && !notifyDisabledInConfig(opts.budgetConfig),
      feed,
      region,
    });
  if (llmAdapterCount === 0 && !pendingProviders(dbPath).has("command") && !hasCommandJobs(dbPath)) {
    // Loud warning when pending provider tasks exist but no adapter is
    // configured (no ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY /
    // OLLAMA_HOST).
    const missing = missingProviderKeysForPending(dbPath);
    const detail =
      missing.length > 0
        ? `; pending tasks need ${missing.join(" / ")} — set them in ~/.config/tidegap/env`
        : "";
    const warnings = await emit([]);
    return {
      exitCode: 0,
      message:
        `tick: no adapters configured (set ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY, or OLLAMA_HOST for local, ` +
        `or install Claude Code (\`claude\` on PATH, or TIDEGAP_CLAUDE_BIN)); nothing to dispatch${detail}` +
        warnings.map((w) => `\n${w}`).join(""),
    };
  }
  // Even with some keys present, warn about pending tasks needing a key
  // we do not have (e.g. OpenAI tasks queued but only ANTHROPIC set).
  const missingForPending = missingProviderKeysForPending(dbPath, adapters);
  // Aggregate carbon-budget alerts (ROADMAP item 4): read the local budget
  // config (env wins over ~/.tidegap/config) and log any crossing prominently.
  // Core no longer reads the environment, so the two TIDEGAP_CARBON_BUDGET_*
  // variables are read here and passed in — same precedence as before.
  const carbonBudget = loadCarbonBudgetConfig({
    path: opts.budgetConfig,
    env: env.carbonBudget,
  });
  const firedAlerts: CarbonAlert[] = [];
  const quotaConfig = loadQuotaResetConfig(
    opts.budgetConfig !== undefined ? { path: opts.budgetConfig } : {},
  );
  const scheduler = new Scheduler({
    dbPath,
    actor: "tick",
    // A quota_reset series rolls to the label's next reset (ui v2).
    quotaConfig: () => quotaConfig,
    defaultRegion: region,
    // Same feed the MCP server uses, so the receipt's dispatch-time
    // intensity comes from the region's live feed (mock only as fallback).
    feed,
    // Stored on each `dispatched` event: the job sweep counts a run's age on awake time.
    sleepCounter: () => sleepNow,
    ...(carbonBudget
      ? {
          carbonBudget,
          onCarbonAlert: (a: CarbonAlert) => {
            firedAlerts.push(a);
          },
        }
      : {}),
  });
  ledgerOf = () => scheduler.ledger();
  try {
    // Shared pre-tick step (same as the OpenClaw loop): record last_tick_at,
    // run the job sweep, and re-resolve quota_reset tasks whose weekly reset
    // already passed, so they are rescheduled through the window picker, not
    // dispatched late.
    const preTick = await prepareTick(scheduler, { quotaConfig, sleepNow });
    const result = await scheduler.tick(adapters);
    // KTD2: a job whose occurrence finished in this tick gets its successor
    // now. A long tick reads the sleep counter again, so sleep during this
    // tick does not age another process's run.
    const sleepAfter = opts.sleepNow !== undefined || Date.now() - tickStart < 60_000 ? sleepNow : readSleep();
    const postTick = (await sweepJobs(scheduler, new Date(), { sleepNow: sleepAfter })).messages;
    const channelWarnings = await emit(result.results);
    let msg = `tick: ${result.inspected} inspected, ${result.dispatched} dispatched, ${result.failed} failed`;
    if (result.deferred > 0) {
      const first = Math.min(
        ...result.results.filter((e) => e.status === "deferred" && e.retryAt).map((e) => Date.parse(e.retryAt!)),
      );
      msg += `, ${result.deferred} deferred until ${clockLabel(new Date(first), new Date())}`;
    }
    for (const line of [...preTick, ...postTick]) msg += `\n${line}`;
    if (claudeCode && budget.warning) msg += `\n${budget.warning}`;
    if (claudeCode && toolSet.warning) msg += `\n${toolSet.warning}`;
    if (claudeCode && resumeBudget.warning) msg += `\n${resumeBudget.warning}`;
    if (claudeCode && resume.warning) msg += `\n${resume.warning}`;
    for (const a of firedAlerts) {
      msg +=
        `\n!! CARBON BUDGET ALERT: ${a.windowKind} carbon budget crossed — ` +
        `${a.actualG} gCO2e used this window vs ${a.thresholdG} g threshold ` +
        `(crossed by task ${a.taskIdThatCrossed}). ` +
        `Window started ${a.windowStart}.`;
    }
    for (const w of channelWarnings) msg += `\n${w}`;
    if (missingForPending.length > 0) {
      msg +=
        `\n!! WARNING: pending tasks need ${missingForPending.join(" / ")} ` +
        `but that key is not set — those tasks cannot dispatch. ` +
        `Add it to ~/.config/tidegap/env.`;
    }
    return { exitCode: result.failed > 0 ? 1 : 0, message: msg };
  } finally {
    scheduler.shutdown();
  }
}

export async function runTick(opts: TickCommandOptions = {}): Promise<number> {
  if (opts.daemon) {
    const interval = Math.max(1, opts.interval ?? 60);
    // eslint-disable-next-line no-console
    console.log(`[tidegap] tick daemon: every ${interval}s, db=${opts.db ?? defaultDbPath()}`);
    let stopped = false;
    const onSignal = () => {
      stopped = true;
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    while (!stopped) {
      const result = await runTickOnce(opts);
      // eslint-disable-next-line no-console
      console.log(result.message);
      await new Promise((r) => setTimeout(r, interval * 1000));
    }
    return 0;
  }
  const result = await runTickOnce(opts);
  // eslint-disable-next-line no-console
  console.log(result.message);
  return result.exitCode;
}
