/**
 * Handoff fields of a task queued from an agent session: the folder a run
 * works in (`cwd`), its tool profile and the result file Tidegap writes when
 * it completes. Pure rules with injected file-system reads, so the MCP
 * server, the CLI and the tick apply the same checks, at enqueue and again
 * before a run or a write.
 *
 * Runs stay read-only: a profile only names one of the existing tool sets,
 * and only Tidegap writes a result file, as a new file, never through a
 * link.
 */

import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { isValidSessionId } from "./history.js";
import { resolveTidegapHome } from "./paths.js";
import { SESSION_NOTICE_MAX_AGE_MS, type SessionNotice, type TaskStore } from "./storage/sqlite.js";
import type { TaskRecord, TaskStatus } from "./types.js";

/** A tool profile: a name for one of the existing tool sets. */
export type HandoffProfile = "read" | "web" | "none";

export const HANDOFF_PROFILES: readonly HandoffProfile[] = ["read", "web", "none"];

/** The tools of each profile. `read` is scoped to the run's folder by the adapter. */
export const PROFILE_TOOLS: Readonly<Record<HandoffProfile, readonly string[]>> = {
  read: ["Read", "Grep", "Glob"],
  web: ["WebSearch", "WebFetch"],
  none: [],
};

/** The handoff fields of a task body (`ProviderCallSpec.handoff`). */
export interface HandoffSpec {
  /** The folder a `claude-code` run works in. */
  cwd?: string;
  /** The tool profile; `read` when only `cwd` is given. */
  profile?: HandoffProfile;
  /** The new file Tidegap writes the result text to when the task completes. */
  resultPath?: string;
  /**
   * Wake the idle Claude Code session that queued the task when it
   * finishes (the plugin's Stop hook). Needs a checked session origin.
   */
  wake?: boolean;
}

/** Longest result or output path. */
export const HANDOFF_PATH_MAX_CHARS = 1024;

/** What the rules need to know about one path; no link is followed. */
export interface HandoffFsEntry {
  kind: "file" | "dir" | "symlink" | "other";
  uid: number;
}

/** The file-system reads of the rules. Tests inject their own. */
export interface HandoffFs {
  /** The real path (links resolved), or undefined when the path does not resolve. */
  realpath(path: string): string | undefined;
  /** What is at `path` itself (a link is not followed), or undefined when nothing is. */
  lstat(path: string): HandoffFsEntry | undefined;
  /**
   * The identity of the folder or file at `path` (links followed), such as
   * `<dev>:<ino>`, or undefined when nothing is there. Two spellings of one
   * folder (another letter case, a firmlink such as `/System/Volumes/Data`)
   * have the same identity. Optional: without it, only the spelling counts.
   */
  identity?(path: string): string | undefined;
}

export const nodeHandoffFs: HandoffFs = {
  realpath(path) {
    try {
      // The native call also returns the on-disk letter case (macOS).
      return realpathSync.native(path);
    } catch {
      return undefined;
    }
  },
  identity(path) {
    try {
      const s = statSync(path);
      return `${s.dev}:${s.ino}`;
    } catch {
      return undefined;
    }
  },
  lstat(path) {
    try {
      const s = lstatSync(path);
      const kind = s.isSymbolicLink() ? "symlink" : s.isDirectory() ? "dir" : s.isFile() ? "file" : "other";
      return { kind, uid: s.uid };
    } catch {
      return undefined;
    }
  },
};

/** Where a result or output file may go, and how the rules read the disk. */
export interface HandoffPathContext {
  /** The task's own folder (`handoff.cwd`, or the command's `cwd`). */
  cwd?: string;
  /** The origin session's project folder (the `origin_cwd` column). */
  originCwd?: string;
  /** Default: this user's home folder. */
  home?: string;
  /** Default: the system temp folder and `/tmp`. */
  tmpDirs?: readonly string[];
  fs?: HandoffFs;
  /** Default: this process's user id. */
  uid?: number;
}

/**
 * Folders under the home folder that no handoff file or `claude-code` folder
 * may be in. The handoff and tools pages list them; docs-drift compares.
 */
export const PROTECTED_HOME_DIRS: readonly string[] = Object.freeze([".tidegap", ".config", ".claude", ".ssh", ".gnupg", ".aws", "Library"]);

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/** True when `path` is `dir` or below it. */
function inside(path: string, dir: string): boolean {
  if (path === dir) return true;
  return path.startsWith(dir.endsWith("/") ? dir : `${dir}/`);
}

function segments(rel: string): string[] {
  return rel.split("/").filter((s) => s !== "");
}

function unique(values: ReadonlyArray<string | undefined>): string[] {
  return [...new Set(values.filter((v): v is string => typeof v === "string" && v !== ""))];
}

/** The home folder as given and as its real path. */
function homes(home: string, fs: HandoffFs): string[] {
  return unique([home, fs.realpath(home)]);
}

/** True when `path` is `dir` or below it, in any letter case (a case-insensitive disk). */
function insideAnyCase(path: string, dir: string): boolean {
  return inside(path.toLowerCase(), dir.toLowerCase());
}

/**
 * Where `path` sits relative to the home folder: `{ first: undefined }` when
 * it is the home folder, `{ first }` with the first name below it, or
 * undefined when it is not inside. Matches the spelling in any letter case,
 * then the identity of each folder above `path`, so another spelling of the
 * home folder (a firmlink, another case) is found too.
 */
function homeSegment(path: string, homeDirs: readonly string[], fs: HandoffFs): { home: string; first?: string } | undefined {
  for (const h of homeDirs) {
    if (!insideAnyCase(path, h)) continue;
    const first = segments(path)[segments(h).length];
    return first === undefined ? { home: h } : { home: h, first };
  }
  const identity = fs.identity?.bind(fs);
  if (!identity) return undefined;
  const homeIds = new Set(homeDirs.map((h) => identity(h)).filter((id): id is string => id !== undefined));
  if (homeIds.size === 0) return undefined;
  let cur = path;
  let child: string | undefined;
  for (;;) {
    const id = identity(cur);
    if (id !== undefined && homeIds.has(id)) return child === undefined ? { home: cur } : { home: cur, first: child };
    const up = dirname(cur);
    if (up === cur) return undefined;
    child = basename(cur);
    cur = up;
  }
}

/** True when `dir` is `/` or the home folder, by spelling or identity. */
function isRootOrHome(dir: string, homeDirs: readonly string[], fs: HandoffFs): boolean {
  const real = fs.realpath(dir) ?? dir;
  if (dir === "/" || real === "/") return true;
  const id = fs.identity?.(real);
  if (id !== undefined && id === fs.identity?.("/")) return true;
  const at = homeSegment(real, homeDirs, fs);
  return at !== undefined && at.first === undefined;
}

/** True when a name is `.git` in any letter case. */
function isGitName(name: string): boolean {
  return name.toLowerCase() === ".git";
}

/**
 * The shape rule: an absolute path of at most {@link HANDOFF_PATH_MAX_CHARS}
 * characters, without control characters, equal to its `path.resolve` form
 * (no `.` or `..` segments, no repeated or trailing `/`). Links are not
 * resolved here.
 */
function shapeError(name: string, path: unknown): string | undefined {
  if (typeof path !== "string" || path === "") return `${name} must be an absolute path`;
  if (CONTROL_CHARS.test(path)) return `${name} must not contain control characters`;
  if (path.length > HANDOFF_PATH_MAX_CHARS) return `${name} is longer than ${HANDOFF_PATH_MAX_CHARS} characters`;
  if (!isAbsolute(path)) return `${name} must be an absolute path, got ${JSON.stringify(path)}`;
  if (resolve(path) !== path) {
    return `${name} ${JSON.stringify(path)} must have no "." or ".." segments and no repeated or trailing "/"`;
  }
  return undefined;
}

/**
 * The protected folder `path` is in, or undefined: a home dot folder of the
 * list, `~/Library`, or any `.git` folder. Names match in any letter case,
 * and the home folder also by identity (see {@link homeSegment}).
 */
function protectedDir(path: string, homeDirs: readonly string[], fs: HandoffFs): string | undefined {
  const at = homeSegment(path, homeDirs, fs);
  const first = at?.first?.toLowerCase();
  const match = first === undefined ? undefined : PROTECTED_HOME_DIRS.find((d) => d.toLowerCase() === first);
  if (at && match) return join(homeDirs.includes(at.home) ? at.home : (homeDirs[0] ?? at.home), match);
  if (segments(path).some(isGitName)) return "a .git folder";
  return undefined;
}

/**
 * The location rules of a result or output file. 1: the shape rule. 2: the
 * real path of the parent folder is inside the real path of an allowed root
 * (the task's folder, the session's project folder, the temp folders; never
 * `/` or the home folder itself), no folder or file name below that root
 * starts with `.`, and every folder below that root is this user's. 3:
 * neither the path nor the parent's real path is in a protected folder.
 */
function locationError(name: string, path: unknown, ctx: HandoffPathContext): string | undefined {
  const shape = shapeError(name, path);
  if (shape) return shape;
  const p = path as string;
  const fs = ctx.fs ?? nodeHandoffFs;
  const homeDirs = homes(ctx.home ?? homedir(), fs);
  // A session started in `/` or the home folder names no project: those are not roots.
  const roots = unique([ctx.cwd, ctx.originCwd, ...(ctx.tmpDirs ?? [tmpdir(), "/tmp"])]).filter(
    (root) => !isRootOrHome(root, homeDirs, fs),
  );
  const allowed = `; allowed folders: ${roots.join(", ") || "none"}`;
  const uid = ctx.uid ?? process.getuid?.();
  const isProtected = (candidate: string): string | undefined => {
    const dir = protectedDir(candidate, homeDirs, fs);
    return dir ? `${name} ${p} is inside ${dir}, a protected folder${allowed}` : undefined;
  };
  const given = isProtected(p);
  if (given) return given;
  const parent = dirname(p);
  const realParent = fs.realpath(parent);
  if (!realParent) return `${name} ${p}: the folder ${parent} does not exist${allowed}`;
  const real = isProtected(join(realParent, basename(p)));
  if (real) return real;
  let dotted = false;
  for (const root of roots) {
    const realRoot = fs.realpath(root);
    if (!realRoot || !inside(realParent, realRoot)) continue;
    const below = [...segments(relative(realRoot, realParent)), basename(p)];
    const lexical = inside(p, root) ? segments(relative(root, p)) : [];
    if ([...below, ...lexical].some((s) => s.startsWith("."))) {
      dotted = true;
      continue;
    }
    // Another user's folder below the root could be swapped for a link after this check.
    for (let dir = realParent; dir !== realRoot && inside(dir, realRoot); dir = dirname(dir)) {
      const entry = fs.lstat(dir);
      if (entry?.kind !== "dir" || (uid !== undefined && entry.uid !== uid)) {
        return `${name} ${p}: the folder ${dir} is not a folder you own${allowed}`;
      }
    }
    return undefined;
  }
  if (dotted) return `${name} ${p}: no folder or file name below the allowed folder may start with "."${allowed}`;
  return `${name} ${p} must be inside one of these folders: ${roots.join(", ") || "none"}`;
}

/**
 * Check a result path: the location rules, and create-only (nothing may be
 * at the path yet, not even a link). Returns the error message, or
 * undefined when the path is allowed.
 */
export function resultPathError(path: unknown, ctx: HandoffPathContext = {}): string | undefined {
  const location = locationError("result path", path, ctx);
  if (location) return location;
  const fs = ctx.fs ?? nodeHandoffFs;
  if (fs.lstat(path as string)) return `result path ${path as string} already exists; a result file is never replaced`;
  return undefined;
}

/**
 * Check an `output_path`: the location rules; a file already there must be
 * a regular file (not a link) that this user owns, which the JSON then
 * replaces. Returns the error message, or undefined when the path is allowed.
 */
export function outputPathError(path: unknown, ctx: HandoffPathContext = {}): string | undefined {
  const location = locationError("output path", path, ctx);
  if (location) return location;
  const fs = ctx.fs ?? nodeHandoffFs;
  const entry = fs.lstat(path as string);
  if (!entry) return undefined;
  const uid = ctx.uid ?? process.getuid?.();
  if (entry.kind !== "file" || (uid !== undefined && entry.uid !== uid)) {
    return `output path ${path as string} exists and is not a regular file you own`;
  }
  return undefined;
}

/**
 * Check the folder of a handed-off run. Every runner: an absolute path in
 * its `path.resolve` form to an existing folder. `claude-code` also: not
 * `/` or the home folder, owned by this user, and not inside a dot folder
 * of the home folder, `~/Library` or a `.git` folder (links resolved too).
 * Returns the error message, or undefined.
 */
export function handoffCwdError(
  cwd: unknown,
  runner: "claude-code" | "command",
  ctx: Pick<HandoffPathContext, "home" | "fs" | "uid"> = {},
): string | undefined {
  const shape = shapeError("cwd", cwd);
  if (shape) return shape;
  const dir = cwd as string;
  const fs = ctx.fs ?? nodeHandoffFs;
  const real = fs.realpath(dir);
  const entry = real ? fs.lstat(real) : undefined;
  if (!real || entry?.kind !== "dir") return `cwd ${dir} is not an existing folder`;
  if (runner === "command") return undefined;
  const homeDirs = homes(ctx.home ?? homedir(), fs);
  if (isRootOrHome(dir, homeDirs, fs) || isRootOrHome(real, homeDirs, fs)) return `cwd ${dir} is the root or home folder`;
  const uid = ctx.uid ?? process.getuid?.();
  if (uid !== undefined && entry.uid !== uid) return `cwd ${dir} belongs to another user`;
  for (const candidate of [dir, real]) {
    const at = homeSegment(candidate, homeDirs, fs);
    const first = at?.first;
    if (at && first !== undefined && (first.startsWith(".") || first.toLowerCase() === "library")) {
      return `cwd ${dir} is inside ${join(at.home, first)}, a protected folder`;
    }
    if (segments(candidate).some(isGitName)) return `cwd ${dir} is inside a .git folder`;
  }
  return undefined;
}

/** The profile and tools a handoff asks for, or the reason it is refused. */
export interface ProfileChoice {
  profile?: HandoffProfile;
  tools?: string[];
  error?: string;
}

/**
 * The tool set of a profile. A `cwd` with no profile means `read`; `web`
 * runs in a fresh temporary folder, so it refuses a `cwd`. Neither given:
 * no profile (the runner's default tools apply).
 */
export function profileTools(profile: unknown, cwd: string | undefined): ProfileChoice {
  if (profile === undefined) {
    return cwd === undefined ? {} : { profile: "read", tools: [...PROFILE_TOOLS.read] };
  }
  if (typeof profile !== "string" || !(HANDOFF_PROFILES as readonly string[]).includes(profile)) {
    return { error: `profile must be one of ${HANDOFF_PROFILES.join(", ")}, got ${JSON.stringify(profile)}` };
  }
  const p = profile as HandoffProfile;
  if (p === "web" && cwd !== undefined) {
    return { error: "profile web runs in a fresh temporary folder and cannot take a cwd; use profile read with a cwd" };
  }
  return { profile: p, tools: [...PROFILE_TOOLS[p]] };
}

/** True when two tool lists name the same tools. */
export function sameTools(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");
}

/** What a task runs and where (the handed-off work shape), from its body. */
export interface TaskWorkShape {
  runner?: string;
  cwd?: string;
  profile?: string;
  tools?: string[];
  resultPath?: string;
  /**
   * True when the task wakes its idle origin session when it finishes; on
   * a run of a bound job, when the job sweep's decision says so.
   */
  wake?: boolean;
  /** On a run of a bound job: the job's wake rule, which decides whether this run wakes. */
  wakeRule?: "failures" | "match";
  /** The shell command of a one-off command task. */
  command?: string;
}

/** {@link TaskWorkShape} of a task; empty for a closure task or a corrupt body. */
export function taskWorkShape(record: { bodyJson?: string }): TaskWorkShape {
  if (!record.bodyJson) return {};
  let spec: {
    provider?: unknown;
    tools?: unknown;
    handoff?: { cwd?: unknown; profile?: unknown; resultPath?: unknown; wake?: unknown };
    command?: { run?: unknown; cwd?: unknown; origin?: unknown };
    jobWake?: { on?: unknown; session?: unknown };
  };
  try {
    spec = JSON.parse(record.bodyJson) as typeof spec;
  } catch {
    return {};
  }
  const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
  const oneOff = spec?.provider === "command" && spec.command?.origin === "cli";
  const out: TaskWorkShape = {};
  const runner = str(spec?.provider);
  if (runner) out.runner = runner;
  const cwd = str(spec?.handoff?.cwd) ?? (oneOff ? str(spec.command?.cwd) : undefined);
  if (cwd) out.cwd = cwd;
  const profile = str(spec?.handoff?.profile);
  if (profile) out.profile = profile;
  if (Array.isArray(spec?.tools)) out.tools = spec.tools.filter((t): t is string => typeof t === "string");
  const resultPath = str(spec?.handoff?.resultPath);
  if (resultPath) out.resultPath = resultPath;
  // A run of a bound job is a wake task too; the job sweep decides whether it wakes (KTD10).
  if (spec?.handoff?.wake === true || typeof spec?.jobWake?.session === "string") out.wake = true;
  const rule = typeof spec?.jobWake?.session === "string" ? spec.jobWake.on : undefined;
  if (rule === "failures" || rule === "match") out.wakeRule = rule;
  const command = oneOff ? str(spec.command?.run) : undefined;
  if (command) out.command = command;
  return out;
}

/** The details of a task's newest `result_file` event, or undefined. */
export function latestResultFile(events: ReadonlyArray<{ kind: string; details: Record<string, unknown> }> | undefined): Record<string, unknown> | undefined {
  return [...(events ?? [])].reverse().find((e) => e.kind === "result_file")?.details;
}

/** A result file's state in words: `written, 12 bytes`, `not written: <error>`, or `not written yet`. */
export function resultFileText(details: Record<string, unknown> | undefined): string {
  if (!details) return "not written yet";
  if (details.written === true) return typeof details.bytes === "number" ? `written, ${details.bytes} bytes` : "written";
  return `not written: ${typeof details.error === "string" ? details.error : "unknown error"}`;
}

/**
 * Why a task may not ask for a wake, or undefined when it may: a wake is
 * `true` or absent, and `true` needs a checked Claude Code session origin
 * (the body's `origin` and a valid session id), so the right session wakes.
 */
export function wakeError(wake: unknown, origin: { agent?: unknown } | undefined, sessionId: unknown): string | undefined {
  if (wake === undefined || wake === false) return undefined;
  if (wake !== true) return "wake must be true or false";
  if (origin?.agent !== "claude-code" || !isValidSessionId(sessionId)) {
    return "a wake needs a task queued from a Claude Code session (the session that wakes); queue it from the session, or drop the wake";
  }
  return undefined;
}

/**
 * The default ledger, `~/.tidegap/queue.db`: the one the CLI, the tick
 * and the plugin's hooks read when no path is given. When only the legacy
 * `~/.ebb/queue.sqlite` exists, that file is returned, so its data stays
 * visible. The MCP server's own default is `queue.db` with no legacy
 * fallback; it creates that file at start, so the two agree from then on.
 */
export function defaultDbPath(): string {
  const newPath = join(resolveTidegapHome(), "queue.db");
  const legacyPath = join(homedir(), ".ebb", "queue.sqlite");
  if (!existsSync(newPath) && existsSync(legacyPath)) return legacyPath;
  return newPath;
}

/**
 * The `wake:` line of a task's work shape, or undefined when it does not
 * wake: a one-off wake task wakes when it finishes; a run of a bound job
 * says the job's rule, since most of its runs do not wake.
 */
export function wakeShapeText(shape: Pick<TaskWorkShape, "wake" | "wakeRule">): string | undefined {
  if (!shape.wake) return undefined;
  if (shape.wakeRule === "failures") return "failures (wakes its idle session only if the run fails after its retries)";
  if (shape.wakeRule === "match") return "match (wakes its idle session only if the run's output matches the job's pattern)";
  return "on (wakes its idle session when it finishes)";
}

/**
 * True when `dbPath` is the default ledger. The session notice and wake
 * markers under `~/.tidegap/sessions` belong to it: the plugin's hooks
 * read that ledger only, so a pass over another ledger must neither
 * create nor remove them, and a wake for a task in another ledger could
 * never fire. Compares real paths; a missing file compares by
 * its folder's real path and its name.
 */
export function isDefaultLedger(dbPath: string): boolean {
  if (dbPath === ":memory:") return false;
  // A missing file resolves through its folder, so a linked home still matches.
  const real = (path: string): string => {
    try {
      return realpathSync.native(path);
    } catch {
      try {
        return join(realpathSync.native(dirname(path)), basename(path));
      } catch {
        return resolve(path);
      }
    }
  };
  return real(dbPath) === real(defaultDbPath());
}

/** `~/.tidegap/sessions/wake`: one marker per session with a task to wake it for. */
export function wakeMarkersDir(home: string = resolveTidegapHome()): string {
  return join(home, "sessions", "wake");
}

/** The wake marker of one session, or undefined for an id that fails the id rule. */
export function wakeMarkerPath(sessionId: string, dir: string = wakeMarkersDir()): string | undefined {
  return isValidSessionId(sessionId) ? join(dir, sessionId) : undefined;
}

/**
 * Create or refresh a session's wake marker (file `0600`, folder `0700`),
 * so the plugin's Stop hook starts its waiter; its time is `now`. Returns
 * the error message, or undefined. Something other than a regular file at
 * the path is left alone and reported. A waiter or the sweep may remove
 * or write the marker at the same moment: a refresh that finds it gone
 * creates it, and a create that finds one there refreshes it.
 */
export function writeWakeMarker(sessionId: string, dir: string = wakeMarkersDir(), now: Date = new Date()): string | undefined {
  const path = wakeMarkerPath(sessionId, dir);
  if (!path) return "not a session id";
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    for (let attempt = 0; ; attempt++) {
      let there: ReturnType<typeof lstatSync> | undefined;
      try {
        there = lstatSync(path);
      } catch {
        there = undefined;
      }
      if (there && !there.isFile()) return `${path} is not a regular file`;
      try {
        if (!there) writeFileSync(path, `${now.toISOString()}\n`, { mode: 0o600, flag: "wx" });
        utimesSync(path, now, now);
        return undefined;
      } catch (err) {
        // Removed or created by another writer since the look: look once more.
        const code = (err as NodeJS.ErrnoException).code;
        if (attempt > 0 || (code !== "ENOENT" && code !== "EEXIST")) throw err;
      }
    }
  } catch (err) {
    return (err as Error).message;
  }
}

/** Remove a session's wake marker; a missing one is fine. */
export function removeWakeMarker(sessionId: string, dir: string = wakeMarkersDir()): void {
  const path = wakeMarkerPath(sessionId, dir);
  if (!path) return;
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
}

/** Statuses of a task that may still finish. */
const OPEN: readonly TaskStatus[] = ["queued", "scheduled", "running", "submitted"];

/** True for a task queued with wake, and for a run of a job bound to a session. */
export function isWakeTask(record: Pick<TaskRecord<unknown>, "bodyJson">): boolean {
  return taskWorkShape(record).wake === true;
}

/**
 * True when a session notice wakes its session: a run of a bound job when
 * the job sweep's decision says so, any other completed or failed wake
 * task. A cancel is someone's own act: it never spends a turn.
 */
export function noticeWakes(n: SessionNotice): boolean {
  return n.jobNotice ? n.jobNotice.wake : isWakeTask(n.record) && n.record.status !== "cancelled";
}

/**
 * The wake tasks still to come of one session, or of every session when
 * `sessionId` is undefined: not finished yet, or completed and waiting for
 * its result file (its notice comes once the file is). A row that completed
 * more than {@link SESSION_NOTICE_MAX_AGE_MS} ago no longer counts: it can
 * never be a notice.
 */
export function wakeTasksToCome(store: TaskStore, sessionId: string | undefined, now: Date): TaskRecord<unknown>[] {
  const oldest = now.getTime() - SESSION_NOTICE_MAX_AGE_MS;
  return [
    ...store.list({ ...(sessionId === undefined ? {} : { originSessionId: sessionId }), status: OPEN }),
    ...store
      .listResultFilesDue()
      .filter((r) => (sessionId === undefined || r.originSessionId === sessionId) && Date.parse(r.completedAt ?? "") >= oldest),
  ].filter(isWakeTask);
}

/**
 * True when a session has something left to wait for (KTD11): an open wake
 * task, a wake task waiting for its result file, an unclaimed notice that
 * wakes, or an active job bound to it. The bound job counts so a waiter
 * does not stop between a run's finish and the sweep's decision. With
 * `since`, only a task queued after it and a job bound after it count (a
 * second look after a removal); a run of a bound job counts through its
 * job's bind time only, since every run is a fresh row and would keep the
 * 7-day rule from ever ending the marker. An unclaimed wake notice counts
 * whatever its time. The reads go against the job sweep's write order
 * (run, then notice, then job): the job first, so a run that finishes
 * between two reads is seen by one of them. `notices` is the session's
 * notice list when the caller has just read it. Throws when the ledger
 * cannot be read.
 */
export function sessionHasWaitWork(
  store: TaskStore,
  sessionId: string,
  now: Date = new Date(),
  opts: { since?: number; notices?: readonly SessionNotice[] } = {},
): boolean {
  const { since } = opts;
  const after = (at: string | undefined) => since === undefined || Date.parse(at ?? "") > since;
  if (store.listJobs({ status: "active" }).some((j) => j.wake && j.originSessionId === sessionId && after(j.wake.boundAt))) return true;
  if ((opts.notices ?? store.listSessionNotices({ sessionId, now })).some(noticeWakes)) return true;
  return wakeTasksToCome(store, sessionId, now).some((t) => since === undefined || (t.jobId === undefined && after(t.enqueuedAt)));
}

/**
 * Remove a session's wake marker, then look once more
 * ({@link sessionHasWaitWork}, from `since` when given), and write the
 * marker again when the session has something left or the read fails. A
 * writer commits its row (or job) before it writes the marker, so work
 * added while the caller decided is either seen here or writes its marker
 * after the removal. Returns "removed", "kept" or "unread" (the read
 * failed). Never throws.
 */
export function removeWakeMarkerUnlessPending(
  store: TaskStore,
  sessionId: string,
  dir: string = wakeMarkersDir(),
  now: Date = new Date(),
  since?: number,
): "removed" | "kept" | "unread" {
  removeWakeMarker(sessionId, dir);
  let left: "removed" | "kept" | "unread";
  try {
    left = sessionHasWaitWork(store, sessionId, now, { since }) ? "kept" : "removed";
  } catch {
    left = "unread";
  }
  // An unread ledger keeps the marker's old time, so the sweep's 7-day rule still counts from it.
  if (left !== "removed") writeWakeMarker(sessionId, dir, left === "unread" && since !== undefined ? new Date(since) : now);
  return left;
}

/**
 * The agent's own act ended something a session waited for (a cancel, a
 * job removed, paused or unbound): drop the session's marker now unless
 * it has something left (KTD12). Only on the default ledger, whose markers
 * these are; `sessionId` undefined does nothing. Never throws.
 */
export function releaseWakeMarker(store: TaskStore | undefined, dbPath: string | undefined, sessionId: string | undefined): void {
  if (!store || !sessionId || !isValidSessionId(sessionId) || !dbPath || !isDefaultLedger(dbPath)) return;
  removeWakeMarkerUnlessPending(store, sessionId);
}
