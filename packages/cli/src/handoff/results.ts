/**
 * Result files: Tidegap, never the run, writes a completed task's result
 * text to the new file its session asked for (`handoff.resultPath`). The
 * Node tick runs the sweep after every pass, before the notice sweep, so a
 * notice can name the written file. It covers tasks either core finished.
 *
 * The write is create-only and never follows a link: the path rules run
 * again first, the text goes to a new temporary file in the same folder
 * (`wx`, mode `0600`), and that file is hard-linked to the target, which
 * fails when anything is there. The temporary name is then removed. Each
 * task gets one `result_file` event (`path`, `written`, then `bytes` or
 * `error`). A failure never fails the task: it ran, and it may have been
 * paid for. When the event cannot be recorded (a busy ledger), the file the
 * sweep just wrote is removed again, so the next sweep writes it and records
 * it as written.
 */

import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, linkSync, lstatSync, openSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { nodeHandoffFs, resultPathError, taskResultText, taskWorkShape } from "@tidegap/core";
import type { HandoffPathContext, TaskRecord, TaskStore } from "@tidegap/core";

/** What the sweep did for one task. */
export interface ResultFileOutcome {
  taskId: string;
  path: string;
  written: boolean;
  bytes?: number;
  error?: string;
}

/** The text a result file gets: the result text, else the result as JSON. */
function resultText(record: TaskRecord<unknown>): string {
  const text = taskResultText(record);
  if (text !== undefined) return text;
  return record.result === undefined ? "" : JSON.stringify(record.result, null, 2);
}

/** A written result file: its size, and where and which file it is (to undo the write). */
export interface WrittenResultFile {
  bytes: number;
  /** The path written, through the folder's real path. */
  target: string;
  /** `<dev>:<ino>` of the written file. */
  identity: string;
}

/**
 * Write `text` to the new file `path` under the location and create-only
 * rules of `ctx`. Returns the bytes written, or the reason nothing was.
 */
export function writeResultFile(path: string, text: string, ctx: HandoffPathContext): WrittenResultFile | { error: string } {
  const refused = resultPathError(path, ctx);
  if (refused) return { error: refused };
  // The real folder, checked just now: a link swapped in above it later is not followed.
  const folder = (ctx.fs ?? nodeHandoffFs).realpath(dirname(path));
  if (!folder) return { error: `the folder ${dirname(path)} does not exist` };
  const target = join(folder, basename(path));
  const temp = join(folder, `.tidegap-result-${randomUUID()}.tmp`);
  const data = Buffer.from(text, "utf8");
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", 0o600);
    let off = 0;
    while (off < data.length) off += writeSync(fd, data, off, data.length - off);
    const st = fstatSync(fd);
    closeSync(fd);
    fd = undefined;
    try {
      linkSync(temp, target);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return { error: `${path} appeared after the task was queued; it was left as it is` };
      return { error: `cannot create ${path}: ${code ?? (err as Error).message}` };
    }
    return { bytes: data.length, target, identity: `${st.dev}:${st.ino}` };
  } catch (err) {
    return { error: `cannot write next to ${path}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}` };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
    }
    try {
      unlinkSync(temp);
    } catch {
      // never created
    }
  }
}

/** Remove a file this sweep wrote, when it is still that file. */
function undoWrite(written: WrittenResultFile): void {
  try {
    const st = lstatSync(written.target);
    if (st.isFile() && `${st.dev}:${st.ino}` === written.identity) unlinkSync(written.target);
  } catch {
    // gone already
  }
}

/**
 * Write the result file of every completed task that asked for one and has
 * no `result_file` event, and record that event. Never throws: a sweep must
 * not fail the tick. `ctx` overrides the path rules' reads (tests).
 */
export function resultFileSweep(store: TaskStore, ctx: Omit<HandoffPathContext, "cwd" | "originCwd"> = {}): ResultFileOutcome[] {
  const out: ResultFileOutcome[] = [];
  let due: TaskRecord<unknown>[] = [];
  try {
    due = store.listResultFilesDue();
  } catch {
    return out;
  }
  for (const record of due) {
    const shape = taskWorkShape(record);
    const path = shape.resultPath;
    if (!path) continue;
    let res: WrittenResultFile | { error: string };
    try {
      res = writeResultFile(path, resultText(record), { ...ctx, cwd: shape.cwd, originCwd: record.originCwd });
    } catch (err) {
      res = { error: `cannot write ${path}: ${(err as Error).message}` };
    }
    const details = "bytes" in res ? { path, written: true, bytes: res.bytes } : { path, written: false, error: res.error };
    try {
      if (store.recordResultFile(record.taskId, details)) out.push({ taskId: record.taskId, ...details });
    } catch {
      // A busy ledger: without the event the next sweep tries again, and it
      // would find this file and record it as not written. Remove it first.
      if ("bytes" in res) undoWrite(res);
    }
  }
  return out;
}
