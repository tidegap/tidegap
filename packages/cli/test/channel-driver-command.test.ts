/** Command driver: argv without a shell, the Tidegap JSON on stdin, a minimal env, a time limit. */

import { chmodSync, copyFileSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { command as commandDriver } from "../src/channels/drivers/command.js";
import { checkProgram } from "../src/channels/drivers/program.js";
import { kindEnv, refused } from "./channel-kinds-helpers.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-command/notify", import.meta.url));
const childEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: homedir() };

const runs = (log: string) => readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { argv: string[]; input: string; cwd: string; env: string[] });

describe("command", () => {
  const env = kindEnv(() => ({ driver: { env: { pushoverApiBaseRejected: false, shortcutsBin: "", childEnv }, execTimeoutMs: 1500 } }));

  it("connect runs the program with one argv item per line and the Tidegap JSON on stdin, in the home folder", async () => {
    const { setup, dir } = env();
    const log = join(dir, "runs.log");
    const channel = await setup.connect("command", { path: FAKE, args: `${log}\n$(touch /tmp/x) ; rm -rf ~` });
    expect(channel).toMatchObject({ state: "connected", target: FAKE });
    const [run] = runs(log);
    expect(run!.argv).toEqual([log, "$(touch /tmp/x) ; rm -rf ~"]);
    expect(JSON.parse(run!.input)).toMatchObject({ version: 1, event: "test", text: "Test message from Tidegap. Notifications work." });
    expect(run!.cwd).toBe(realpathSync(homedir()));
    expect(run!.env.filter((k) => !["PWD", "SHLVL", "_"].includes(k) && !k.startsWith("__CF")).sort()).toEqual(["HOME", "PATH"]);
  });

  it("exit ≠ 0 → command_failed; a missing path → not_found; a file that is not executable → not_executable", async () => {
    const { setup, dir, store } = env();
    const log = join(dir, "runs.log");
    expect((await refused(setup.connect("command", { path: FAKE, args: `${log}\n--fail` }))).delivery).toBe("command_failed");
    const missing = await refused(setup.connect("command", { path: join(dir, "nope") }));
    expect([missing.field, missing.delivery]).toEqual(["path", "not_found"]);
    const plain = join(dir, "plain.sh");
    writeFileSync(plain, "#!/bin/sh\nexit 0\n");
    chmodSync(plain, 0o644);
    expect((await refused(setup.connect("command", { path: plain }))).delivery).toBe("not_executable");
    expect(store.listChannels()).toEqual([]);
  });

  it("a program that hangs is killed at the limit; a relative path is invalid before running", async () => {
    const { setup, dir } = env();
    const t0 = Date.now();
    expect((await refused(setup.connect("command", { path: FAKE, args: `${join(dir, "runs.log")}\n--sleep` }))).delivery).toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(5000);
    const rel = await refused(setup.connect("command", { path: "bin/notify" }));
    expect([rel.code, rel.field]).toEqual(["invalid", "path"]);
  });

  it("output over 64 KiB does not fail a program that exits 0, and none of it reaches the answer", async () => {
    const { setup, dir } = env();
    const channel = await setup.connect("command", { path: FAKE, args: `${join(dir, "runs.log")}\n--noisy` });
    expect(channel.state).toBe("connected");
    expect(JSON.stringify(channel)).not.toMatch(/xxxx|yyyy/);
  });

  it("a program that leaves background work running is done when it exits, not when its pipes close", async () => {
    const { setup, dir } = env();
    const t0 = Date.now();
    await setup.connect("command", { path: FAKE, args: `${join(dir, "runs.log")}\n--background` });
    expect(Date.now() - t0).toBeLessThan(1400);
  });

  it("a program others can change is refused before it runs: group-writable file, world-writable folder, a symlink into one", async () => {
    const { setup, dir, store } = env();
    const log = join(dir, "runs.log");
    const groupWritable = join(dir, "gw");
    copyFileSync(FAKE, groupWritable);
    chmodSync(groupWritable, 0o775);
    const open = join(dir, "open");
    mkdirSync(open);
    chmodSync(open, 0o777);
    const inOpen = join(open, "notify");
    copyFileSync(FAKE, inOpen);
    chmodSync(inOpen, 0o755);
    const link = join(dir, "link");
    symlinkSync(inOpen, link);
    for (const path of [groupWritable, inOpen, link]) {
      const err = await refused(setup.connect("command", { path, args: log }));
      expect([err.field, err.delivery]).toEqual(["path", "unsafe_path"]);
    }
    expect(() => readFileSync(log)).toThrow();
    expect(store.listChannels()).toEqual([]);
  });

  it("checkProgram: another user's file is unsafe, a folder is not executable, a relative path is invalid", () => {
    const { dir } = env();
    const uid = process.getuid!();
    expect(checkProgram(FAKE, uid)).toEqual({ ok: true, path: realpathSync(FAKE) });
    expect(checkProgram(FAKE, uid + 1)).toEqual({ ok: false, code: "unsafe_path" });
    expect(checkProgram(dir, uid)).toEqual({ ok: false, code: "not_executable" });
    expect(checkProgram("bin/notify", uid)).toEqual({ ok: false, code: "invalid_config" });
  });

  it("at send time a stored spec is checked again: a relative path, more than 10 arguments or a NUL is refused without running", async () => {
    const { dir } = env();
    const log = join(dir, "runs.log");
    const ctx = { http: { uiPorts: [1] }, env: { pushoverApiBaseRejected: false, shortcutsBin: "", childEnv }, execTimeoutMs: 1500 };
    const send = (path: string, args: string[]) => commandDriver.send({ type: "command", path, args, input: "{}" }, ctx).then(() => "ok", (e: { code?: string }) => e.code);
    expect(await send("bin/notify", [log])).toBe("invalid_config");
    expect(await send(FAKE, [log, ...Array.from({ length: 10 }, (_, i) => `a${i}`)])).toBe("invalid_config");
    expect(await send(FAKE, [log, "a\0b"])).toBe("invalid_config");
    expect(() => readFileSync(log)).toThrow();
    expect(await send(FAKE, [log])).toBe("ok");
  });
});
