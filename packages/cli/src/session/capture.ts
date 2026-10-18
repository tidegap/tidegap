/**
 * Capture files of the plugin's session hook (`hooks/session-capture.sh`):
 * `~/.tidegap/sessions/claude-<pid>.json`, one per running Claude Code
 * process, rewritten at every SessionStart (startup, resume, clear, compact).
 * A reader opens only the file of its own live ancestor `claude`, so files
 * left by dead processes are never read.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { isValidSessionId, resolveTidegapHome } from "@tidegap/core";

/** One captured session, as the hook wrote it. */
export interface CapturedSession {
  sessionId: string;
  /** Pid of the Claude Code process the file belongs to. */
  pid: number;
  /** `CLAUDE_PROJECT_DIR` when the hook ran: where Claude Code was started. */
  projectDir?: string;
  /** The hook's `cwd`. */
  cwd?: string;
  transcriptPath?: string;
  /** SessionStart source: `startup`, `resume`, `clear`, `compact`. */
  source?: string;
}

/** `~/.tidegap/sessions`. */
export function sessionsDir(home: string = resolveTidegapHome()): string {
  return join(home, "sessions");
}

const text = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

/**
 * The capture file of `pid`, or undefined when it is missing, does not
 * parse, names an invalid session id, or belongs to another pid.
 */
export function readCapture(pid: number, dir: string = sessionsDir()): CapturedSession | undefined {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(join(dir, `claude-${pid}.json`), "utf8"));
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const file = value as Record<string, unknown>;
  const hook = file.hook && typeof file.hook === "object" ? (file.hook as Record<string, unknown>) : undefined;
  if (file.pid !== pid || !hook) return undefined;
  if (!isValidSessionId(file.session_id) || hook.session_id !== file.session_id) return undefined;
  const out: CapturedSession = { sessionId: file.session_id, pid };
  const projectDir = text(file.project_dir);
  const cwd = text(hook.cwd);
  const transcriptPath = text(hook.transcript_path);
  const source = text(hook.source);
  if (projectDir) out.projectDir = projectDir;
  if (cwd) out.cwd = cwd;
  if (transcriptPath) out.transcriptPath = transcriptPath;
  if (source) out.source = source;
  return out;
}

/** One `ps` answer: the parent pid and the command name of a pid. */
export interface PsEntry {
  ppid: number;
  comm: string;
  /** Owner uid; when present, only this user's process can match. */
  uid?: number;
}

/** Looks up one pid; undefined when the pid does not run. */
export type PsRunner = (pid: number) => PsEntry | undefined;

/** `ps -o uid=,ppid=,comm= -p <pid>` (macOS and Linux). */
export const defaultPs: PsRunner = (pid) => {
  try {
    const out = execFileSync("ps", ["-o", "uid=,ppid=,comm=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(out.split("\n")[0] ?? "");
    return m ? { uid: Number(m[1]), ppid: Number(m[2]), comm: m[3]! } : undefined;
  } catch {
    return undefined;
  }
};

export interface AncestorOptions {
  /** First pid to look at. Default: this process's parent. */
  startPid?: number;
  platform?: NodeJS.Platform;
  ps?: PsRunner;
  /** Levels to walk. Default 6. */
  maxLevels?: number;
}

/**
 * The nearest ancestor process whose command basename is `name` and that
 * runs as this user (KTD3), or undefined. Windows has no `ps`, so it is
 * never searched there.
 */
export function findAncestorPid(name: string, opts: AncestorOptions = {}): number | undefined {
  if ((opts.platform ?? process.platform) === "win32") return undefined;
  const ps = opts.ps ?? defaultPs;
  let pid = opts.startPid ?? process.ppid;
  for (let level = 0; level < (opts.maxLevels ?? 6); level++) {
    if (!Number.isInteger(pid) || pid <= 1) return undefined;
    const entry = ps(pid);
    if (!entry) return undefined;
    const mine = entry.uid === undefined || entry.uid === process.getuid?.();
    if (basename(entry.comm) === name && mine) return pid;
    pid = entry.ppid;
  }
  return undefined;
}
