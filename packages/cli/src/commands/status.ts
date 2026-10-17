/**
 * `tidegap status` (coherence U4, R4): will queued tasks run? One line per
 * fact (daemon, last tick, runners, pending tasks), then the readiness
 * line. Exit 0 when ready, 1 when not. Works with no `~/.tidegap` and no
 * ledger, and never creates either.
 */

import { existsSync } from "node:fs";

import { pendingProvidersFromStore, TaskStore, type DaemonFact, type Readiness } from "@tidegap/core";

import { gatherReadiness, type GatherReadinessOptions } from "../readiness.js";
import { defaultDbPath } from "./tick.js";

export interface StatusCommandOptions extends GatherReadinessOptions {
  /** Ledger path (`--db`); default the CLI's `defaultDbPath()`. */
  db?: string;
  json?: boolean;
}

export interface StatusResult {
  exitCode: number;
  rendered: string;
  readiness: Readiness;
}

const DAEMON_TEXT: Record<DaemonFact, string> = {
  loaded: "installed and loaded",
  installed: "installed (load state not checked)",
  installed_not_loaded: "installed, not loaded",
  not_installed: "not installed",
  unknown: "unknown on this platform",
};

/** Pending provider-call tasks by provider; none when the ledger does not exist. */
function pendingByProvider(dbPath: string): Record<string, number> {
  if (!existsSync(dbPath)) return {};
  let store: TaskStore | undefined;
  try {
    store = new TaskStore({ dbPath });
    return pendingProvidersFromStore(store);
  } catch {
    return {};
  } finally {
    store?.close();
  }
}

function ago(iso: string, now: Date): string {
  const min = Math.round((now.getTime() - Date.parse(iso)) / 60_000);
  if (min < 1) return "just now";
  if (min < 120) return `${min} minute${min === 1 ? "" : "s"} ago`;
  return `${Math.round(min / 60)} hours ago`;
}

/** The status lines for a readiness result. */
export function renderStatus(r: Readiness, pending: Record<string, number>, now: Date): string {
  const lines: string[] = [];
  lines.push(`Daemon:     ${DAEMON_TEXT[r.ticker.daemon]}`);
  lines.push(`Last tick:  ${r.ticker.last_tick_at ? `${ago(r.ticker.last_tick_at, now)} (${r.ticker.last_tick_at})` : "never"}`);
  const source = r.runners.source === "snapshot" ? " (from the last tick)" : r.runners.source === "probe" ? " (checked now)" : "";
  const known = r.runners.providers.length > 0 ? r.runners.providers.join(", ") : "none";
  const unknown = r.runners.unknown.length > 0 ? `; unknown: ${r.runners.unknown.join(", ")}` : "";
  lines.push(`Runners:    ${r.runners.source === "unknown" ? "unknown" : `${known}${unknown}${source}`}`);
  const entries = Object.entries(pending).filter(([, n]) => n > 0).sort(([a], [b]) => a.localeCompare(b));
  lines.push(`Pending:    ${entries.length > 0 ? entries.map(([p, n]) => `${p} ${n}`).join(", ") : "none"}`);
  for (const note of r.notes) lines.push(`Note:       ${note}`);
  lines.push("");
  if (r.ready) {
    lines.push("Tasks will run.");
  } else {
    lines.push(r.line ?? "Tasks will not run.");
    for (const p of r.problems.slice(1)) {
      lines.push(p.fix.startsWith("tidegap ") ? `${p.message} Run \`${p.fix}\`.` : `${p.message} Fix: ${p.fix}.`);
    }
  }
  return lines.join("\n");
}

export function runStatus(opts: StatusCommandOptions = {}): StatusResult {
  const now = opts.now ?? new Date();
  const dbPath = opts.db ?? opts.dbPath ?? defaultDbPath();
  const readiness = gatherReadiness({ ...opts, dbPath, now });
  const rendered = opts.json
    ? JSON.stringify(readiness, null, 2)
    : renderStatus(readiness, pendingByProvider(dbPath), now);
  return { exitCode: readiness.ready ? 0 : 1, rendered, readiness };
}
