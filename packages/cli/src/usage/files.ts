/**
 * The file reads of the spend and Codex scans, behind one small interface so
 * a test can see every path the scan opens. Read-only: nothing here writes.
 *
 * The logs are large (about 1 GB of Claude Code JSONL in a busy 5-hour
 * window), so the scan works on bytes: it reads big chunks, finds a marker
 * with `Buffer.indexOf`, and decodes only the lines that contain it.
 */

import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";

export interface UsageFs {
  /** Entry names of a directory; [] when it is missing or unreadable. */
  readdir(path: string): string[];
  /** Modification time, size and kind; undefined when the path is missing. */
  stat(path: string): { mtimeMs: number; size: number; dir: boolean } | undefined;
  /** Up to `length` bytes at `offset`; empty at the end of the file or on error. */
  readAt(path: string, offset: number, length: number): Buffer;
}

export const nodeUsageFs: UsageFs = {
  readdir(path) {
    try {
      return readdirSync(path);
    } catch {
      return [];
    }
  },
  stat(path) {
    try {
      const s = statSync(path);
      return { mtimeMs: s.mtimeMs, size: s.size, dir: s.isDirectory() };
    } catch {
      return undefined;
    }
  },
  readAt(path, offset, length) {
    let fd: number | undefined;
    try {
      fd = openSync(path, "r");
      const buf = Buffer.allocUnsafe(length);
      const n = readSync(fd, buf, 0, length, offset);
      return buf.subarray(0, n);
    } catch {
      return Buffer.alloc(0);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  },
};

const NL = 0x0a;
/** Bytes read per chunk of {@link markedLines}. */
const CHUNK_BYTES = 8 * 1024 * 1024;

/**
 * Every whole line from byte `start` that contains `marker`, decoded. The
 * line cut by `start` (when it is not 0) is skipped. A file that shrinks or
 * fails mid-read ends the scan with what was read.
 */
export function* markedLines(fs: UsageFs, path: string, marker: string, start = 0): Generator<string> {
  const needle = Buffer.from(marker);
  let offset = start;
  let carry: Buffer = Buffer.alloc(0);
  let skipFirst = start > 0;
  for (;;) {
    const chunk = fs.readAt(path, offset, CHUNK_BYTES);
    const eof = chunk.length === 0;
    offset += chunk.length;
    const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    // Process up to the last newline; the rest waits for the next chunk.
    const end = eof ? buf.length : buf.lastIndexOf(NL) + 1;
    let from = 0;
    if (skipFirst && end > 0) {
      from = buf.indexOf(NL) + 1;
      skipFirst = false;
    }
    let hit = from < end ? buf.indexOf(needle, from) : -1;
    while (hit !== -1 && hit < end) {
      const lineStart = buf.lastIndexOf(NL, hit) + 1;
      let lineEnd = buf.indexOf(NL, hit);
      if (lineEnd === -1 || lineEnd > end) lineEnd = end;
      if (lineStart >= from) yield buf.toString("utf8", lineStart, lineEnd);
      hit = lineEnd + 1 < end ? buf.indexOf(needle, lineEnd + 1) : -1;
    }
    if (eof) return;
    carry = end > 0 ? buf.subarray(end) : buf;
  }
}

/** Bytes read per probe of {@link firstOffsetAtOrAfter}. */
const PROBE_BYTES = 256 * 1024;
/** The search stops once the range is this small; the scan reads the rest. */
const SEARCH_SLACK = 1024 * 1024;
const TIMESTAMP = /"timestamp":"([^"]+)"/;

/** The first `"timestamp"` of a whole line that starts after `offset`, as epoch ms. */
function timestampAfter(fs: UsageFs, path: string, offset: number): number | undefined {
  const lines = fs.readAt(path, offset, PROBE_BYTES).toString("utf8").split("\n");
  // The first piece is the tail of a line cut by `offset`; the last may be cut too.
  for (const line of lines.slice(offset === 0 ? 0 : 1, -1)) {
    const m = TIMESTAMP.exec(line);
    const t = m ? Date.parse(m[1]!) : Number.NaN;
    if (Number.isFinite(t)) return t;
  }
  return undefined;
}

/**
 * A byte offset at or before the first line stamped at or after `startMs`,
 * for an append-only log whose lines are in time order. A binary search on
 * probes; a probe that finds no timestamp moves the bound down, so the
 * answer only errs towards reading more.
 */
export function firstOffsetAtOrAfter(fs: UsageFs, path: string, size: number, startMs: number): number {
  let lo = 0;
  let hi = size;
  while (hi - lo > SEARCH_SLACK) {
    const mid = Math.floor((lo + hi) / 2);
    const t = timestampAfter(fs, path, mid);
    if (t !== undefined && t < startMs) lo = mid;
    else hi = mid;
  }
  return lo;
}
