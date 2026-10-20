/** Command driver: argv without a shell, the Tidegap JSON on stdin, a minimal env, a time limit. */

import { chmodSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

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
});
