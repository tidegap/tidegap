/**
 * Job secrets (jobs KTD12): `~/.config/tidegap/job-secrets.json`, JSON
 * `{ "<NAME>": "<value>" }`, mode 0600 in a 0700 directory. A separate file
 * from the channel secrets, so Tidegap never hands a channel token to a job.
 * The command runs as the same user, though: it can read any file that user
 * can, the channel secrets and the env file included (the trust model of a
 * command job).
 *
 * - A command job names the secrets it needs; at run time only those
 *   values enter the command's environment, and every one of them is
 *   scrubbed out of its output and errors.
 * - Values are set from stdin only (`tidegap jobs secrets set NAME`), never
 *   from argv or over HTTP. The page and the CLI list names only.
 * - Written through `atomic-file.ts` (lock, temp file, fsync, rename), like
 *   `channels/secrets.ts`. A malformed file reads as empty with one log line
 *   and is kept as `<file>.bak` (0600) by the next write.
 * - A file another user owns, or that the group or others may write, is
 *   refused: its values could have been planted. Reads fail with the fix
 *   (`chmod 600`) and writes leave it untouched.
 * - No function here logs or throws a secret value.
 */

import { chmodSync, copyFileSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { JOB_SECRET_NAME, SCRUB_MIN_LENGTH } from "@tidegap/core";

import { withFileLock, writeFileAtomic, writeTarget } from "../atomic-file.js";

export const JOB_SECRETS_FILE = "job-secrets.json";

type SecretsFile = Record<string, string>;
type ReadResult = { ok: true; data: SecretsFile } | { ok: false; unsafe?: string };

/** Absolute path of the job secrets file, next to the env file. */
export function jobSecretsPath(home: string = homedir()): string {
  return join(home, ".config", "tidegap", JOB_SECRETS_FILE);
}

/** Throws when `name` is not a valid job secret name. The message never holds a value. */
export function assertJobSecretName(name: string): void {
  if (!JOB_SECRET_NAME.test(name)) {
    throw new Error(`secret name ${JSON.stringify(name)} must be upper case letters, digits and _ (start with a letter, at most 64)`);
  }
}

/** Why the file at `path` must not be trusted, or undefined when it may be. Never names a value. */
function unsafeFile(path: string): string | undefined {
  if (process.platform === "win32") return undefined;
  const st = statSync(path);
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) return `${JOB_SECRETS_FILE} belongs to another user; job secrets are not read`;
  if ((st.mode & 0o022) !== 0) {
    return `${JOB_SECRETS_FILE} is writable by the group or others; job secrets are not read (run: chmod 600 ${path})`;
  }
  return undefined;
}

/** The parsed file; a missing file is empty. Entries that are not strings or have a bad name are dropped. */
function readFile(path: string): ReadResult {
  let text: string;
  try {
    const unsafe = unsafeFile(path);
    if (unsafe) return { ok: false, unsafe };
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, data: {} };
    return { ok: false };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false };
  const data: SecretsFile = {};
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value === "string" && JOB_SECRET_NAME.test(name)) data[name] = value;
  }
  return { ok: true, data };
}

function unreadableLine(): string {
  return `tidegap: ${JOB_SECRETS_FILE} is unreadable or not valid JSON; job secrets read as empty`;
}

/** What {@link readJobSecrets} found: the values of the names present, and the names missing. */
export interface JobSecretsRead {
  values: Record<string, string>;
  missing: string[];
  /** Set when the file could not be used (unsafe, unreadable, not JSON); every name is then missing. */
  problem?: string;
}

/** The values of `names`; names not in the file (or an unusable file) come back in `missing`. */
export function readJobSecrets(names: readonly string[], path: string = jobSecretsPath(), log?: (line: string) => void): JobSecretsRead {
  const res = readFile(path);
  const problem = res.ok ? undefined : (res.unsafe ?? unreadableLine());
  if (problem) log?.(problem);
  const data = res.ok ? res.data : {};
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of names) {
    if (Object.hasOwn(data, name)) values[name] = data[name]!;
    else missing.push(name);
  }
  return problem && names.length > 0 ? { values, missing, problem } : { values, missing };
}

/** The secret names in the file, sorted. Never a value. */
export function listJobSecretNames(path: string = jobSecretsPath(), log?: (line: string) => void): string[] {
  const res = readFile(path);
  if (!res.ok) {
    log?.(res.unsafe ?? unreadableLine());
    return [];
  }
  return Object.keys(res.data).sort();
}

/** Change the file under its lock; a malformed file is kept as `.bak` first. */
function update(path: string, change: (data: SecretsFile) => void): void {
  const target = writeTarget(path);
  withFileLock(target, () => {
    const res = readFile(target);
    if (!res.ok && res.unsafe) throw new Error(res.unsafe);
    if (!res.ok) {
      copyFileSync(target, `${target}.bak`);
      chmodSync(`${target}.bak`, 0o600);
    }
    const data = res.ok ? res.data : {};
    change(data);
    writeFileAtomic(target, `${JSON.stringify(data, null, 2)}\n`);
  });
}

/** Set secret `name`; other names stay. Throws on a bad name or a value too short to scrub. */
export function setJobSecret(name: string, value: string, path: string = jobSecretsPath()): void {
  assertJobSecretName(name);
  if (value.length === 0) throw new Error(`secret ${name}: the value is empty`);
  if (value.length < SCRUB_MIN_LENGTH) {
    throw new Error(`secret ${name}: the value is shorter than ${SCRUB_MIN_LENGTH} characters, so it could not be scrubbed from output`);
  }
  update(path, (data) => {
    data[name] = value;
  });
}

/** Remove secret `name`; true when it was there. */
export function removeJobSecret(name: string, path: string = jobSecretsPath()): boolean {
  assertJobSecretName(name);
  let removed = false;
  update(path, (data) => {
    removed = Object.hasOwn(data, name);
    delete data[name];
  });
  return removed;
}
