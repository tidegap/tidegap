/** KTD2: read-only credential lookup. The Keychain runner and files are always injected. */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { keychainServiceNames, readClaudeToken } from "../src/usage/index.js";
import type { SecurityRunner } from "../src/usage/index.js";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "usage");
const fixture = (name: string) => readFileSync(join(FIX, name), "utf8");
const TOKEN = "sk-ant-oat01-FIXTURE-TOKEN-do-not-leak";
const HOME = "/home/fixture";
const NOW = new Date("2026-10-17T12:00:00.000Z");

function files(map: Record<string, string>): (p: string) => string | undefined {
  return (p) => map[p];
}

describe("keychain service names", () => {
  it("no env: the unsuffixed name", () => {
    expect(keychainServiceNames({}, HOME)).toEqual(["Claude Code-credentials"]);
  });
  it("CLAUDE_CONFIG_DIR: the hashed name of the raw value", () => {
    const hex = createHash("sha256").update("/x/y").digest("hex").slice(0, 8);
    expect(keychainServiceNames({ claudeConfigDir: "/x/y" }, HOME)).toEqual([`Claude Code-credentials-${hex}`]);
  });
  it("CLAUDE_CONFIG_DIR pointing at ~/.claude: hashed, then unsuffixed", () => {
    const names = keychainServiceNames({ claudeConfigDir: `${HOME}/.claude` }, HOME);
    expect(names).toHaveLength(2);
    expect(names[1]).toBe("Claude Code-credentials");
  });
  it('CLAUDE_SECURESTORAGE_CONFIG_DIR="" wins and gives the unsuffixed name', () => {
    expect(keychainServiceNames({ claudeSecureStorageConfigDir: "", claudeConfigDir: "/x/y" }, HOME)).toEqual([
      "Claude Code-credentials",
    ]);
  });
});

describe("readClaudeToken", () => {
  it("calls security with an argv array and parses the item", async () => {
    const calls: string[][] = [];
    const run: SecurityRunner = async (args) => {
      calls.push(args);
      return { code: 0, stdout: fixture("credentials-oauth.json"), timedOut: false };
    };
    const r = await readClaudeToken({ env: { user: "vb" }, home: HOME, platform: "darwin", runSecurity: run, readFile: files({}), now: NOW });
    expect(r).toEqual({ ok: true, token: TOKEN });
    expect(calls).toEqual([["find-generic-password", "-a", "vb", "-s", "Claude Code-credentials", "-w"]]);
  });

  it("exit 44 falls back to ~/.claude/.credentials.json", async () => {
    const run: SecurityRunner = async () => ({ code: 44, stdout: "", timedOut: false });
    const r = await readClaudeToken({
      env: { user: "vb" },
      home: HOME,
      platform: "darwin",
      runSecurity: run,
      readFile: files({ [`${HOME}/.claude/.credentials.json`]: fixture("credentials-oauth.json") }),
      now: NOW,
    });
    expect(r).toEqual({ ok: true, token: TOKEN });
  });

  it("a runner timeout with no file gives keychain_unavailable", async () => {
    const run: SecurityRunner = async () => ({ code: null, stdout: "", timedOut: true });
    const r = await readClaudeToken({ env: { user: "vb" }, home: HOME, platform: "darwin", runSecurity: run, readFile: files({}), now: NOW });
    expect(r).toEqual({ ok: false, cause: "keychain_unavailable" });
  });

  it("no item and no file gives not_logged_in", async () => {
    const run: SecurityRunner = async () => ({ code: 44, stdout: "", timedOut: false });
    const r = await readClaudeToken({ env: {}, home: HOME, platform: "darwin", runSecurity: run, readFile: files({}), now: NOW });
    expect(r).toEqual({ ok: false, cause: "not_logged_in" });
  });

  it("an expired token gives token_expired", async () => {
    const r = await readClaudeToken({
      env: {},
      home: HOME,
      platform: "linux",
      readFile: files({ [`${HOME}/.claude/.credentials.json`]: fixture("credentials-expired.json") }),
      now: NOW,
    });
    expect(r).toEqual({ ok: false, cause: "token_expired" });
  });

  it("a managed API key gives api_key", async () => {
    const r = await readClaudeToken({
      env: {},
      home: HOME,
      platform: "linux",
      readFile: files({ [`${HOME}/.claude.json`]: fixture("credentials-apikey.json") }),
      now: NOW,
    });
    expect(r).toEqual({ ok: false, cause: "api_key" });
  });

  it("the default runner refuses under test (never the real Keychain)", async () => {
    const r = await readClaudeToken({ env: {}, home: HOME, platform: "darwin", readFile: files({}), now: NOW });
    expect(r).toEqual({ ok: false, cause: "keychain_unavailable" });
  });
});
