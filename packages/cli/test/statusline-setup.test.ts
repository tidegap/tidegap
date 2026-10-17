/** `tidegap install`'s statusLine offer (D1). Only temp settings files are touched. */

import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  claudeSettingsPath,
  offerStatuslineHook,
  offerStatuslineInteractive,
  statuslineCommand,
  statuslineSnippet,
} from "../src/commands/statusline-setup.js";

const LAUNCHER = ["/opt/node/bin/node", "/opt/lib/node_modules/@tidegap/cli/dist/index.js"];

describe("statusLine offer", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-statusline-"));
    mkdirSync(join(dir, ".claude"));
    path = join(dir, ".claude", "settings.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("a no writes nothing", async () => {
    const r = await offerStatuslineHook({ launcher: LAUNCHER, confirm: async () => false, settingsPath: path });
    expect(r.status).toBe("declined");
    expect(() => readFileSync(path)).toThrow();
  });

  it("a yes adds statusLine and keeps the other keys", async () => {
    writeFileSync(path, JSON.stringify({ model: "opus", hooks: { a: 1 } }));
    const r = await offerStatuslineHook({ launcher: LAUNCHER, confirm: async () => true, settingsPath: path });
    expect(r.status).toBe("registered");
    const s = JSON.parse(readFileSync(path, "utf8"));
    expect(s.model).toBe("opus");
    expect(s.hooks).toEqual({ a: 1 });
    expect(s.statusLine).toEqual({ type: "command", command: `${LAUNCHER.join(" ")} usage hook` });
  });

  it("wraps an existing statusLine command and keeps its other fields", async () => {
    writeFileSync(path, JSON.stringify({ statusLine: { type: "command", command: "bash ~/.claude/x.sh | head -1", padding: 2 } }));
    await offerStatuslineHook({ launcher: LAUNCHER, confirm: async () => true, settingsPath: path });
    const s = JSON.parse(readFileSync(path, "utf8"));
    expect(s.statusLine.padding).toBe(2);
    expect(s.statusLine.command).toBe(`${LAUNCHER.join(" ")} usage hook -- sh -c 'bash ~/.claude/x.sh | head -1'`);
  });

  it("a wrapped command with single quotes runs unchanged under sh -c", async () => {
    const old = "printf '%s\\n' \"it's ok\"";
    writeFileSync(path, JSON.stringify({ statusLine: { type: "command", command: old } }));
    await offerStatuslineHook({ launcher: ["tidegap"], confirm: async () => true, settingsPath: path });
    const cmd: string = JSON.parse(readFileSync(path, "utf8")).statusLine.command;
    const inner = cmd.slice("tidegap usage hook -- sh -c ".length);
    expect(execFileSync("sh", ["-c", `printf '%s' ${inner}`], { encoding: "utf8" })).toBe(old);
  });

  it("already registered: no question", async () => {
    writeFileSync(path, JSON.stringify({ statusLine: { type: "command", command: statuslineCommand(["tidegap"]) } }));
    let asked = false;
    const r = await offerStatuslineHook({ launcher: LAUNCHER, confirm: async () => ((asked = true), true), settingsPath: path });
    expect(r.status).toBe("already");
    expect(asked).toBe(false);
  });

  it("an unparseable settings file is left alone", async () => {
    writeFileSync(path, "{ // comment\n}");
    const r = await offerStatuslineHook({ launcher: LAUNCHER, confirm: async () => true, settingsPath: path });
    expect(r.status).toBe("unreadable");
    expect(readFileSync(path, "utf8")).toBe("{ // comment\n}");
  });

  it("backs up the old file, keeps its mode and writes through a symlink", async () => {
    const real = join(dir, "dotfiles-settings.json");
    writeFileSync(real, JSON.stringify({ env: { SECRET: "x" } }));
    chmodSync(real, 0o600);
    symlinkSync(real, path);
    await offerStatuslineHook({ launcher: LAUNCHER, confirm: async () => true, settingsPath: path });
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(statSync(real).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(real, "utf8")).env).toEqual({ SECRET: "x" });
    expect(JSON.parse(readFileSync(`${real}.tidegap.bak`, "utf8"))).toEqual({ env: { SECRET: "x" } });
    expect(statSync(`${real}.tidegap.bak`).mode & 0o777).toBe(0o600);
  });

  it("creates a missing ~/.claude with a 0600 settings file", async () => {
    const fresh = join(dir, "none", ".claude", "settings.json");
    const r = await offerStatuslineHook({ launcher: LAUNCHER, confirm: async () => true, settingsPath: fresh });
    expect(r.status).toBe("registered");
    expect(statSync(fresh).mode & 0o777).toBe(0o600);
  });

  it("a file changed while the question waits is left alone", async () => {
    writeFileSync(path, JSON.stringify({ model: "opus" }));
    const r = await offerStatuslineHook({
      launcher: LAUNCHER,
      confirm: async () => (writeFileSync(path, JSON.stringify({ model: "fable" })), true),
      settingsPath: path,
    });
    expect(r.status).toBe("unreadable");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ model: "fable" });
  });

  it("without a terminal it prints the snippet and writes nothing", async () => {
    const tty = { in: process.stdin.isTTY, out: process.stdout.isTTY };
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await offerStatuslineInteractive(["tidegap"]);
      expect(log.mock.calls.map((c) => String(c[0])).join("\n")).toContain('"command": "tidegap usage hook"');
      expect(() => readFileSync(claudeSettingsPath())).toThrow();
    } finally {
      log.mockRestore();
      Object.defineProperty(process.stdin, "isTTY", { value: tty.in, configurable: true });
      Object.defineProperty(process.stdout, "isTTY", { value: tty.out, configurable: true });
    }
  });

  it("the manual snippet", () => {
    expect(JSON.parse(statuslineSnippet())).toEqual({ statusLine: { type: "command", command: "tidegap usage hook" } });
  });
});
