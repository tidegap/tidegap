/** The shared lock and atomic write of the env file and `channel-secrets.json` (S2 review follow-up). */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { tryFileLock, withFileLock } from "../src/atomic-file.js";
import { readSecrets, writeSecrets } from "../src/channels/secrets.js";
import { setEnvFileKey } from "../src/commands/env-file.js";

describe("atomic-file", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-atomic-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("tryFileLock: a touched lock stays fresh past staleMs; an untouched one is taken over; release deletes it", () => {
    const target = join(dir, "queue.db.tick");
    const lock = `${target}.lock`;
    const backdate = () => {
      const old = new Date(Date.now() - 70_000);
      utimesSync(lock, old, old);
    };
    const held = tryFileLock(target, 60_000)!;
    expect(held).toBeDefined();
    backdate();
    held.touch();
    expect(tryFileLock(target, 60_000)).toBeUndefined();
    backdate();
    const taker = tryFileLock(target, 60_000);
    expect(taker).toBeDefined();
    held.release();
    expect(existsSync(lock)).toBe(true);
    taker!.release();
    expect(existsSync(lock)).toBe(false);
    taker!.touch();
    expect(existsSync(lock)).toBe(false);
  });

  it("both writers take and release the same lock file", () => {
    const secrets = join(dir, "channel-secrets.json");
    const env = join(dir, "env");
    writeSecrets("webhook", { url: "https://example.com/h" }, secrets);
    setEnvFileKey(env, "TIDEGAP_X", "1");
    expect(existsSync(`${secrets}.lock`)).toBe(false);
    expect(existsSync(`${env}.lock`)).toBe(false);
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

  it("a writer whose lock was taken over leaves the new holder's lock alone", () => {
    const target = join(dir, "env");
    withFileLock(target, () => {
      // Another writer took the lock over and holds a new one.
      unlinkSync(`${target}.lock`);
      writeFileSync(`${target}.lock`, "");
    });
    expect(existsSync(`${target}.lock`)).toBe(true);
  });

  it("a stale takeover leaves no moved lock behind; a throwing write releases the lock", () => {
    const target = join(dir, "channel-secrets.json");
    writeFileSync(`${target}.lock`, "");
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${target}.lock`, old, old);
    expect(() =>
      withFileLock(target, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(readdirSync(dir)).toEqual([]);
  });

  it("a fresh lock held by another writer makes the write fail, not overwrite", () => {
    const env = join(dir, "env");
    writeFileSync(env, "A=1\n");
    writeFileSync(`${env}.lock`, "");
    // A holder that is still alive: the lock never turns stale while it waits.
    const later = new Date(Date.now() + 60_000);
    utimesSync(`${env}.lock`, later, later);
    const started = Date.now();
    expect(() => setEnvFileKey(env, "A", "2")).toThrow(/another Tidegap process/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(4_000);
    expect(readFileSync(env, "utf8")).toBe("A=1\n");
  }, 10_000);
});
