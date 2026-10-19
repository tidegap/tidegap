/**
 * The CLI's readiness gatherer (coherence U2, KTD2): live facts of this
 * machine fed to the core `assessReadiness`. Used by `tidegap status`, the
 * UI server and the tick.
 *
 * - Daemon: the unit file on disk (`daemonStatus`), then a "loaded" probe
 *   (`launchctl print gui/<uid>/<label>` or `systemctl --user is-active
 *   <unit>.timer`) through an injected exec, cached 30 s per process.
 * - Ticker: ledger meta `last_tick_at`.
 * - Runners: a fresh `tick_runners` snapshot wins, because it reflects the
 *   daemon's own environment; only without one, the `claude` lookup and
 *   the provider keys (process env, then the env file).
 *
 * A missing ledger file reads as "no pending tasks, never ticked" and is
 * never created.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  assessReadiness,
  LAST_TICK_META_KEY,
  pendingProvidersFromStore,
  readTickRunners,
  runnersFromSnapshot,
  snapshotIsFresh,
  TaskStore,
  tickIntervalFor,
  type DaemonFact,
  type Readiness,
  type RunnerFact,
} from "@tidegap/core";

import { findClaudeBinary, isExecutableFile, type ClaudeLookup } from "./claude-code.js";
import { envFilePath, parseEnvFile } from "./commands/env-file.js";
import { defaultDbPath } from "./commands/tick.js";
import { readEnvCredentials, underTest, type EnvCredentials, type ProviderCredentials } from "./env.js";
import { daemonStatus, linux, macos } from "./platform/index.js";

/** Runs a probe command; `status` null = it could not run. */
export type ProbeExec = (cmd: string, args: string[]) => { status: number | null };

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
  now?: Date;
}

const PROBE_TTL_MS = 30_000;
const PROBE_TIMEOUT_MS = 5_000;

/** Real probe; under a test runner it never spawns (status null). */
const defaultExec: ProbeExec = (cmd, args) => {
  if (underTest()) return { status: null };
  const out = spawnSync(cmd, args, { stdio: "ignore", timeout: PROBE_TIMEOUT_MS });
  return { status: out.error ? null : out.status };
};

const probeCache = new WeakMap<ProbeExec, Map<string, { at: number; fact: DaemonFact }>>();

/** The daemon fact: unit file on disk, then the cached loaded probe. */
function daemonFact(opts: GatherReadinessOptions, platform: NodeJS.Platform, home: string, nowMs: number): DaemonFact {
  const onDisk = daemonStatus({ platform, home });
  if (onDisk !== "installed") return onDisk;
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
  if (hit && nowMs - hit.at < PROBE_TTL_MS) return hit.fact;
  const { status } = exec(cmd, args);
  const fact: DaemonFact = status === null ? "installed" : status === 0 ? "loaded" : "installed_not_loaded";
  cache.set(key, { at: nowMs, fact });
  return fact;
}

/** Ledger facts; nothing when the file does not exist or cannot be read. */
function ledgerFacts(dbPath: string): {
  lastTickAt: string | null;
  snapshot: ReturnType<typeof readTickRunners>;
  pending: Record<string, number>;
} {
  const none = { lastTickAt: null, snapshot: null, pending: {} };
  if (!existsSync(dbPath)) return none;
  let store: TaskStore | undefined;
  try {
    store = new TaskStore({ dbPath });
    return {
      lastTickAt: store.getMeta(LAST_TICK_META_KEY) ?? null,
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
function probeRunners(
  opts: GatherReadinessOptions,
  platform: NodeJS.Platform,
  home: string,
  pending: Record<string, number>,
): RunnerFact {
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
  const claudeBin = findClaudeBinary(
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
function cachedProbeRunners(
  opts: GatherReadinessOptions,
  platform: NodeJS.Platform,
  home: string,
  pending: Record<string, number>,
  nowMs: number,
): RunnerFact {
  if (opts.creds || opts.claudeLookup || opts.envFile) return probeRunners(opts, platform, home, pending);
  const key = [platform, home, ...Object.entries(pending).filter(([, n]) => n > 0).map(([p]) => p).sort()].join("\u0000");
  if (runnerCache && runnerCache.key === key && nowMs - runnerCache.at < PROBE_TTL_MS) return runnerCache.fact;
  const fact = probeRunners(opts, platform, home, pending);
  runnerCache = { key, at: nowMs, fact };
  return fact;
}

/** Gather this machine's facts and assess readiness. Never throws for a missing ledger. */
export function gatherReadiness(opts: GatherReadinessOptions = {}): Readiness {
  const now = opts.now ?? new Date();
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? homedir();
  const daemon = daemonFact(opts, platform, home, now.getTime());
  const intervalS = tickIntervalFor(daemon);
  const ledger = ledgerFacts(opts.dbPath ?? defaultDbPath());
  const runners =
    ledger.snapshot && snapshotIsFresh(ledger.snapshot, now, intervalS)
      ? runnersFromSnapshot(ledger.snapshot)
      : cachedProbeRunners(opts, platform, home, ledger.pending, now.getTime());
  return assessReadiness({
    daemon,
    lastTickAt: ledger.lastTickAt,
    tickIntervalS: intervalS,
    runners,
    pendingByProvider: ledger.pending,
    now,
  });
}
