/**
 * Channel secrets (integrations plan KTD4): `~/.config/tidegap/channel-secrets.json`,
 * JSON `{ "<channel id>": { "<field>": "<value>" } }`, mode 0600 in a 0700
 * directory. Never the env file: `loadEnvFileIntoProcess` copies every env
 * key into `process.env`, and children other than `claude -p` inherit it.
 *
 * - Read on every send, so a change applies at the next event.
 * - Written through `atomic-file.ts`, like `setEnvFileKey`: under a lock
 *   file, then temp file, fsync, rename. A symlinked file stays a symlink.
 * - A malformed file reads as empty with one log line. The next write keeps
 *   it as `<file>.bak` (0600) before replacing it, so nothing is lost silently.
 * - No function here logs or throws a secret value.
 */

import { chmodSync, copyFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { withFileLock, writeFileAtomic, writeTarget } from "../atomic-file.js";

export type SecretMap = Record<string, string>;
type SecretsFile = Record<string, SecretMap>;

export const CHANNEL_SECRETS_FILE = "channel-secrets.json";

/** Absolute path of the channel secrets file, next to the env file. */
export function channelSecretsPath(home: string = homedir()): string {
  return join(home, ".config", "tidegap", CHANNEL_SECRETS_FILE);
}

type ReadResult = { ok: true; data: SecretsFile } | { ok: false };

/** The parsed file; a missing file is empty. Entries that are not string maps are dropped. */
function readFile(path: string): ReadResult {
  let text: string;
  try {
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
  for (const [id, map] of Object.entries(raw)) {
    if (!map || typeof map !== "object" || Array.isArray(map)) continue;
    const entry: SecretMap = {};
    for (const [k, v] of Object.entries(map)) if (typeof v === "string") entry[k] = v;
    data[id] = entry;
  }
  return { ok: true, data };
}

/**
 * The secrets of channel `id`, or undefined when it has none. A malformed or
 * unreadable file reads as empty and logs one line naming the file only.
 */
export function readSecrets(id: string, path: string = channelSecretsPath(), log?: (line: string) => void): SecretMap | undefined {
  const res = readFile(path);
  if (!res.ok) {
    log?.(`tidegap: ${CHANNEL_SECRETS_FILE} is unreadable or not valid JSON; channel secrets read as empty`);
    return undefined;
  }
  return Object.hasOwn(res.data, id) ? { ...res.data[id] } : undefined;
}

/** Set (or with `undefined`, delete) the secrets of channel `id`; other ids stay. Locked against a concurrent writer. */
export function writeSecrets(id: string, map: SecretMap | undefined, path: string = channelSecretsPath()): void {
  const target = writeTarget(path);
  withFileLock(target, () => {
    const res = readFile(target);
    if (!res.ok) {
      copyFileSync(target, `${target}.bak`);
      chmodSync(`${target}.bak`, 0o600);
    }
    const data = res.ok ? res.data : {};
    if (map === undefined) delete data[id];
    else data[id] = { ...map };
    writeFileAtomic(target, `${JSON.stringify(data, null, 2)}\n`);
  });
}
