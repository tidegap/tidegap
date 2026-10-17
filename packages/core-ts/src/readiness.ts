/**
 * Readiness (coherence KTD1 to KTD3): one answer to "will queued tasks
 * run?" from two facts, a ticker runs and each pending task's provider has
 * a runner. Pure over facts the host gathers; core spawns nothing.
 * A fact nobody can observe is "unknown" and raises no problem (R2).
 */

import type { TaskStatus } from "./types.js";

/**
 * The tick daemon as the host sees it. `installed` = the unit file exists
 * and whether it is loaded was not probed; `unknown` = nothing on this
 * host shows it (Windows, ledger-only hosts such as the MCP server).
 */
export type DaemonFact = "loaded" | "installed" | "installed_not_loaded" | "not_installed" | "unknown";

/** Ledger meta `tick_runners`: the providers a tick's adapters served (KTD2). */
export interface TickRunnersSnapshot {
  /** ISO-8601 time of the tick that wrote it. */
  at: string;
  providers: string[];
  /** `skipped`: the macOS login-shell `claude` lookup did not run (nothing needed it). */
  claude_lookup: "done" | "skipped";
}

/** Which providers have a runner; `unknown` lists providers nobody could check. */
export interface RunnerFact {
  providers: string[];
  unknown: string[];
  source: "snapshot" | "probe";
}

export interface ReadinessFacts {
  daemon: DaemonFact;
  /** Ledger meta `last_tick_at`, or null when no ticker ever ran. */
  lastTickAt?: string | Date | null;
  /** Seconds between ticks; default 300 with a daemon on disk, else 60. */
  tickIntervalS?: number;
  /** Null when no runner fact is known (no fresh snapshot, no probe). */
  runners: RunnerFact | null;
  /** Pending provider-call tasks by provider. */
  pendingByProvider: Record<string, number>;
  now?: Date;
}

export type ReadinessCode = "no_daemon" | "daemon_not_loaded" | "daemon_stale" | "no_runner";

export interface ReadinessProblem {
  code: ReadinessCode;
  /** One plain sentence (R3). */
  message: string;
  /** The fix: a command (`tidegap install`) or one instruction. */
  fix: string;
  /** `no_runner` only. */
  provider?: string;
  /** `no_runner` only: pending tasks of that provider. */
  tasks?: number;
}

/** The readiness result every surface shows; JSON as-is in the API and MCP. */
export interface Readiness {
  ready: boolean;
  /** Ordered `no_daemon`, `daemon_not_loaded`, `daemon_stale`, `no_runner`. */
  problems: ReadinessProblem[];
  /** The first problem's sentence plus its fix; null when ready. */
  line: string | null;
  /** Informational lines that are not problems ("first tick within 5 minutes"). */
  notes: string[];
  ticker: { daemon: DaemonFact; last_tick_at: string | null; interval_s: number; recent: boolean };
  runners: { source: "snapshot" | "probe" | "unknown"; providers: string[]; unknown: string[] };
}

/** Ledger meta key of the {@link TickRunnersSnapshot}. */
export const TICK_RUNNERS_META_KEY = "tick_runners";

const DAEMON_INTERVAL_S = 300;
const NO_DAEMON_INTERVAL_S = 60;
const ENV_FILE = "~/.config/tidegap/env";
const INSTALL = "tidegap install";
const ORDER: readonly ReadinessCode[] = ["no_daemon", "daemon_not_loaded", "daemon_stale", "no_runner"];
const PENDING: readonly TaskStatus[] = ["queued", "scheduled", "submitted"];

/** The fix for a provider with no runner. */
const RUNNER_FIX: Record<string, string> = {
  anthropic: `install Claude Code, or add ANTHROPIC_API_KEY to ${ENV_FILE}`,
  "claude-code": `install Claude Code, or set TIDEGAP_CLAUDE_BIN in ${ENV_FILE}`,
  openai: `add OPENAI_API_KEY to ${ENV_FILE}`,
  gemini: `add GEMINI_API_KEY to ${ENV_FILE}`,
  ollama: `set OLLAMA_HOST in ${ENV_FILE}`,
};

function daemonOnDisk(d: DaemonFact): boolean {
  return d === "loaded" || d === "installed" || d === "installed_not_loaded";
}

/** The default tick interval for a daemon fact (as `DispatcherControl` uses). */
export function tickIntervalFor(daemon: DaemonFact): number {
  return daemonOnDisk(daemon) ? DAEMON_INTERVAL_S : NO_DAEMON_INTERVAL_S;
}

/** Line text: a command fix reads "Run `cmd`."; an instruction reads "Fix: ...". */
function lineOf(p: ReadinessProblem): string {
  return p.fix.startsWith("tidegap ") ? `${p.message} Run \`${p.fix}\`.` : `${p.message} Fix: ${p.fix}.`;
}

/** Assess readiness from gathered facts (KTD1, KTD3). */
export function assessReadiness(facts: ReadinessFacts): Readiness {
  const now = facts.now ?? new Date();
  const intervalS = facts.tickIntervalS ?? tickIntervalFor(facts.daemon);
  const last = facts.lastTickAt ? new Date(facts.lastTickAt) : null;
  const lastMs = last && Number.isFinite(last.getTime()) ? last.getTime() : null;
  const recent = lastMs !== null && now.getTime() - lastMs <= 2 * intervalS * 1000;
  const problems: ReadinessProblem[] = [];
  const notes: string[] = [];

  if (!recent) {
    const d = facts.daemon;
    if (d === "installed_not_loaded") {
      problems.push({
        code: "daemon_not_loaded",
        message: "Tasks will not run: the tick daemon is installed but not loaded.",
        fix: INSTALL,
      });
    } else if (d === "loaded" || d === "installed") {
      if (lastMs === null) {
        notes.push("first tick within 5 minutes");
      } else {
        const min = Math.round((now.getTime() - lastMs) / 60_000);
        problems.push({
          code: "daemon_stale",
          message: `Tasks may not run: the tick daemon last ran ${min} minutes ago (the Mac may have slept).`,
          fix: INSTALL,
        });
      }
    } else {
      problems.push({ code: "no_daemon", message: "Tasks will not run: no tick daemon.", fix: INSTALL });
    }
  }

  const runners = facts.runners;
  if (runners) {
    for (const [provider, count] of Object.entries(facts.pendingByProvider).sort(([a], [b]) => a.localeCompare(b))) {
      if (count <= 0 || runners.providers.includes(provider) || runners.unknown.includes(provider)) continue;
      problems.push({
        code: "no_runner",
        message: `Tasks will not run: ${count} ${provider} ${count === 1 ? "task has" : "tasks have"} no runner.`,
        fix: RUNNER_FIX[provider] ?? `configure the ${provider} provider in ${ENV_FILE}`,
        provider,
        tasks: count,
      });
    }
  }

  problems.sort((a, b) => ORDER.indexOf(a.code) - ORDER.indexOf(b.code));
  return {
    ready: problems.length === 0,
    problems,
    line: problems[0] ? lineOf(problems[0]) : null,
    notes,
    ticker: { daemon: facts.daemon, last_tick_at: lastMs === null ? null : new Date(lastMs).toISOString(), interval_s: intervalS, recent },
    runners: runners
      ? { source: runners.source, providers: [...runners.providers], unknown: [...runners.unknown] }
      : { source: "unknown", providers: [], unknown: [] },
  };
}

/** The runner fact of a snapshot: a skipped lookup leaves `claude-code` and key-less `anthropic` unknown. */
export function runnersFromSnapshot(snapshot: TickRunnersSnapshot): RunnerFact {
  const providers = [...snapshot.providers];
  const unknown =
    snapshot.claude_lookup === "skipped" ? ["claude-code", "anthropic"].filter((p) => !providers.includes(p)) : [];
  return { providers, unknown, source: "snapshot" };
}

/** True when `snapshot` is at most two tick intervals old (KTD2: then it wins over live probes). */
export function snapshotIsFresh(snapshot: TickRunnersSnapshot, now: Date, intervalS: number): boolean {
  const at = Date.parse(snapshot.at);
  return Number.isFinite(at) && now.getTime() - at <= 2 * intervalS * 1000;
}

/** The meta part of a `TaskStore` the snapshot helpers need. */
interface MetaStore {
  getMeta(key: string): string | undefined;
  setMeta(key: string, value: string): void;
}

/** Read the `tick_runners` snapshot; null when absent or malformed. */
export function readTickRunners(store: Pick<MetaStore, "getMeta">): TickRunnersSnapshot | null {
  const raw = store.getMeta(TICK_RUNNERS_META_KEY);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<TickRunnersSnapshot>;
    if (typeof v.at !== "string" || !Array.isArray(v.providers)) return null;
    return {
      at: v.at,
      providers: v.providers.filter((p): p is string => typeof p === "string"),
      claude_lookup: v.claude_lookup === "skipped" ? "skipped" : "done",
    };
  } catch {
    return null;
  }
}

/** Write the `tick_runners` snapshot (every CLI tick, KTD2). */
export function writeTickRunners(store: Pick<MetaStore, "setMeta">, snapshot: TickRunnersSnapshot): void {
  store.setMeta(TICK_RUNNERS_META_KEY, JSON.stringify(snapshot));
}

/** Pending (queued, scheduled, submitted) provider-call tasks by provider. */
export function pendingProvidersFromStore(store: {
  list(filter: { status: TaskStatus }): Array<{ bodyJson?: string }>;
}): Record<string, number> {
  const out: Record<string, number> = {};
  for (const status of PENDING) {
    for (const rec of store.list({ status })) {
      let provider: unknown;
      try {
        provider = (JSON.parse(rec.bodyJson ?? "") as { provider?: unknown }).provider;
      } catch {
        continue;
      }
      if (typeof provider === "string") out[provider] = (out[provider] ?? 0) + 1;
    }
  }
  return out;
}
