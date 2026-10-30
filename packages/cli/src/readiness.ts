/**
 * The CLI's readiness gatherer (coherence U2, KTD2): live facts of this
 * machine fed to the core `assessReadiness`. Used by `tidegap status`, the
 * UI server and the tick.
 *
 * - Daemon: the unit file on disk (`daemonStatus`), then a "loaded" probe
 *   (`launchctl print gui/<uid>/<label>` or `systemctl --user is-active
 *   <unit>.timer`) through an injected exec, cached 30 s per process.
 * - Ticker: ledger meta `last_tick_at`, and the sleep since that tick
 *   (`readSleep` now against meta `last_tick_sleep`), so a gap the machine
 *   slept through is not a missed tick. The loaded probe also reads the
 *   unit's last exit code (`launchctl print`).
 * - Runners: a fresh `tick_runners` snapshot wins, because it reflects the
 *   daemon's own environment; only without one, the `claude` lookup and
 *   the provider keys (process env, then the env file).
 *
 * A missing ledger file reads as "no pending tasks, never ticked" and is
 * never created.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  assessReadiness,
  LAST_TICK_META_KEY,
  pendingProvidersFromStore,
  readTickRunners,
  readTickSleep,
  sleepReadNeeded,
  runnersFromSnapshot,
  snapshotIsFresh,
  TaskStore,
  tickIntervalFor,
  type DaemonFact,
  type Readiness,
  type RunnerFact,
  type SleepReading,
} from "@tidegap/core";

import { findClaudeBinary, isExecutableFile, type ClaudeLookup } from "./claude-code.js";
import { envFilePath, parseEnvFile } from "./commands/env-file.js";
import { defaultDbPath } from "./commands/tick.js";
import { readEnvCredentials, type EnvCredentials, type ProviderCredentials } from "./env.js";
import { daemonStatus, linux, macos } from "./platform/index.js";
import { defaultExec, type ProbeExec } from "./platform/probe.js";
import { readSleep } from "./platform/sleep.js";

export type { ProbeExec };


/** The credentials the runner probe looks at. */
export type ReadinessCreds = ProviderCredentials & Pick<EnvCredentials, "claudeBin" | "claudeCodeDisabled">;

export interface GatherReadinessOptions {
  /** Ledger path; default the CLI's `defaultDbPath()`. */
  dbPath?: string;
  platform?: NodeJS.Platform;
  home?: string;
  exec?: ProbeExec;
  /** macOS user id for the launchd domain; default `process.getuid()`. */
  uid?: number;
  /** Default: `readEnvCredentials()`. The env file fills keys it lacks. */
  creds?: ReadinessCreds;
  /** Default `~/.config/tidegap/env`. */
  envFile?: string;
  claudeLookup?: ClaudeLookup;
  /** The sleep reading now; default {@link readSleep}. */
  sleepNow?: SleepReading | null;
  now?: Date;
}

const PROBE_TTL_MS = 30_000;

/** The daemon as probed: the fact and, on macOS, the unit's last exit code. */
export interface DaemonProbe {
  fact: DaemonFact;
  lastExit: number | null;
}

/** `last exit code = 1` in `launchctl print` output; null for "(never exited)" or no line. */
export function parseLastExit(stdout: string | undefined): number | null {
  const m = /last exit code = (-?\d+)/.exec(stdout ?? "");
  return m ? Number(m[1]) : null;
}

const probeCache = new WeakMap<ProbeExec, Map<string, { at: number; probe: DaemonProbe }>>();

/** The daemon fact: unit file on disk, then the cached loaded probe. */
export function probeDaemon(
  opts: Pick<GatherReadinessOptions, "exec" | "uid">,
  platform: NodeJS.Platform,
  home: string,
  nowMs: number,
): DaemonProbe {
  const onDisk = daemonStatus({ platform, home });
  if (onDisk !== "installed") return { fact: onDisk, lastExit: null };
  let cmd: string;
  let args: string[];
  if (platform === "darwin") {
    const agents = join(home, "Library", "LaunchAgents");
    const label = existsSync(join(agents, `${macos.LAUNCHD_LABEL}.plist`)) ? macos.LAUNCHD_LABEL : macos.LEGACY_LAUNCHD_LABEL;
    const uid = opts.uid ?? process.getuid?.() ?? 0;
    cmd = "launchctl";
    args = ["print", `gui/${uid}/${label}`];
  } else {
    const units = join(home, ".config", "systemd", "user");
    const unit = existsSync(join(units, `${linux.SYSTEMD_UNIT}.timer`)) ? linux.SYSTEMD_UNIT : linux.LEGACY_SYSTEMD_UNIT;
    cmd = "systemctl";
    args = ["--user", "is-active", `${unit}.timer`];
  }
  const exec = opts.exec ?? defaultExec;
  let cache = probeCache.get(exec);
  if (!cache) probeCache.set(exec, (cache = new Map()));
  const key = [platform, home, cmd, ...args].join("\u0000");
  const hit = cache.get(key);
  if (hit && nowMs - hit.at < PROBE_TTL_MS) return hit.probe;
  const { status, stdout } = exec(cmd, args);
  const fact: DaemonFact = status === null ? "installed" : status === 0 ? "loaded" : "installed_not_loaded";
  const probe = { fact, lastExit: fact === "loaded" && platform === "darwin" ? parseLastExit(stdout) : null };
  cache.set(key, { at: nowMs, probe });
  return probe;
}

/** Ledger facts; nothing when the file does not exist or cannot be read. */
function ledgerFacts(dbPath: string): {
  lastTickAt: string | null;
  lastTickSleep: SleepReading | null;
  snapshot: ReturnType<typeof readTickRunners>;
  pending: Record<string, number>;
} {
  const none = { lastTickAt: null, lastTickSleep: null, snapshot: null, pending: {} };
  if (!existsSync(dbPath)) return none;
  let store: TaskStore | undefined;
  try {
    store = new TaskStore({ dbPath });
    return {
      lastTickAt: store.getMeta(LAST_TICK_META_KEY) ?? null,
      lastTickSleep: readTickSleep(store),
      snapshot: readTickRunners(store),
      pending: pendingProvidersFromStore(store),
    };
  } catch {
    return none;
  } finally {
    store?.close();
  }
}

/** Provider keys present in the creds or the env file. */
async function probeRunners(
  opts: GatherReadinessOptions,
  platform: NodeJS.Platform,
  home: string,
  pending: Record<string, number>,
): Promise<RunnerFact> {
  const creds = opts.creds ?? readEnvCredentials();
  let file: Record<string, string> = {};
  const envFile = opts.envFile ?? envFilePath(home);
  try {
    if (existsSync(envFile)) file = parseEnvFile(readFileSync(envFile, "utf8"));
  } catch {
    // An unreadable env file adds no keys.
  }
  const has = (given: string | undefined, ...names: string[]) =>
    Boolean(given?.trim()) || names.some((n) => Boolean(file[n]?.trim()));
  const providers: string[] = [];
  const anthropicKey = has(creds.anthropicApiKey, "ANTHROPIC_API_KEY");
  if (anthropicKey) providers.push("anthropic");
  if (has(creds.openaiApiKey, "OPENAI_API_KEY")) providers.push("openai");
  if (has(creds.geminiApiKey, "GEMINI_API_KEY", "GOOGLE_API_KEY")) providers.push("gemini");
  if (has(creds.ollamaHost, "OLLAMA_HOST")) providers.push("ollama");
  const notes: string[] = [];
  const explicitBin = creds.claudeBin ?? (file.TIDEGAP_CLAUDE_BIN?.trim() || undefined);
  // findClaudeBinary has no PATH fallback for an explicit bin that cannot run; say why.
  if (explicitBin && !creds.claudeCodeDisabled && !(opts.claudeLookup?.isExecutable ?? isExecutableFile)(explicitBin)) {
    notes.push(`TIDEGAP_CLAUDE_BIN=${explicitBin} is not an executable file; claude-code tasks cannot run until it points at the claude binary`);
  }
  const claudeBin = await findClaudeBinary(
    { claudeBin: explicitBin, claudeCodeDisabled: creds.claudeCodeDisabled },
    () => (pending["claude-code"] ?? 0) > 0 || (!anthropicKey && (pending.anthropic ?? 0) > 0),
    opts.claudeLookup ? { platform, home, ...opts.claudeLookup } : undefined,
  );
  if (claudeBin) {
    providers.push("claude-code");
    if (!anthropicKey) providers.push("anthropic");
  }
  return { providers, unknown: [], source: "probe", ...(notes.length ? { notes } : {}) };
}

let runnerCache: { key: string; at: number; fact: RunnerFact } | undefined;

/**
 * {@link probeRunners}, cached {@link PROBE_TTL_MS} per process for the
 * default inputs: the UI server asks on every poll, and the macOS
 * login-shell `claude` lookup can take seconds. Injected creds or lookups
 * (tests, callers) always probe.
 */
async function cachedProbeRunners(
  opts: GatherReadinessOptions,
  platform: NodeJS.Platform,
  home: string,
  pending: Record<string, number>,
  nowMs: number,
): Promise<RunnerFact> {
  if (opts.creds || opts.claudeLookup || opts.envFile) return probeRunners(opts, platform, home, pending);
  const key = [platform, home, ...Object.entries(pending).filter(([, n]) => n > 0).map(([p]) => p).sort()].join("\u0000");
  if (runnerCache && runnerCache.key === key && nowMs - runnerCache.at < PROBE_TTL_MS) return runnerCache.fact;
  const fact = await probeRunners(opts, platform, home, pending);
  runnerCache = { key, at: nowMs, fact };
  return fact;
}

/** Gather this machine's facts and assess readiness. Never throws for a missing ledger. */
export async function gatherReadiness(opts: GatherReadinessOptions = {}): Promise<Readiness> {
  const now = opts.now ?? new Date();
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? homedir();
  const { fact: daemon, lastExit } = probeDaemon(opts, platform, home, now.getTime());
  const intervalS = tickIntervalFor(daemon);
  const ledger = ledgerFacts(opts.dbPath ?? defaultDbPath());
  // `sysctl` runs only for a gap that could raise a problem.
  const sleepNow = !sleepReadNeeded(ledger.lastTickSleep, ledger.lastTickAt, now, intervalS) ? null : opts.sleepNow !== undefined ? opts.sleepNow : readSleep(platform, opts.exec);
  const runners =
    ledger.snapshot && snapshotIsFresh(ledger.snapshot, now, intervalS)
      ? runnersFromSnapshot(ledger.snapshot)
      : await cachedProbeRunners(opts, platform, home, ledger.pending, now.getTime());
  return assessReadiness({
    daemon,
    lastTickAt: ledger.lastTickAt,
    lastTickSleep: ledger.lastTickSleep,
    sleepNow,
    daemonLastExit: lastExit,
    platform,
    tickIntervalS: intervalS,
    runners,
    pendingByProvider: ledger.pending,
    now,
  });
}
