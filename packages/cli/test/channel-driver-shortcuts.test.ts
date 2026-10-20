/** Shortcuts driver (integrations plan U12, KTD16) with the fake `shortcuts` bin. */

import { chmodSync, copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ChannelSetup } from "../src/channels/channel-setup.js";
import { kindEnv, refused } from "./channel-kinds-helpers.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-shortcuts/shortcuts", import.meta.url));

/** The fake's log lines: {argv, input, cwd, env}. */
const runs = (dir: string) =>
  existsSync(join(dir, "fake-shortcuts.log"))
    ? readFileSync(join(dir, "fake-shortcuts.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { argv: string[]; input: string | null; mode: number | null; env: string[] })
    : [];

describe("shortcuts", () => {
  const env = kindEnv((dir) => ({
    platform: "darwin",
    driver: { env: { pushoverApiBaseRejected: false, shortcutsBin: FAKE, childEnv: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir } }, execTimeoutMs: 1500 },
  }));
  afterEach(() => vi.unstubAllEnvs());

  it("connect runs `run <name> --input-path <file>` with the test text; the temp file is gone after", async () => {
    const { setup, dir } = env();
    const channel = await setup.connect("shortcuts", { name: "Tidegap Alerts" });
    expect(channel).toMatchObject({ state: "connected", target: 'Shortcut "Tidegap Alerts"', fields: { name: "Tidegap Alerts" } });
    const [run] = runs(dir);
    expect(run!.argv.slice(0, 3)).toEqual(["run", "Tidegap Alerts", "--input-path"]);
    expect(run!.input).toBe("Test message from Tidegap. Notifications work.");
    expect(run!.mode).toBe(0o600);
    expect(existsSync(run!.argv[3]!)).toBe(false);
  });

  it("an unknown name → not_found on the name field; a failing shortcut → shortcut_failed; nothing saved, temp files removed", async () => {
    const { setup, store, dir } = env();
    const missing = await refused(setup.connect("shortcuts", { name: "Missing" }));
    expect([missing.code, missing.field, missing.delivery]).toEqual(["test_failed", "name", "not_found"]);
    const broken = await refused(setup.connect("shortcuts", { name: "Broken" }));
    expect(broken.delivery).toBe("shortcut_failed");
    expect(store.listChannels()).toEqual([]);
    expect(runs(dir).map((r) => existsSync(r.argv[3]!))).toEqual([false, false]);
  });

  it("a shortcut that hangs is killed at the limit: timeout, and its temp file is removed", async () => {
    const { setup, dir } = env();
    const t0 = Date.now();
    const err = await refused(setup.connect("shortcuts", { name: "Slow" }));
    expect([err.delivery, err.field]).toEqual(["timeout", "name"]);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(existsSync(runs(dir)[0]!.argv[3]!)).toBe(false);
  });

  it("a name with a newline or starting with - is invalid and never runs", async () => {
    const { setup, dir } = env();
    for (const name of ["a\nb", "--help", "-i"]) {
      const err = await refused(setup.connect("shortcuts", { name }));
      expect([err.code, err.field]).toEqual(["invalid", "name"]);
    }
    expect(runs(dir)).toEqual([]);
  });

  it("the child gets only PATH, HOME, LANG and TMPDIR: no Tidegap variable, no secret", async () => {
    const { store, secretsFile, dir } = env();
    vi.stubEnv("TIDEGAP_SHORTCUTS_BIN", FAKE);
    vi.stubEnv("TIDEGAP_TELEGRAM_BOT_TOKEN", "123:secret");
    vi.stubEnv("HOME", dir);
    const real = new ChannelSetup({ store, secretsFile, uiPorts: () => [1], platform: "darwin" });
    await real.connect("shortcuts", { name: "Tidegap" });
    const keys = runs(dir)[0]!.env.filter((k) => !k.startsWith("__CF") && k !== "PWD" && k !== "SHLVL" && k !== "_");
    expect(keys.every((k) => ["PATH", "HOME", "LANG", "TMPDIR"].includes(k))).toBe(true);
  });

  it("a TIDEGAP_SHORTCUTS_BIN that others can change never runs, and the real tool is not used instead", async () => {
    const { store, secretsFile, dir } = env();
    const bin = join(dir, "shortcuts");
    copyFileSync(FAKE, bin);
    chmodSync(bin, 0o775);
    const unsafe = new ChannelSetup({
      store,
      secretsFile,
      uiPorts: () => [1],
      platform: "darwin",
      driver: { env: { pushoverApiBaseRejected: false, shortcutsBin: bin, childEnv: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir } }, execTimeoutMs: 1500 },
    });
    expect((await refused(unsafe.connect("shortcuts", { name: "Tidegap" }))).delivery).toBe("no_shortcuts");
    expect(runs(dir)).toEqual([]);
  });

  it("off macOS the kind is not offered", () => {
    const { store, secretsFile } = env();
    const linux = new ChannelSetup({ store, secretsFile, uiPorts: () => [1], platform: "linux" });
    expect(linux.status().kinds.map((k) => k.kind)).not.toContain("shortcuts");
  });
});
