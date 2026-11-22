/**
 * Attachments of a command run: the files the command writes into
 * `TIDEGAP_ATTACH_DIR`, checked and stored with the run.
 *
 * - Each attempt gets a fresh private folder `<root>/.incoming/<random>/`
 *   (0700). Only its top level is read, once, after an exit 0; the folder is
 *   removed on every path.
 * - Regular files only. Each one is opened with `O_NOFOLLOW` and
 *   `O_NONBLOCK`, then checked and read through the same handle, so the
 *   command cannot swap the file for a link or a pipe after the check.
 *   Symbolic links, folders, special files and hard links (a second name
 *   of a file elsewhere, such as the ledger) are skipped with a reason. An
 *   incoming folder the command replaced (by a link to another folder) is
 *   not read at all.
 * - The type comes from the first bytes (PNG, JPEG, GIF, WebP, PDF), or from
 *   the name plus valid UTF-8 (`.csv`, `.txt`, `.json`, `.svg`). Anything
 *   else is skipped as `unknown type`.
 * - Caps: {@link ATTACH_MAX_FILES} files in name order,
 *   {@link ATTACH_MAX_FILE_BYTES} each, {@link ATTACH_MAX_RUN_BYTES} per run.
 * - A text file is scrubbed like the output (job secrets, vendor key shapes)
 *   and the scrubbed bytes are stored. A binary file that holds a job secret
 *   is skipped: it cannot be scrubbed.
 * - A kept file goes to `<root>/<task id>/<n>.<ext>` (0600). The extension
 *   comes from the detected type, never from the name, so a name cannot
 *   point anywhere. The display name is cleaned and cut to 80 characters.
 *
 * Nothing here sends a file: a channel takes its list from
 * `sendableAttachments`, which withholds every file of a redacted task.
 */

import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, opendirSync, openSync, readdirSync, readSync, rmSync, statSync, writeFileSync, type Dirent } from "node:fs";
import { dirname, join } from "node:path";

import {
  ATTACHMENT_TYPES,
  attachmentDisplayName,
  formatBytes,
  redactPrompt,
  SCRUB_MIN_LENGTH,
  scrubValues,
  type AttachmentType,
  type SkippedAttachment,
  type StoredAttachment,
} from "@tidegap/core";

/** Most files a run attaches. */
export const ATTACH_MAX_FILES = 4;
/** Largest file a run attaches, in bytes. */
export const ATTACH_MAX_FILE_BYTES = 10 * 1024 * 1024;
/** Most bytes a run attaches in total. */
export const ATTACH_MAX_RUN_BYTES = 20 * 1024 * 1024;
/** Days a run's attachments are kept. */
export const ATTACH_KEEP_DAYS = 30;
/** Most entries of the folder looked at; the rest are counted, never read. */
const ENTRIES_MAX = 50;
/** Most entries listed (then sorted by name); a folder of a million files costs the tick no more. */
const LIST_MAX = 1000;
/** Most skipped files named in a result; the rest are counted in one more entry. */
const SKIPPED_LIST_MAX = 10;

/** The environment variable that names the folder. */
export const ATTACH_DIR_ENV = "TIDEGAP_ATTACH_DIR";

const INCOMING = ".incoming";

/** The attachment store of the Tidegap home that holds the ledger at `dbPath`; none for an in-memory ledger. */
export function attachmentsRoot(dbPath: string): string | undefined {
  return dbPath === ":memory:" ? undefined : join(dirname(dbPath), "attachments");
}

/** The folder of one task's attachments. Task ids are generated, never user text; a separator in one is refused. */
export function taskAttachmentDir(root: string, taskId: string): string {
  if (!taskId || /[/\\]/.test(taskId) || taskId === "." || taskId === "..") throw new Error("attachments: invalid task id");
  return join(root, taskId);
}

/** The path of one stored file of a task (`file` is `<n>.<ext>` from `taskAttachments`). */
export function attachmentPath(root: string, taskId: string, file: string): string {
  return join(taskAttachmentDir(root, taskId), file);
}

/** A function that tells whether a task's attachment `file` is still on disk; always false without a store. */
export function attachmentExists(root: string | undefined, taskId: string): (file: string) => boolean {
  return (file) => {
    try {
      return root !== undefined && statSync(attachmentPath(root, taskId, file)).isFile();
    } catch {
      return false;
    }
  };
}

/** A fresh, empty, private folder for one attempt's files. */
export function makeIncomingDir(root: string): string {
  mkdirSync(join(root, INCOMING), { recursive: true, mode: 0o700 });
  const dir = join(root, INCOMING, randomBytes(12).toString("hex"));
  mkdirSync(dir, { mode: 0o700 });
  return dir;
}

/** Remove a folder and everything in it; a missing folder is fine. */
export function removeDir(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

/** Text types by file name; their bytes must be valid UTF-8. */
const TEXT_BY_EXT: Readonly<Record<string, AttachmentType>> = { csv: "text/csv", txt: "text/plain", json: "application/json", svg: "image/svg+xml" };

/** The type a file claims: a binary type from its first bytes, else a text type from its name. */
function claimedType(name: string, head: Buffer): AttachmentType | undefined {
  const h = head.toString("latin1");
  if (h.startsWith("\x89PNG\r\n\x1a\n")) return "image/png";
  if (h.startsWith("\xff\xd8\xff")) return "image/jpeg";
  if (h.startsWith("GIF87a") || h.startsWith("GIF89a")) return "image/gif";
  if (h.startsWith("RIFF") && h.slice(8, 12) === "WEBP") return "image/webp";
  if (h.startsWith("%PDF-")) return "application/pdf";
  const ext = /\.([A-Za-z]+)$/.exec(name)?.[1]?.toLowerCase();
  return ext ? TEXT_BY_EXT[ext] : undefined;
}

const isText = (type: AttachmentType) => type.startsWith("text/") || type === "application/json" || type === "image/svg+xml";

/** A file name for people: default-redacted, no path marks, then the core's display rule (one line, no bidirectional controls, at most 80 characters). */
export function displayName(name: string): string {
  return attachmentDisplayName(redactPrompt(name, undefined).replace(/[/\\]/g, "_")) || "unnamed file";
}

function kindOf(entry: Dirent): string | undefined {
  if (entry.isFile()) return undefined;
  if (entry.isSymbolicLink()) return "a symbolic link";
  if (entry.isDirectory()) return "a folder";
  return "not a regular file";
}

type ReadFile = { type: AttachmentType; bytes: Buffer; text?: string } | { reason: string };

/**
 * A regular file read through one handle: its type from the first bytes or
 * the name (an unknown type is never read further), then its bytes, and
 * for a text type its UTF-8 text; or the reason it is not kept.
 */
function readRegular(path: string, name: string, maxBytes: number): ReadFile {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    return { reason: (err as NodeJS.ErrnoException).code === "ELOOP" ? "a symbolic link" : "not readable" };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { reason: "not a regular file" };
    if (st.nlink > 1) return { reason: "a hard link" };
    if (st.size > maxBytes) return { reason: `over ${formatBytes(maxBytes)}` };
    // One byte more than the cap: a file that grew after the stat is caught.
    const buf = Buffer.alloc(Math.min(st.size, maxBytes) + 1);
    const readTo = (end: number, from: number) => {
      let n = from;
      while (n < end) {
        const got = readSync(fd, buf, n, end - n, n);
        if (got === 0) break;
        n += got;
      }
      return n;
    };
    const headLength = readTo(Math.min(12, buf.length), 0);
    const type = claimedType(name, buf.subarray(0, headLength));
    if (!type) return { reason: "unknown type" };
    const n = headLength < Math.min(12, buf.length) ? headLength : readTo(buf.length, headLength);
    if (n > maxBytes) return { reason: `over ${formatBytes(maxBytes)}` };
    const bytes = buf.subarray(0, n);
    if (!isText(type)) return { type, bytes };
    // NUL is valid UTF-8 but no text a person writes; UTF-16 text would slip past the scrub.
    if (bytes.includes(0)) return { reason: "unknown type" };
    try {
      return { type, bytes, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
    } catch {
      return { reason: "unknown type" };
    }
  } catch {
    return { reason: "not readable" };
  } finally {
    closeSync(fd);
  }
}

export interface IntakeInput {
  /** The attempt's incoming folder. */
  incoming: string;
  /** The task's attachment folder; any earlier attempt's files there are removed first. */
  taskDir: string;
  /** The job's secret values: scrubbed out of text files; a binary file that holds one is skipped. */
  secrets: readonly string[];
}

export interface IntakeResult {
  attachments: StoredAttachment[];
  skipped: SkippedAttachment[];
}

/** The first {@link LIST_MAX} entries of a folder, and how many more there were (counted up to a bound, never kept). */
function listFolder(path: string): { entries: Dirent[]; unlisted: number } {
  const dir = opendirSync(path);
  const entries: Dirent[] = [];
  let unlisted = 0;
  try {
    for (let e = dir.readSync(); e !== null && unlisted < LIST_MAX * 100; e = dir.readSync()) {
      if (entries.length < LIST_MAX) entries.push(e);
      else unlisted++;
    }
  } finally {
    dir.closeSync();
  }
  return { entries, unlisted };
}

/**
 * Check and store the files of `incoming` under `taskDir` (see the module
 * comment). Throws only when the store cannot be written; the caller then
 * removes `taskDir`.
 */
export function intakeAttachments(input: IntakeInput): IntakeResult {
  removeDir(input.taskDir);
  // `O_NOFOLLOW` guards the last name only: a folder the command swapped for a link is never listed.
  const folder = lstatSync(input.incoming, { throwIfNoEntry: false });
  if (!folder) return { attachments: [], skipped: [] };
  if (!folder.isDirectory()) {
    return { attachments: [], skipped: [{ name: ATTACH_DIR_ENV, reason: "not read: the folder was replaced" }] };
  }
  const { entries, unlisted } = listFolder(input.incoming);
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const attachments: StoredAttachment[] = [];
  const skipped: SkippedAttachment[] = [];
  const secrets = [...new Set(input.secrets)].filter((v) => v.length >= SCRUB_MIN_LENGTH).map((v) => Buffer.from(v, "utf8"));
  let total = 0;
  let unnamed = Math.max(0, entries.length - ENTRIES_MAX) + unlisted;
  // A name can hold a job secret too; it leaves in the notice and the caption.
  const nameOf = (name: string) => displayName(scrubValues(name, input.secrets));
  const skip = (name: string, reason: string) => {
    if (skipped.length < SKIPPED_LIST_MAX) skipped.push({ name: nameOf(name), reason });
    else unnamed++;
  };
  for (const entry of entries.slice(0, ENTRIES_MAX)) {
    const name = entry.name;
    const kind = kindOf(entry);
    if (kind) {
      skip(name, kind);
      continue;
    }
    if (attachments.length >= ATTACH_MAX_FILES) {
      skip(name, `over ${ATTACH_MAX_FILES} files`);
      continue;
    }
    const read = readRegular(join(input.incoming, name), name, ATTACH_MAX_FILE_BYTES);
    if ("reason" in read) {
      skip(name, read.reason);
      continue;
    }
    let bytes = read.bytes;
    if (read.text !== undefined) {
      bytes = Buffer.from(redactPrompt(scrubValues(read.text, input.secrets), undefined), "utf8");
    } else if (secrets.some((s) => bytes.includes(s))) {
      skip(name, "contains a job secret");
      continue;
    }
    if (bytes.length > ATTACH_MAX_FILE_BYTES) {
      skip(name, `over ${formatBytes(ATTACH_MAX_FILE_BYTES)}`);
      continue;
    }
    if (total + bytes.length > ATTACH_MAX_RUN_BYTES) {
      skip(name, `over ${formatBytes(ATTACH_MAX_RUN_BYTES)} per run`);
      continue;
    }
    const file = `${attachments.length + 1}.${ATTACHMENT_TYPES[read.type].ext}`;
    // Not recursive: a link planted at the folder's name fails the store rather than being written through.
    if (attachments.length === 0) mkdirSync(input.taskDir, { mode: 0o700 });
    writeFileSync(join(input.taskDir, file), bytes, { mode: 0o600, flag: "wx" });
    total += bytes.length;
    attachments.push({ name: nameOf(name), type: read.type, bytes: bytes.length, file });
  }
  if (unnamed > 0) skipped.push({ name: `${unnamed} more ${unnamed === 1 ? "file" : "files"}`, reason: "not read: too many files" });
  return { attachments, skipped };
}

/** The summarize input's line naming the files: `Attachments: funnel.png (PNG image, 48 KB), ...`; "" without any. */
export function attachmentsLine(attachments: readonly StoredAttachment[]): string {
  if (attachments.length === 0) return "";
  return `Attachments: ${attachments.map((a) => `${a.name} (${ATTACHMENT_TYPES[a.type].label}, ${formatBytes(a.bytes)})`).join(", ")}`;
}

const INCOMING_NAME = /^[0-9a-f]{24}$/;
const STORED_NAME = new RegExp(`^[1-9]\\d*\\.(${Object.values(ATTACHMENT_TYPES).map((t) => t.ext).join("|")})$`);

/** A task folder as the intake writes it: regular files named `<n>.<ext>` only, so a sweep never removes a folder it did not make. */
function isTaskFolder(path: string): boolean {
  return readdirSync(path, { withFileTypes: true }).every((e) => e.isFile() && STORED_NAME.test(e.name));
}

/**
 * Remove the task folders, and the incoming folders a crashed attempt left,
 * older than `keepDays` (by modification time). Only folders shaped as this
 * module makes them go (a task folder of `<n>.<ext>` files, an incoming
 * folder with a random hex name); a link is never followed. Returns how
 * many folders went. Never throws.
 */
export function sweepAttachments(root: string, now: Date, keepDays: number = ATTACH_KEEP_DAYS): number {
  let removed = 0;
  // A store, or its incoming folder, replaced by a link is never listed: the sweep stays in the folders it made.
  const realFolder = (path: string) => {
    try {
      return lstatSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
    } catch {
      return false;
    }
  };
  const sweep = (dir: string, maxAgeMs: number, ours: (name: string, path: string) => boolean) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const path = join(dir, e.name);
      try {
        if (now.getTime() - statSync(path).mtimeMs > maxAgeMs && ours(e.name, path)) {
          removeDir(path);
          removed++;
        }
      } catch {
        // the next sweep tries again
      }
    }
  };
  if (!realFolder(root)) return 0;
  sweep(root, keepDays * 86_400_000, (name, path) => name !== INCOMING && isTaskFolder(path));
  if (realFolder(join(root, INCOMING))) sweep(join(root, INCOMING), keepDays * 86_400_000, (name) => INCOMING_NAME.test(name));
  return removed;
}
