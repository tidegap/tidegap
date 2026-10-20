/** The shared lock and atomic write of the env file and `channel-secrets.json` (S2 review follow-up). */

import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { withFileLock } from "../src/atomic-file.js";
import { readSecrets, writeSecrets } from "../src/channels/secrets.js";
import { setEnvFileKey } from "../src/commands/env-file.js";

describe("atomic-file", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-atomic-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("both writers take and release the same lock file", () => {
    const secrets = join(dir, "channel-secrets.json");
    const env = join(dir, "env");
    writeSecrets("webhook", { url: "https://example.com/h" }, secrets);
    setEnvFileKey(env, "TIDEGAP_X", "1");
    expect(existsSync(`${secrets}.lock`)).toBe(false);
    expect(existsSync(`${env}.lock`)).toBe(false);
    // A write inside a held lock waits for it: the lock is not reentrant, so the inner writer sees it held.
    withFileLock(secrets, () => expect(existsSync(`${secrets}.lock`)).toBe(true));
  });

  it("a stale lock left by a crashed writer is taken over", () => {
    const secrets = join(dir, "channel-secrets.json");
    writeFileSync(`${secrets}.lock`, "");
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${secrets}.lock`, old, old);
    writeSecrets("webhook", { url: "https://example.com/h" }, secrets);
    expect(readSecrets("webhook", secrets)).toEqual({ url: "https://example.com/h" });
    expect(existsSync(`${secrets}.lock`)).toBe(false);
  });

  it("a fresh lock held by another writer makes the write fail, not overwrite", () => {
    const env = join(dir, "env");
    writeFileSync(env, "A=1\n");
    writeFileSync(`${env}.lock`, "");
    const started = Date.now();
    expect(() => setEnvFileKey(env, "A", "2")).toThrow(/another Tidegap process/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(4_000);
    expect(readFileSync(env, "utf8")).toBe("A=1\n");
  }, 10_000);
});
