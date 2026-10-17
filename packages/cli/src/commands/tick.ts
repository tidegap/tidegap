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
  buildDefaultGridFeed,
  carbonBudgetConfigPath,
  GeminiAdapter,
  loadCarbonBudgetConfig,
  loadQuotaResetConfig,
  OllamaAdapter,
  OpenAIAdapter,
  osNotifyCommand,
  parseKeyValues,
  resolveTidegapHome,
  prepareTick,
  resolveRegion,
  Scheduler,
  taskNotificationContent,
  TaskStore,
  type CarbonAlert,
  type TickAdapters,
  type TickResultEntry,
} from "@tidegap/core";
import { spawn, type SpawnOptions } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, platform as osPlatform } from "node:os";
import { join } from "node:path";
import { claudeChildEnv, claudeMaxBudget, claudeTools, findClaudeBinary, type ClaudeLookup } from "../claude-code.js";
import { readEnvCredentials, readUsageEnv, underTest, type ProviderCredentials } from "../env.js";
import { ClaudeCodeAdapter, type LimitReset } from "../providers/claude-code.js";
import { clockLabel, hostResetTarget, type HostLimitsOptions } from "../usage/index.js";
import { loadEnvFileIntoProcess } from "./env-file.js";

export interface TickCommandOptions {
  db?: string;
  daemon?: boolean;
  once?: boolean;
  interval?: number;
  region?: string;
  /** Override the secrets file path (tests). Defaults to ~/.config/tidegap/env. */
  envFile?: string;
  /**
   * Override the ~/.tidegap/config path (tests): carbon budget and quota
   * reset schedules are both read from it.
   */
  budgetConfig?: string;
  /** `false` (`--no-notify`) posts no OS notification for finished tasks. */
  notify?: boolean;
  /** Spawner for the notification command (tests). Defaults to node's spawn. */
  spawnNotify?: NotifySpawner;
  /** Platform for the notification command (tests). Defaults to os.platform(). */
  platform?: NodeJS.Platform;
  /** Inputs for the `claude` binary lookup (tests). Defaults to the real machine. */
  claudeLookup?: ClaudeLookup;
  /** Usage read overrides for the limit reset (tests). */
  usage?: HostLimitsOptions;
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
 * Post one OS notification per task that reached `completed` or `failed`
 * in this tick. Best-effort: an unknown platform, a missing record, or a
 * spawner that throws is skipped silently.
 */
function notifyFinished(
  dbPath: string,
  entries: TickResultEntry[],
  opts: TickCommandOptions,
): void {
  const finished = entries.filter((e) => e.status === "completed" || e.status === "failed");
  if (finished.length === 0) return;
  const platform = opts.platform ?? osPlatform();
  const spawnNotify = opts.spawnNotify ?? defaultSpawnNotify;
  let store: TaskStore | undefined;
  try {
    store = new TaskStore({ dbPath });
    for (const entry of finished) {
      const record = store.get(entry.taskId);
      if (!record) continue;
      const { title, body } = taskNotificationContent(record);
      const command = osNotifyCommand(platform, title, body);
      if (!command) return;
      try {
        spawnNotify(command.cmd, command.args, {
          stdio: "ignore",
          timeout: NOTIFY_TIMEOUT_MS,
          ...(command.env ? { env: { ...process.env, ...command.env } } : {}),
        });
      } catch {
        // ignore: a notification never changes the tick outcome
      }
    }
  } catch {
    // unreadable ledger: skip notifications
  } finally {
    store?.close();
  }
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
  const providers = new Set<string>();
  let store: TaskStore | undefined;
  try {
    store = new TaskStore({ dbPath });
    const pending = [
      ...store.list({ status: "queued" }),
      ...store.list({ status: "scheduled" }),
      ...store.list({ status: "submitted" }),
    ];
    for (const rec of pending) {
      if (!rec.bodyJson) continue;
      let provider: string | undefined;
      try {
        provider = (JSON.parse(rec.bodyJson) as { provider?: string })
          .provider;
      } catch {
        continue;
      }
      if (provider) providers.add(provider);
    }
  } catch {
    // absent / unreadable DB — nothing to warn about.
  } finally {
    store?.close();
  }
  return providers;
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

export async function runTickOnce(
  opts: TickCommandOptions = {},
): Promise<TickRunResult> {
  // Load the standardized secrets file into the environment for any key
  // not already set — covers launchd (bare env), systemd, and manual
  // cron uniformly. Explicit env always wins.
  loadEnvFileIntoProcess(opts.envFile);

  // The CLI is the HOST: it reads its environment here, once (after the
  // secrets file has been folded in), and injects the values into the
  // environment-pure core library.
  const env = readEnvCredentials();
  const dbPath = opts.db ?? defaultDbPath();
  const claudeBin = findClaudeBinary(
    env,
    () => {
      const pending = pendingProviders(dbPath);
      return pending.has("claude-code") || (!env.anthropicApiKey && pending.has("anthropic"));
    },
    opts.claudeLookup,
  );
  const budget = claudeMaxBudget(env.claudeCodeMaxBudgetUsd);
  const toolSet = claudeTools(env.claudeTools);
  const claudeCode = claudeBin
    ? new ClaudeCodeAdapter({
        binaryPath: claudeBin,
        env: claudeChildEnv(),
        maxBudgetUsd: budget.usd,
        defaultTools: toolSet.tools,
        resetTarget: limitResolver(opts),
      })
    : null;
  const adapters = buildAdapters(env, claudeCode);
  if (Object.keys(adapters).length === 0) {
    // Loud warning when pending provider tasks exist but no adapter is
    // configured (no ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY /
    // OLLAMA_HOST).
    const missing = missingProviderKeysForPending(dbPath);
    const detail =
      missing.length > 0
        ? `; pending tasks need ${missing.join(" / ")} — set them in ~/.config/tidegap/env`
        : "";
    return {
      exitCode: 0,
      message:
        `tick: no adapters configured (set ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY, or OLLAMA_HOST for local, ` +
        `or install Claude Code (\`claude\` on PATH, or TIDEGAP_CLAUDE_BIN)); nothing to dispatch${detail}`,
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
    // A quota_reset series rolls to the label's next reset (ui v2).
    quotaConfig: () => quotaConfig,
    defaultRegion: resolveRegion(undefined, opts.region).region,
    // Same feed the MCP server uses, so the receipt's dispatch-time
    // intensity comes from the region's live feed (mock only as fallback).
    feed: buildDefaultGridFeed(env.grid),
    ...(carbonBudget
      ? {
          carbonBudget,
          onCarbonAlert: (a: CarbonAlert) => {
            firedAlerts.push(a);
          },
        }
      : {}),
  });
  try {
    // Shared pre-tick step (same as the OpenClaw loop): record last_tick_at
    // and re-resolve quota_reset tasks whose weekly reset already passed, so
    // they are rescheduled through the window picker, not dispatched late.
    const preTick = await prepareTick(scheduler, { quotaConfig });
    const result = await scheduler.tick(adapters);
    if (opts.notify !== false && !env.noNotify && !notifyDisabledInConfig(opts.budgetConfig)) {
      notifyFinished(dbPath, result.results, opts);
    }
    let msg = `tick: ${result.inspected} inspected, ${result.dispatched} dispatched, ${result.failed} failed`;
    if (result.deferred > 0) {
      const first = Math.min(
        ...result.results.filter((e) => e.status === "deferred" && e.retryAt).map((e) => Date.parse(e.retryAt!)),
      );
      msg += `, ${result.deferred} deferred until ${clockLabel(new Date(first), new Date())}`;
    }
    for (const line of preTick) msg += `\n${line}`;
    if (claudeCode && budget.warning) msg += `\n${budget.warning}`;
    if (claudeCode && toolSet.warning) msg += `\n${toolSet.warning}`;
    for (const a of firedAlerts) {
      msg +=
        `\n!! CARBON BUDGET ALERT: ${a.windowKind} carbon budget crossed — ` +
        `${a.actualG} gCO2e used this window vs ${a.thresholdG} g threshold ` +
        `(crossed by task ${a.taskIdThatCrossed}). ` +
        `Window started ${a.windowStart}.`;
    }
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
