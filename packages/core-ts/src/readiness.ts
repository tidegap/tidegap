/**
 * Readiness (coherence KTD1 to KTD3): one answer to "will queued tasks
 * run?" from two facts, a ticker runs and each pending task's provider has
 * a runner. Pure over facts the host gathers; core spawns nothing.
 * A fact nobody can observe is "unknown" and raises no problem (R2).
 */

import type { MetaStore } from "./postpone.js";
import { formatDuration, runLimitsFromDetails, versionedCaps, type DurationValue } from "./run-limits.js";
import type { TickDetails } from "./scheduler.js";
import type { TaskEvent } from "./task-events.js";
import type { ProviderCallSpec, TaskRecord, TaskStatus } from "./types.js";

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
  /** Informational lines from the probe (a configured runner that cannot start). */
  notes?: string[];
}

/**
 * The machine's sleep counter at one moment: how long it slept since boot.
 * Two readings of the same boot give the sleep between them, so a gap in
 * the ticks that sleep explains raises no problem. The host reads it
 * (macOS: `sysctl kern.waketime kern.wake_abs_time`; Linux: boot time minus
 * the monotonic clock); core only compares readings.
 */
export interface SleepReading {
  /** Epoch ms of the boot; tells two boots apart. */
  boot_at: number;
  /** Total ms asleep since the boot. */
  slept_ms: number;
  /** Epoch ms of the last wake, when the host knows it (macOS). */
  woke_at?: number;
  /** Epoch ms of the tick that stored the reading (ledger meta only). */
  at?: number;
}

/** Ledger meta key of the {@link SleepReading} the last CLI tick took. */
export const TICK_SLEEP_META_KEY = "last_tick_sleep";

/**
 * Ledger meta key: who started the last CLI tick. `unit` is the launchd or
 * systemd unit or a `tick --daemon` loop; `manual` is a one-off
 * `tidegap tick --once` from a shell, which proves nothing about the unit.
 */
export const TICK_BY_META_KEY = "last_tick_by";

/** Two readings this far apart in boot time belong to different boots. */
const BOOT_TOLERANCE_MS = 120_000;
/** Sleep shorter than this explains nothing and is not shown. */
const SLEEP_MIN_MS = 60_000;

/**
 * Ms asleep between two readings; 0 when they cannot be compared (missing,
 * another boot, a counter that went back). Never more than `wallGapMs`.
 */
export function sleptBetween(then: SleepReading | null | undefined, now: SleepReading | null | undefined, wallGapMs: number): number {
  if (!then || !now || Math.abs(then.boot_at - now.boot_at) > BOOT_TOLERANCE_MS) return 0;
  const slept = now.slept_ms - then.slept_ms;
  return Number.isFinite(slept) && slept > 0 ? Math.min(slept, Math.max(0, wallGapMs)) : 0;
}

/**
 * True when the sleep counter is worth reading now: a stored reading exists
 * and the wall gap since the last tick is over two intervals (shorter gaps
 * raise no problem, so the read is skipped). Shared by every host.
 */
export function sleepReadNeeded(lastTickSleep: SleepReading | null | undefined, lastTickAt: string | null | undefined, now: Date, intervalS: number): boolean {
  return !!lastTickSleep && now.getTime() - Date.parse(lastTickAt ?? "") > 2 * intervalS * 1000;
}

/** Read the {@link TICK_SLEEP_META_KEY} reading with its tick time; null when absent or malformed. */
export function readTickSleep(store: Pick<MetaStore, "getMeta">): SleepReading | null {
  const raw = store.getMeta(TICK_SLEEP_META_KEY);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<SleepReading>;
    if (!Number.isFinite(v.boot_at) || !Number.isFinite(v.slept_ms) || !Number.isFinite(v.at)) return null;
    return { boot_at: v.boot_at!, slept_ms: v.slept_ms!, at: v.at! };
  } catch {
    return null;
  }
}

/**
 * Write the reading of the tick at `at`; null removes it. The tick time is
 * stored with it: another ticker (the OpenClaw loop) can move `last_tick_at`
 * without a reading, and an old reading must never pair with a newer tick.
 */
export function writeTickSleep(store: Pick<MetaStore, "setMeta"> & { deleteMeta(key: string): void }, reading: SleepReading | null, at: Date): void {
  if (reading) store.setMeta(TICK_SLEEP_META_KEY, JSON.stringify({ boot_at: reading.boot_at, slept_ms: reading.slept_ms, at: at.getTime() }));
  else store.deleteMeta(TICK_SLEEP_META_KEY);
}

export interface ReadinessFacts {
  daemon: DaemonFact;
  /** Ledger meta `last_tick_at`, or null when no ticker ever ran. */
  lastTickAt?: string | Date | null;
  /**
   * The sleep reading the last tick took (ledger meta `last_tick_sleep`).
   * Used only when its `at` is within one interval of `lastTickAt`.
   */
  lastTickSleep?: SleepReading | null;
  /** The sleep reading now. Both readings: sleep after the last tick does not count as a missed tick. */
  sleepNow?: SleepReading | null;
  /** The daemon's last exit code (`launchctl print`), when known. */
  daemonLastExit?: number | null;
  /** Names the machine in the sleep note: "the Mac" on darwin, else "the computer". */
  platform?: NodeJS.Platform;
  /** Seconds between ticks; default 300 with a daemon on disk, else 60. */
  tickIntervalS?: number;
  /** Null when no runner fact is known (no fresh snapshot, no probe). */
  runners: RunnerFact | null;
  /** Pending provider-call tasks by provider. */
  pendingByProvider: Record<string, number>;
  /**
   * The oldest `running` row a locked Node tick dispatched ({@link oldestTickRun}).
   * The tick runs due rows one at a time, so this run holds every other due
   * task while it lasts.
   */
  oldestRun?: OldestRun | null;
  now?: Date;
}

/** A run that holds the tick: its task, when its dispatch began, and its time limit when known. */
export interface OldestRun {
  taskId: string;
  /** ISO-8601 time of its `dispatched` event. */
  startedAt: string;
  timeLimit?: DurationValue;
}

export type ReadinessCode = "no_daemon" | "daemon_not_loaded" | "daemon_stale" | "long_run" | "no_runner";

/** Problems of the ticker, not of the runners: only a process outside the tick can see them (KTD11). */
export const TICKER_CODES: readonly ReadinessCode[] = ["no_daemon", "daemon_not_loaded", "daemon_stale"];

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
  /** `long_run` only: the task that holds the tick. */
  task_id?: string;
}

/** The readiness result every surface shows; JSON as-is in the API and MCP. */
export interface Readiness {
  ready: boolean;
  /** Ordered `no_daemon`, `daemon_not_loaded`, `daemon_stale`, `long_run`, `no_runner`. */
  problems: ReadinessProblem[];
  /** The first problem's sentence plus its fix; null when ready. */
  line: string | null;
  /** Informational lines that are not problems ("first tick within 5 minutes"). */
  notes: string[];
  /**
   * `recent`: no ticker problem. `slept_s`: seconds the machine slept since
   * the last tick (0 when unknown); that time is not counted as missed ticks.
   */
  ticker: { daemon: DaemonFact; last_tick_at: string | null; interval_s: number; recent: boolean; slept_s: number; last_exit: number | null };
  runners: { source: "snapshot" | "probe" | "unknown"; providers: string[]; unknown: string[] };
}

/** Ledger meta key of the {@link TickRunnersSnapshot}. */
export const TICK_RUNNERS_META_KEY = "tick_runners";

const DAEMON_INTERVAL_S = 300;
const NO_DAEMON_INTERVAL_S = 60;
const ENV_FILE = "~/.config/tidegap/env";
const INSTALL = "tidegap install";
const TICK_ONCE = "tidegap tick --once";
const ORDER: readonly ReadinessCode[] = ["no_daemon", "daemon_not_loaded", "daemon_stale", "long_run", "no_runner"];
const PENDING: readonly TaskStatus[] = ["queued", "scheduled", "submitted"];

/** The fix for a provider with no runner. */
const RUNNER_FIX: Record<string, string> = {
  anthropic: `install Claude Code, or add ANTHROPIC_API_KEY to ${ENV_FILE}`,
  "claude-code": `install Claude Code, or set TIDEGAP_CLAUDE_BIN in ${ENV_FILE}`,
  openai: `add OPENAI_API_KEY to ${ENV_FILE}`,
  gemini: `add GEMINI_API_KEY to ${ENV_FILE}`,
  ollama: `set OLLAMA_HOST in ${ENV_FILE}`,
  // Only the CLI tick runs a command job's shell step.
  command: INSTALL,
};

function daemonOnDisk(d: DaemonFact): boolean {
  return d === "loaded" || d === "installed" || d === "installed_not_loaded";
}

/** The default tick interval for a daemon fact (as `DispatcherControl` uses). */
export function tickIntervalFor(daemon: DaemonFact): number {
  return daemonOnDisk(daemon) ? DAEMON_INTERVAL_S : NO_DAEMON_INTERVAL_S;
}

/** Line text: a command fix reads "Run `cmd`."; an instruction reads "Fix: ...". */
export function problemLine(p: ReadinessProblem): string {
  if (p.fix === TICK_ONCE) return `${p.message} Run \`${p.fix}\` and check the error.`;
  return p.fix.startsWith("tidegap ") ? `${p.message} Run \`${p.fix}\`.` : `${p.message} Fix: ${p.fix}.`;
}

/** Local HH:MM. */
function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * "paused while the Mac slept (11:05–11:24)". The clock window needs the
 * wake time and fits only one sleep after the last tick; else the length.
 */
function sleepNote(sleptMs: number, lastMs: number, nowMs: number, wokeAt: number | undefined, platform: NodeJS.Platform | undefined): string {
  const machine = platform === "darwin" ? "the Mac" : "the computer";
  const when =
    wokeAt !== undefined && wokeAt - sleptMs >= lastMs && wokeAt <= nowMs
      ? `${hhmm(wokeAt - sleptMs)}–${hhmm(wokeAt)}`
      : `about ${Math.round(sleptMs / 60_000)} minutes`;
  return `the tick daemon paused while ${machine} slept (${when})`;
}

/** Assess readiness from gathered facts (KTD1, KTD3). */
export function assessReadiness(facts: ReadinessFacts): Readiness {
  const now = facts.now ?? new Date();
  const intervalS = facts.tickIntervalS ?? tickIntervalFor(facts.daemon);
  const last = facts.lastTickAt ? new Date(facts.lastTickAt) : null;
  const lastMs = last && Number.isFinite(last.getTime()) ? last.getTime() : null;
  const wallGap = lastMs === null ? 0 : now.getTime() - lastMs;
  const then = facts.lastTickSleep;
  const paired = then?.at !== undefined && lastMs !== null && Math.abs(then.at - lastMs) <= intervalS * 1000 ? then : null;
  const slept = sleptBetween(paired, facts.sleepNow, wallGap);
  const asleep = slept >= SLEEP_MIN_MS;
  // Missed ticks are counted on awake time only. After a sleep, launchd may
  // start a new interval at the wake, so one more interval is allowed.
  const recent = lastMs !== null && wallGap - slept <= (asleep ? 3 : 2) * intervalS * 1000;
  const lastExit = typeof facts.daemonLastExit === "number" ? facts.daemonLastExit : null;
  const problems: ReadinessProblem[] = [];
  const notes: string[] = [];
  if (recent && asleep && wallGap > 2 * intervalS * 1000) {
    notes.push(sleepNote(slept, lastMs!, now.getTime(), facts.sleepNow?.woke_at, facts.platform));
  }

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
        // A loaded unit that stopped ticking needs the tick's own error, not a reinstall.
        const min = Math.round(wallGap / 60_000);
        const exited = d === "loaded" && lastExit !== null && lastExit !== 0 ? ` and exited with code ${lastExit}` : "";
        problems.push({
          code: "daemon_stale",
          message: `Tasks may not run: the tick daemon last ran ${min} minutes ago${exited}.`,
          fix: d === "loaded" ? TICK_ONCE : INSTALL,
        });
      }
    } else {
      problems.push({ code: "no_daemon", message: "Tasks will not run: no tick daemon.", fix: INSTALL });
    }
  }

  const run = facts.oldestRun;
  const runMs = run ? now.getTime() - Date.parse(run.startedAt) : NaN;
  if (run && runMs > 2 * intervalS * 1000) {
    const limit =
      run.timeLimit === undefined ? "" : run.timeLimit === "none" ? " (no time limit)" : ` (time limit ${formatDuration(run.timeLimit)})`;
    problems.push({
      code: "long_run",
      message: `Task ${run.taskId} has run for ${Math.floor(runMs / 60_000)} minutes${limit}; due tasks wait until it ends.`,
      fix: `tidegap queue cancel ${run.taskId}`,
      task_id: run.taskId,
    });
  }

  const runners = facts.runners;
  if (runners?.notes) notes.push(...runners.notes);
  if (runners) {
    for (const [provider, count] of Object.entries(facts.pendingByProvider).sort(([a], [b]) => a.localeCompare(b))) {
      if (count <= 0 || runners.providers.includes(provider) || runners.unknown.includes(provider)) continue;
      // Only a CLI tick runs the shell step and its snapshot names `command`; a
      // probe cannot see it, and a tick that is not running is a ticker problem.
      if (provider === "command" && runners.source !== "snapshot") continue;
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
    line: problems[0] ? problemLine(problems[0]) : null,
    notes,
    ticker: { daemon: facts.daemon, last_tick_at: lastMs === null ? null : new Date(lastMs).toISOString(), interval_s: intervalS, recent, slept_s: Math.round(slept / 1000), last_exit: lastExit },
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

/**
 * Pending (queued, scheduled, submitted) provider-call tasks by provider. A
 * command job occurrence counts for `command` (the CLI tick runs it) and for
 * its summarize step's provider, which needs a runner too.
 */
export function pendingProvidersFromStore(store: {
  list(filter: { status: TaskStatus }): Array<{ bodyJson?: string }>;
}): Record<string, number> {
  const out: Record<string, number> = {};
  const add = (p: unknown) => {
    if (typeof p === "string") out[p] = (out[p] ?? 0) + 1;
  };
  for (const status of PENDING) {
    for (const rec of store.list({ status })) {
      let body: { provider?: unknown; summarize?: { provider?: unknown } };
      try {
        body = JSON.parse(rec.bodyJson ?? "") as typeof body;
      } catch {
        continue;
      }
      add(body?.provider);
      if (body?.provider === "command") add(body.summarize?.provider);
    }
  }
  return out;
}

/** A row's newest event, progress lines aside, when it is a dispatch by a locked tick: its tick and time. */
export function tickDispatch(events: readonly TaskEvent[]): { tick: TickDetails; at: string } | undefined {
  let last: TaskEvent | undefined;
  for (let i = events.length - 1; i >= 0 && !last; i--) if (events[i]!.kind !== "progress") last = events[i];
  if (last?.kind !== "dispatched") return undefined;
  const t = last.details.tick as Partial<TickDetails> | undefined;
  if (!t || typeof t.id !== "string" || !Number.isInteger(t.pid)) return undefined;
  return { tick: { id: t.id, pid: t.pid!, ...(typeof t.started_at === "string" ? { started_at: t.started_at } : {}) }, at: last.at };
}

/**
 * The time limit of a run (the command limit of a command row, else the LLM
 * limit): the one its `dispatched` event recorded, else, for a run dispatched
 * before limits were recorded, the one its row names itself (an old stored
 * default counts as unset). Undefined when neither is known.
 */
function runTimeLimit(bodyJson: string | undefined, details: unknown): DurationValue | undefined {
  let spec: Partial<ProviderCallSpec> | undefined;
  try {
    spec = JSON.parse(bodyJson ?? "") as Partial<ProviderCallSpec>;
  } catch {
    spec = undefined;
  }
  const command = spec?.provider === "command";
  const recorded = runLimitsFromDetails(details);
  if (recorded) return (command ? recorded.command_timeout : recorded.llm_timeout)?.value;
  if (!spec?.caps || typeof spec.caps !== "object") return undefined;
  const caps = versionedCaps(spec.caps);
  const value: unknown = command ? caps.commandTimeoutMs : caps.llmTimeoutMs;
  return value === "none" || (typeof value === "number" && value > 0) ? value : undefined;
}

/**
 * The oldest `running` row a locked Node tick dispatched (the readiness
 * `long_run` fact), or null. A row another writer runs (the Python tick, the
 * MCP server) holds no Node tick and is left out. So is a Batch row: it is
 * `running` only while a poll checks its batch, and its dispatch is the
 * submit, hours before.
 */
export function oldestTickRun(store: {
  list(filter: { status: TaskStatus }): Array<Pick<TaskRecord<unknown>, "taskId" | "bodyJson" | "batchId">>;
  listTaskEvents(taskId: string): TaskEvent[];
}): OldestRun | null {
  let oldest: OldestRun | null = null;
  for (const row of store.list({ status: "running" })) {
    if (row.batchId) continue;
    const events = store.listTaskEvents(row.taskId);
    const dispatch = tickDispatch(events);
    if (!dispatch || (oldest && Date.parse(oldest.startedAt) <= Date.parse(dispatch.at))) continue;
    // tickDispatch found it: the newest event apart from progress lines.
    const dispatched = [...events].reverse().find((e) => e.kind !== "progress");
    const timeLimit = runTimeLimit(row.bodyJson, dispatched?.details);
    oldest = { taskId: row.taskId, startedAt: dispatch.at, ...(timeLimit !== undefined ? { timeLimit } : {}) };
  }
  return oldest;
}
