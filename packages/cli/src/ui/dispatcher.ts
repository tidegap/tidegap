/**
 * Dispatcher state and "Start dispatcher" for `tidegap ui` (ui v2, KTD13).
 *
 * The UI server never dispatches a task. When no dispatcher has run lately,
 * the page can ask the server to start one: the same `tidegap` binary the
 * install step resolves, spawned detached as `tidegap tick --daemon --interval
 * 60 --db <ledger>`, with stdout and stderr appended to
 * `~/.tidegap/logs/ui-tick.log` (directory 0700, file 0600). The child's
 * pid, log path and start time are kept in ledger meta `ui_dispatcher`. A
 * start is refused (409) while that child is alive or while any other
 * ticker ticked within two intervals. The user stops it with `kill <pid>`.
 *
 * State: `running` when the UI-started child is alive (its pid exists and it
 * started or ticked recently, so a recycled pid is not trusted) or a tick ran
 * recently; `stale` when a tick ran before that; `never` when no tick was
 * ever recorded. A tick is recent when it ran within two intervals (300 s
 * when the daemon is installed, else 60 s) of wall time, or when readiness's
 * ticker calls it on time on awake time (`recent`) for the same instant as
 * the ledger's `last_tick_at`. So after a sleep the daemon that just woke is
 * not called idle, and Start does not add a second ticker beside it. Without
 * readiness, or with a reading of another tick, the wall rule decides.
 */

import { spawn } from "node:child_process";
import { chmodSync, closeSync, fchmodSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";

import { LAST_TICK_META_KEY, resolveTidegapHome, type Readiness, type TaskStore } from "@tidegap/core";

import type { DaemonStatus } from "../platform/index.js";

export const UI_DISPATCHER_META_KEY = "ui_dispatcher";
/** Tick interval of a dispatcher started from the page, in seconds. */
export const UI_DISPATCHER_INTERVAL_S = 60;
/** Interval of the installed daemon (`tidegap install` default), in seconds. */
export const DAEMON_INTERVAL_S = 300;

export interface DispatcherMeta {
  pid: number;
  log: string;
  started_at: string;
}

/** Start `argv` detached with output appended to `logPath`; returns the pid. */
export type Spawner = (argv: string[], logPath: string) => number;

export interface DispatcherOptions {
  /** The `tidegap` launcher (`[node, script]` or `[binary]`), from `resolveLauncher`. */
  launcher: string[];
  dbPath: string;
  /** Default `~/.tidegap/logs`. */
  logDir?: string;
  spawn?: Spawner;
  isAlive?: (pid: number) => boolean;
  daemonStatus: () => DaemonStatus;
  now?: () => Date;
}

/** Readiness's view of the last tick: on time on awake time, and which tick. */
export type TickerReading = Pick<Readiness["ticker"], "recent" | "last_tick_at">;

export interface DispatcherState {
  state: "running" | "stale" | "never";
  last_tick_at: string | null;
  interval_s: number;
  ui_child: { pid: number; log: string; started_at: string; alive: boolean } | null;
}

export function defaultLogDir(): string {
  return join(resolveTidegapHome(), "logs");
}

/** True when a process with `pid` exists (EPERM still means it exists). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export const defaultSpawner: Spawner = (argv, logPath) => {
  const fd = openSync(logPath, "a", 0o600);
  try {
    // The mode above applies only when the file is created.
    fchmodSync(fd, 0o600);
    const child = spawn(argv[0]!, argv.slice(1), {
      detached: true,
      stdio: ["ignore", fd, fd],
    });
    child.on("error", () => {
      // A launch error surfaces as a missing pid below; nothing else to do.
    });
    if (child.pid === undefined) throw new Error("could not start the dispatcher");
    child.unref();
    return child.pid;
  } finally {
    closeSync(fd);
  }
};

export class DispatcherControl {
  constructor(
    private readonly store: TaskStore,
    private readonly opts: DispatcherOptions,
  ) {}

  private meta(): DispatcherMeta | undefined {
    const raw = this.store.getMeta(UI_DISPATCHER_META_KEY);
    if (!raw) return undefined;
    try {
      const m = JSON.parse(raw) as Partial<DispatcherMeta>;
      if (typeof m.pid !== "number" || typeof m.log !== "string" || typeof m.started_at !== "string") {
        return undefined;
      }
      return m as DispatcherMeta;
    } catch {
      return undefined;
    }
  }

  private alive(pid: number): boolean {
    return (this.opts.isAlive ?? pidAlive)(pid);
  }

  /** `ticker`: readiness's reading of the last tick, when the caller has one. */
  state(ticker?: TickerReading | null): DispatcherState {
    const meta = this.meta();
    const lastTick = this.store.getMeta(LAST_TICK_META_KEY) ?? null;
    const interval =
      this.opts.daemonStatus() === "installed" ? DAEMON_INTERVAL_S : UI_DISPATCHER_INTERVAL_S;
    const now = (this.opts.now?.() ?? new Date()).getTime();
    const window = 2 * interval * 1000;
    const lastMs = lastTick === null ? NaN : Date.parse(lastTick);
    // A reading counts only for the tick it was taken with.
    const onTimeAwake = ticker?.recent === true && ticker.last_tick_at !== null && Date.parse(ticker.last_tick_at) === lastMs;
    const recent = lastTick !== null && (now - lastMs <= window || onTimeAwake);
    // A live pid alone is not proof: after a crash or reboot the OS can give
    // the pid to another process. The child counts as alive while its pid
    // exists AND it either started recently or a tick ran recently.
    const child = meta
      ? {
          ...meta,
          alive:
            this.alive(meta.pid) &&
            (recent ||
              now - Date.parse(meta.started_at) <= 2 * UI_DISPATCHER_INTERVAL_S * 1000),
        }
      : null;
    const state = child?.alive || recent ? "running" : lastTick !== null ? "stale" : "never";
    return { state, last_tick_at: lastTick, interval_s: interval, ui_child: child };
  }

  /**
   * Spawn the dispatcher. Refused (`ok: false`) when the child started from
   * the page is alive (`ui_child`), or when another ticker (the installed
   * daemon, an `tidegap tick` loop, OpenClaw) ticked recently (`ticking`): a
   * second ticker would only race the first. `ticker` as in `state`.
   */
  start(ticker?: TickerReading | null):
    | { ok: true; meta: DispatcherMeta }
    | { ok: false; reason: "ui_child"; meta: DispatcherMeta }
    | { ok: false; reason: "ticking"; last_tick_at: string | null } {
    const current = this.state(ticker);
    if (current.ui_child?.alive) {
      const { alive: _alive, ...meta } = current.ui_child;
      return { ok: false, reason: "ui_child", meta };
    }
    if (current.state === "running") {
      return { ok: false, reason: "ticking", last_tick_at: current.last_tick_at };
    }
    const logDir = this.opts.logDir ?? defaultLogDir();
    mkdirSync(logDir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(logDir, 0o700);
    } catch {
      // best-effort on exotic filesystems
    }
    const log = join(logDir, "ui-tick.log");
    const argv = [
      ...this.opts.launcher,
      "tick",
      "--daemon",
      "--interval",
      String(UI_DISPATCHER_INTERVAL_S),
      "--db",
      this.opts.dbPath,
    ];
    const pid = (this.opts.spawn ?? defaultSpawner)(argv, log);
    const meta: DispatcherMeta = {
      pid,
      log,
      started_at: (this.opts.now?.() ?? new Date()).toISOString(),
    };
    this.store.setMeta(UI_DISPATCHER_META_KEY, JSON.stringify(meta));
    return { ok: true, meta };
  }
}
