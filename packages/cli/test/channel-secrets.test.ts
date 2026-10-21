/** Channel secrets file (integrations plan U2, KTD4). Only temp paths under the hermetic home are touched. */

import { chmodSync, lstatSync, mkdirSync, readdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { channelSecretsPath, readSecrets, writeSecrets } from "../src/channels/secrets.js";

const URL_SECRET = "https://hooks.example.test/services/T000/B000/sEcReTvAlUe";

describe("channel secrets", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-secrets-"));
    path = join(dir, "cfg", "tidegap", "channel-secrets.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("lives next to the env file, under the (hermetic) home", () => {
    expect(channelSecretsPath("/h")).toBe("/h/.config/tidegap/channel-secrets.json");
    expect(channelSecretsPath()).toBe(join(homedir(), ".config", "tidegap", "channel-secrets.json"));
  });

  it("a write creates the file 0600 in a 0700 directory and reads back", () => {
    writeSecrets("webhook", { url: URL_SECRET }, path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "cfg", "tidegap")).mode & 0o777).toBe(0o700);
    expect(readSecrets("webhook", path)).toEqual({ url: URL_SECRET });
    expect(readSecrets("slack", path)).toBeUndefined();
  });

  it("a second write keeps other ids; undefined deletes one id only", () => {
    writeSecrets("webhook", { url: URL_SECRET }, path);
    writeSecrets("ntfy", { topic: "tidegap-abc", token: "tk_1" }, path);
    expect(readSecrets("webhook", path)).toEqual({ url: URL_SECRET });
    writeSecrets("webhook", undefined, path);
    expect(readSecrets("webhook", path)).toBeUndefined();
    expect(readSecrets("ntfy", path)).toEqual({ topic: "tidegap-abc", token: "tk_1" });
  });

  it("a symlinked file stays a symlink and its target is written", () => {
    const real = join(dir, "dotfiles", "channel-secrets.json");
    mkdirSync(join(dir, "dotfiles"));
    writeFileSync(real, "{}\n", { mode: 0o600 });
    mkdirSync(join(dir, "cfg", "tidegap"), { recursive: true });
    symlinkSync(real, path);
    writeSecrets("webhook", { url: URL_SECRET }, path);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(real, "utf8"))).toEqual({ webhook: { url: URL_SECRET } });
  });

  it("a malformed file reads as empty with one log line that names no value, and the next write keeps it as .bak", () => {
    mkdirSync(join(dir, "cfg", "tidegap"), { recursive: true });
    const broken = `{"webhook": {"url": "${URL_SECRET}"`;
    writeFileSync(path, broken, { mode: 0o600 });
    const logs: string[] = [];
    expect(readSecrets("webhook", path, (l) => logs.push(l))).toBeUndefined();
    expect(logs).toHaveLength(1);
    expect(logs[0]).not.toContain(URL_SECRET);
    writeSecrets("ntfy", { topic: "t" }, path);
    expect(readFileSync(`${path}.bak`, "utf8")).toBe(broken);
    expect(statSync(`${path}.bak`).mode & 0o777).toBe(0o600);
    expect(readSecrets("ntfy", path)).toEqual({ topic: "t" });
  });

  it("a write over an existing 0644 file in a 0755 directory leaves the file 0600 with the other ids kept", () => {
    const cfg = join(dir, "cfg", "tidegap");
    mkdirSync(cfg, { recursive: true, mode: 0o755 });
    chmodSync(cfg, 0o755);
    writeFileSync(path, JSON.stringify({ ntfy: { topic: "tidegap-abc" } }));
    chmodSync(path, 0o644);
    writeSecrets("webhook", { url: URL_SECRET }, path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readSecrets("ntfy", path)).toEqual({ topic: "tidegap-abc" });
    expect(readSecrets("webhook", path)).toEqual({ url: URL_SECRET });
    // The code creates a missing directory 0700 but does not tighten one that exists.
    expect(statSync(cfg).mode & 0o777).toBe(0o755);
  });

  it("a delete rewrite also tightens a 0644 file, and no temp or lock file is left behind", () => {
    mkdirSync(join(dir, "cfg", "tidegap"), { recursive: true });
    writeFileSync(path, JSON.stringify({ webhook: { url: URL_SECRET } }));
    chmodSync(path, 0o644);
    writeSecrets("webhook", undefined, path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(dir, "cfg", "tidegap"))).toEqual(["channel-secrets.json"]);
  });

  it("entries that are not string maps are dropped on read", () => {
    mkdirSync(join(dir, "cfg", "tidegap"), { recursive: true });
    writeFileSync(path, JSON.stringify({ a: "x", b: [1], c: { k: "v", n: 1 } }));
    expect(readSecrets("a", path)).toBeUndefined();
    expect(readSecrets("c", path)).toEqual({ k: "v" });
  });
});
