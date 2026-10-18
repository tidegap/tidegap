/**
 * Context-size estimate of a Claude Code session (KTD9), from its
 * transcript. The transcript format is internal to Claude Code, so the
 * parser is tolerant, and every failure falls through to `ceil(bytes / 4)`,
 * which overestimates and so errs toward a fresh run.
 */

import { closeSync, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** How much of the transcript's end is read. */
export const TAIL_BYTES = 512 * 1024;

/** File access the estimate and the run plan need. Tests inject it. */
export interface SessionFs {
  isDirectory(path: string): boolean;
  exists(path: string): boolean;
  /** File size in bytes, or undefined when it is not a readable file. */
  size(path: string): number | undefined;
  /** The last `bytes` of the file as UTF-8, or undefined. */
  tail(path: string, bytes: number): string | undefined;
  /** Owner uid and real path of a directory. Optional: a fake without it skips the owner check. */
  dirInfo?(path: string): { uid: number; realPath: string } | undefined;
}

export const nodeSessionFs: SessionFs = {
  isDirectory(path) {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  },
  exists(path) {
    try {
      statSync(path);
      return true;
    } catch {
      return false;
    }
  },
  size(path) {
    try {
      const s = statSync(path);
      return s.isFile() ? s.size : undefined;
    } catch {
      return undefined;
    }
  },
  tail(path, bytes) {
    let fd: number | undefined;
    try {
      fd = openSync(path, "r");
      const size = fstatSync(fd).size;
      const length = Math.min(bytes, size);
      const buf = Buffer.alloc(length);
      readSync(fd, buf, 0, length, size - length);
      return buf.toString("utf8");
    } catch {
      return undefined;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  },
  dirInfo(path) {
    try {
      return { uid: statSync(path).uid, realPath: realpathSync(path) };
    } catch {
      return undefined;
    }
  },
};

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

/** The context of the last main-chain turn: input + cache creation + cache read tokens. */
function lastUsageTokens(tail: string): number | undefined {
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.includes('"usage"')) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      // The first line of a tail usually starts mid-line.
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const e = entry as { isSidechain?: unknown; message?: { usage?: unknown }; usage?: unknown };
    if (e.isSidechain === true) continue;
    const usage = e.message?.usage ?? e.usage;
    if (!usage || typeof usage !== "object") continue;
    const u = usage as Record<string, unknown>;
    const tokens = num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens);
    if (tokens > 0) return tokens;
  }
  return undefined;
}

/**
 * The context-token estimate of the transcript at `path`, or undefined when
 * the file cannot be read.
 */
export function estimateContextTokens(path: string, fs: SessionFs = nodeSessionFs): number | undefined {
  const size = fs.size(path);
  if (size === undefined) return undefined;
  const tail = fs.tail(path, TAIL_BYTES);
  const tokens = tail === undefined ? undefined : lastUsageTokens(tail);
  return tokens ?? Math.ceil(size / 4);
}

/** Longest project folder name the derived transcript path is trusted for. */
const MAX_PROJECT_NAME = 200;

/**
 * The documented transcript location of a session:
 * `<config dir>/projects/<cwd with every non-alphanumeric as "-">/<id>.jsonl`.
 * Undefined when the folder name would be 200 characters or more (Claude
 * Code shortens those names its own way).
 */
export function derivedTranscriptPath(
  sessionId: string,
  cwd: string,
  opts: { claudeConfigDir?: string; home?: string } = {},
): string | undefined {
  const name = cwd.replace(/[^A-Za-z0-9]/g, "-");
  if (name.length >= MAX_PROJECT_NAME) return undefined;
  const config = opts.claudeConfigDir ?? join(opts.home ?? homedir(), ".claude");
  return join(config, "projects", name, `${sessionId}.jsonl`);
}
