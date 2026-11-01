/**
 * The Claude Code statusLine registration: inspect, plan, register, remove,
 * the guarded hook command, and `tidegap install`'s offer. Only temp
 * settings files and temp homes are touched.
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runInstall } from "../src/commands/install.js";
import {
  guardedCommand,
  hookLauncher,
  inspectStatusline,
  installHookCommand,
  offerStatuslineHook,
  offerStatuslineInteractive,
  parseGuardedCommand,
  registerHook,
  removeHook,
} from "../src/commands/statusline-setup.js";
import { buildProgram } from "../src/index.js";

// The install action's own work is stubbed; only its statusLine question runs.
vi.mock("../src/commands/install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/commands/install.js")>()),
  runInstall: vi.fn(),
}));

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(HERE, "..", "dist", "index.js");
const FIX = join(HERE, "fixtures", "usage");
const SECRET = "sk-ant-oat01-FIXTURE-SETTINGS-do-not-leak";

/**
 * A terminal for the install question: streams that say they are TTYs.
 * `answer` types its keys once the question is on screen; `shown` is the
 * screen text without cursor escapes and with `\r\n` as `\n`.
 */
function fakeTerminal() {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => input });
  const output = Object.assign(new PassThrough(), { isTTY: true });
  let text = "";
  output.on("data", (d) => (text += String(d)));
  return {
    input,
    output,
    // eslint-disable-next-line no-control-regex
    shown: () => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r\n/g, "\n"),
    answer: async (keys: string | null) => {
      await vi.waitFor(() => expect(text).toContain("[y/N] "));
      if (keys === null) input.end();
      else input.write(keys);
    },
  };
}

/** User statusLine commands that must survive a wrap and a remove unchanged. */
const AWKWARD = [
  "bash ~/.claude/x.sh | head -1",
  "printf '%s\\n' \"it's ok\"",
  'echo "$HOME" $USER',
  "echo `date +%H`",
  "  spaced   out  ",
  "echo done;",
  "printf 'a\\nb'\necho second line",
  "echo 'déjà vu' ✓",
];

describe("statusLine registration", () => {
  let dir: string;
  let path: string;
  let launcher: string[];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-statusline-"));
    mkdirSync(join(dir, ".claude"));
    path = join(dir, ".claude", "settings.json");
    // A launcher whose two paths exist, so a hook over it is current, not stale.
    mkdirSync(join(dir, "bin"));
    launcher = [join(dir, "bin", "node"), join(dir, "bin", "index.js")];
    for (const p of launcher) writeFileSync(p, "");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const seed = (statusLine: unknown, extra: Record<string, unknown> = {}) =>
    writeFileSync(path, `${JSON.stringify({ model: "opus", ...extra, ...(statusLine === undefined ? {} : { statusLine }) }, null, 2)}\n`);
  const settings = () => JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
  const legacy = (cmd: string) => `${launcher.join(" ")} usage hook -- sh -c ${cmd}`;

  describe("guarded command", () => {
    it("round-trips every awkward user command, and the bare hook", () => {
      for (const user of [...AWKWARD, undefined]) {
        const cmd = guardedCommand(launcher, user);
        expect(parseGuardedCommand(cmd), JSON.stringify(user)).toEqual({ launcher, ...(user === undefined ? {} : { userCommand: user }) });
      }
    });

    it("keeps the user's command as its last word, so the file still shows it", () => {
      const cmd = guardedCommand(launcher, "bash ~/.claude/x.sh | head -1");
      expect(cmd.startsWith("sh -c '")).toBe(true);
      expect(cmd.endsWith(` ${launcher.join(" ")} -- 'bash ~/.claude/x.sh | head -1'`)).toBe(true);
    });

    it("stores this exact text: every installed hook carries it, so a change must keep the old text parsed", () => {
      expect(guardedCommand(["/opt/node", "/opt/tidegap/index.js"], "echo hi")).toBe(
        `sh -c 'm=; c=; s=; for a in "$@"; do shift; if [ -n "$s" ]; then c=$a; elif [ "$a" = -- ]; then s=1; ` +
          `else [ -e "$a" ] || m=1; set -- "$@" "$a"; fi; done; ` +
          `if [ -z "$m" ]; then if [ -n "$c" ]; then exec "$@" usage hook -- sh -c "$c"; fi; exec "$@" usage hook; fi; ` +
          `if [ -n "$c" ]; then exec sh -c "$c"; fi; exit 0' tidegap-usage-hook /opt/node /opt/tidegap/index.js -- 'echo hi'`,
      );
    });

    it("parses only the exact shape it writes", () => {
      const good = guardedCommand(launcher, "echo hi");
      for (const bad of [
        good.replace("tidegap-usage-hook", "other-name"),
        good.replace(" -- ", " "),
        `${good} extra`,
        `${good} `,
        good.replace(launcher[0]!, "node"),
        guardedCommand(launcher, "echo hi").replace("'echo hi'", "\"echo hi\""),
        good.replace("exit 0", "exit 1"),
        "tidegap usage hook",
      ]) {
        expect(parseGuardedCommand(bad), bad).toBeUndefined();
      }
    });

    it("refuses a relative launcher or one of three paths", () => {
      expect(() => guardedCommand(["tidegap"], "x")).toThrow(/absolute/);
      expect(() => guardedCommand(["/a", "/b", "/c"], "x")).toThrow(/one or two/);
    });
  });

  describe("inspect", () => {
    it("names each state; a hand-edited command with usage hook counts as connected", () => {
      const state = () => inspectStatusline(path).state;
      expect(state()).toBe("absent");
      seed(undefined);
      expect(state()).toBe("absent");
      seed({ type: "command", command: "   " });
      expect(state()).toBe("absent");
      seed({ type: "command", command: "~/.claude/statusline.sh" });
      expect(inspectStatusline(path)).toMatchObject({ state: "other", userCommand: "~/.claude/statusline.sh" });
      seed({ type: "command", command: guardedCommand(launcher, "echo me") });
      expect(inspectStatusline(path)).toMatchObject({ state: "connected", userCommand: "echo me" });
      seed({ type: "command", command: legacy("'echo me'") });
      expect(inspectStatusline(path)).toMatchObject({ state: "legacy", userCommand: "echo me" });
      seed({ type: "command", command: "tidegap usage hook" });
      expect(inspectStatusline(path)).toMatchObject({ state: "legacy" });
      seed({ type: "command", command: guardedCommand(["/gone/node", launcher[1]!], "echo me") });
      expect(inspectStatusline(path)).toMatchObject({ state: "stale", userCommand: "echo me" });
      seed({ type: "command", command: "tidegap usage hook -- ~/.claude/statusline.sh" });
      expect(inspectStatusline(path)).toMatchObject({ state: "connected", foreign: true });
      writeFileSync(path, "{ // comment\n}");
      expect(inspectStatusline(path)).toMatchObject({ state: "unreadable", reason: "is not valid JSON" });
      writeFileSync(path, "[1]");
      expect(inspectStatusline(path)).toMatchObject({ state: "unreadable", reason: "is not a JSON object" });
      seed("a string");
      expect(inspectStatusline(path)).toMatchObject({ state: "unreadable", reason: "has a statusLine in another format" });
    });

    it("a malformed file gives the fixed reason, never the parser's text with the secret", () => {
      const raw = `{"env": {"ANTHROPIC_API_KEY": ${SECRET}}}`;
      writeFileSync(path, raw);
      const insp = inspectStatusline(path);
      expect(insp).toMatchObject({ state: "unreadable", reason: "is not valid JSON" });
      const r = registerHook({ launcher, settingsPath: path });
      expect(r).toMatchObject({ ok: false, result: "unreadable" });
      expect(JSON.stringify(r)).not.toContain(SECRET);
      expect(JSON.stringify(removeHook({ settingsPath: path }))).not.toContain(SECRET);
      expect(readFileSync(path, "utf8")).toBe(raw);
    });

    it("an unreadable path names the errno code only", () => {
      mkdirSync(path);
      expect(inspectStatusline(path)).toEqual(expect.objectContaining({ state: "unreadable", reason: "cannot be read (EISDIR)" }));
    });
  });

  describe("register", () => {
    it("absent: registered; the other keys stay", () => {
      seed(undefined, { hooks: { a: 1 } });
      const r = registerHook({ launcher, settingsPath: path });
      expect(r).toMatchObject({ ok: true, result: "registered" });
      const s = settings();
      expect([s.model, s.hooks]).toEqual(["opus", { a: 1 }]);
      expect(s.statusLine).toEqual({ type: "command", command: guardedCommand(launcher) });
    });

    it("other: wrapped, keeping the statusLine's other fields", () => {
      seed({ type: "command", command: "bash ~/.claude/x.sh | head -1", padding: 2 });
      expect(registerHook({ launcher, settingsPath: path })).toMatchObject({ ok: true, result: "wrapped" });
      expect(settings().statusLine).toEqual({ type: "command", command: guardedCommand(launcher, "bash ~/.claude/x.sh | head -1"), padding: 2 });
    });

    it("twice: the second answers already and the file bytes do not change (AE5)", () => {
      seed({ type: "command", command: "echo me" });
      registerHook({ launcher, settingsPath: path });
      const bytes = readFileSync(path);
      expect(registerHook({ launcher, settingsPath: path })).toMatchObject({ ok: true, result: "already" });
      expect(readFileSync(path).equals(bytes)).toBe(true);
    });

    it("legacy and stale: updated, keeping the user's command, with the current launcher", () => {
      for (const command of [legacy("'echo me'"), guardedCommand(["/gone/node", launcher[1]!], "echo me")]) {
        seed({ type: "command", command });
        expect(registerHook({ launcher, settingsPath: path })).toMatchObject({ ok: true, result: "updated" });
        expect(settings().statusLine.command).toBe(guardedCommand(launcher, "echo me"));
      }
      seed({ type: "command", command: "tidegap usage hook" });
      expect(registerHook({ launcher, settingsPath: path })).toMatchObject({ ok: true, result: "updated" });
      expect(settings().statusLine.command).toBe(guardedCommand(launcher));
    });

    it("a hand-edited hook is never rewritten", () => {
      seed({ type: "command", command: "tidegap usage hook -- ~/.claude/statusline.sh" });
      const bytes = readFileSync(path);
      expect(registerHook({ launcher, settingsPath: path })).toMatchObject({ ok: true, result: "already" });
      expect(readFileSync(path).equals(bytes)).toBe(true);
    });

    it("an unreadable file stays byte-identical", () => {
      writeFileSync(path, "{ // comment\n}");
      expect(registerHook({ launcher, settingsPath: path })).toMatchObject({
        ok: false,
        result: "unreadable",
        rule: "Tidegap cannot read ~/.claude/settings.json, so it cannot connect: is not valid JSON.",
      });
      expect(readFileSync(path, "utf8")).toBe("{ // comment\n}");
    });

    it("a file changed between inspect and write is left alone", () => {
      seed({ type: "command", command: "echo me" });
      const inspection = inspectStatusline(path);
      writeFileSync(path, JSON.stringify({ model: "fable" }));
      expect(registerHook({ launcher, settingsPath: path, inspection })).toMatchObject({ ok: false, result: "changed" });
      expect(readFileSync(path, "utf8")).toBe(JSON.stringify({ model: "fable" }));
    });

    it("backs up the old file, keeps its mode and writes through a symlink", () => {
      const real = join(dir, "dotfiles-settings.json");
      writeFileSync(real, JSON.stringify({ env: { SECRET: "x" } }));
      chmodSync(real, 0o600);
      symlinkSync(real, path);
      expect(registerHook({ launcher, settingsPath: path })).toMatchObject({ ok: true, result: "registered", backup: `${realpathSync(real)}.tidegap.bak` });
      expect(lstatSync(path).isSymbolicLink()).toBe(true);
      expect(statSync(real).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(real, "utf8")).env).toEqual({ SECRET: "x" });
      expect(JSON.parse(readFileSync(`${real}.tidegap.bak`, "utf8"))).toEqual({ env: { SECRET: "x" } });
      expect(statSync(`${real}.tidegap.bak`).mode & 0o777).toBe(0o600);
    });

    it("a link planted at the backup or temp path is replaced, never written through", () => {
      seed(undefined);
      const victim = join(dir, "victim");
      writeFileSync(victim, "keep");
      symlinkSync(victim, `${path}.tidegap.bak`);
      symlinkSync(victim, `${path}.tidegap.tmp`);
      expect(registerHook({ launcher, settingsPath: path })).toMatchObject({ ok: true, result: "registered" });
      expect(readFileSync(victim, "utf8")).toBe("keep");
      expect(lstatSync(`${path}.tidegap.bak`).isSymbolicLink()).toBe(false);
      expect(existsSync(`${path}.tidegap.tmp`)).toBe(false);
      expect(lstatSync(path).isSymbolicLink()).toBe(false);
    });

    it.skipIf(process.getuid?.() === 0)("a write that fails throws and leaves the file, and no temp file, behind", () => {
      seed({ type: "command", command: "echo me" });
      const bytes = readFileSync(path);
      chmodSync(dirname(path), 0o500);
      try {
        expect(() => registerHook({ launcher, settingsPath: path })).toThrow();
      } finally {
        chmodSync(dirname(path), 0o700);
      }
      expect(readFileSync(path).equals(bytes)).toBe(true);
      expect([existsSync(`${path}.tidegap.tmp`), existsSync(`${path}.tidegap.bak`)]).toEqual([false, false]);
    });

    it("creates a missing ~/.claude with a 0600 settings file", () => {
      const fresh = join(dir, "none", ".claude", "settings.json");
      expect(registerHook({ launcher, settingsPath: fresh })).toMatchObject({ ok: true, result: "registered" });
      expect(statSync(fresh).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(fresh)).mode & 0o777).toBe(0o700);
    });
  });

  describe("remove", () => {
    it("restores the exact original command; other keys and padding stay (AE5)", () => {
      for (const original of AWKWARD) {
        seed({ type: "command", command: original, padding: 2 }, { env: { A: "1" } });
        const before = readFileSync(path, "utf8");
        expect(registerHook({ launcher, settingsPath: path })).toMatchObject({ ok: true, result: "wrapped" });
        expect(removeHook({ settingsPath: path })).toMatchObject({ ok: true, result: "removed", restored: original });
        expect(settings().statusLine).toEqual({ type: "command", command: original, padding: 2 });
        expect(readFileSync(path, "utf8")).toBe(before);
      }
    });

    it("with no user command, removes what the hook added, and the key when nothing else is left", () => {
      seed(undefined);
      registerHook({ launcher, settingsPath: path });
      expect(removeHook({ settingsPath: path })).toMatchObject({ ok: true, result: "removed" });
      expect(settings()).toEqual({ model: "opus" });
      seed({ padding: 1 });
      registerHook({ launcher, settingsPath: path });
      removeHook({ settingsPath: path });
      expect(settings().statusLine).toEqual({ padding: 1 });
    });

    it("an older hook shape restores its wrapped command too", () => {
      seed({ type: "command", command: legacy("'echo me'") });
      expect(removeHook({ settingsPath: path })).toMatchObject({ ok: true, result: "removed", restored: "echo me" });
      expect(settings().statusLine.command).toBe("echo me");
    });

    it("no hook: writes nothing and says so", () => {
      for (const statusLine of [undefined, { type: "command", command: "echo me" }]) {
        seed(statusLine);
        const bytes = readFileSync(path);
        expect(removeHook({ settingsPath: path })).toEqual({ ok: true, result: "none" });
        expect(readFileSync(path).equals(bytes)).toBe(true);
      }
      rmSync(path);
      expect(removeHook({ settingsPath: path })).toEqual({ ok: true, result: "none" });
      expect(existsSync(path)).toBe(false);
    });

    it("refuses a hand-edited hook, an unreadable file and a file that changed", () => {
      seed({ type: "command", command: "tidegap usage hook -- ~/.claude/statusline.sh" });
      expect(removeHook({ settingsPath: path })).toMatchObject({ ok: false, result: "foreign" });
      writeFileSync(path, "nope");
      expect(removeHook({ settingsPath: path })).toMatchObject({ ok: false, result: "unreadable" });
      expect(readFileSync(path, "utf8")).toBe("nope");
      seed({ type: "command", command: guardedCommand(launcher, "echo me") });
      const inspection = inspectStatusline(path);
      writeFileSync(path, "{}");
      expect(removeHook({ settingsPath: path, inspection })).toMatchObject({ ok: false, result: "changed" });
      expect(readFileSync(path, "utf8")).toBe("{}");
    });
  });

  describe("launcher paths", () => {
    it("the stored node is the PATH node that resolves to the running binary; else process.execPath", () => {
      const bin = join(dir, "pathbin");
      mkdirSync(bin);
      const script = "/opt/lib/node_modules/@tidegap/cli/dist/index.js";
      expect(hookLauncher([process.execPath, script], { pathEnv: bin })).toEqual([process.execPath, script]);
      symlinkSync(process.execPath, join(bin, "node"));
      expect(hookLauncher([process.execPath, script], { pathEnv: `${join(dir, "empty")}:${bin}` })).toEqual([join(bin, "node"), script]);
      // Another node on PATH is not this one.
      rmSync(join(bin, "node"));
      writeFileSync(join(bin, "node"), "");
      expect(hookLauncher([process.execPath, script], { pathEnv: bin })).toEqual([process.execPath, script]);
      // A single binary (TIDEGAP_BINARY) is kept as it is.
      expect(hookLauncher(["/usr/local/bin/tidegap"], { pathEnv: bin })).toEqual(["/usr/local/bin/tidegap"]);
    });

    it("the printed command is `tidegap usage install-hook` when that tidegap is this script; else the absolute launcher", () => {
      const bin = join(dir, "pathbin");
      mkdirSync(bin);
      const script = launcher[1]!;
      expect(installHookCommand(launcher, { pathEnv: bin })).toBe(`${launcher.join(" ")} usage install-hook`);
      symlinkSync(script, join(bin, "tidegap"));
      expect(installHookCommand(launcher, { pathEnv: bin })).toBe("tidegap usage install-hook");
    });
  });

  describe("tidegap install's offer", () => {
    it("a no writes nothing", async () => {
      const r = await offerStatuslineHook({ launcher, confirm: async () => false, settingsPath: path });
      expect(r).toMatchObject({ ok: true, result: "declined" });
      expect(existsSync(path)).toBe(false);
    });

    it("the question says what changes; a yes wraps", async () => {
      seed({ type: "command", command: "echo me" });
      let question = "";
      const r = await offerStatuslineHook({ launcher, confirm: async (q) => ((question = q), true), settingsPath: path });
      expect(r).toMatchObject({ ok: true, result: "wrapped" });
      expect(question).toMatch(/^Wrap your Claude Code statusLine in the Tidegap usage hook/);
      expect(question).toContain("your status line keeps working");
      expect(question).toContain(guardedCommand(launcher, "echo me"));
    });

    it("an older or moved hook is updated after a yes", async () => {
      seed({ type: "command", command: legacy("'echo me'") });
      let question = "";
      const r = await offerStatuslineHook({ launcher, confirm: async (q) => ((question = q), true), settingsPath: path });
      expect(r).toMatchObject({ ok: true, result: "updated" });
      expect(question).toMatch(/^Update the Tidegap usage hook/);
    });

    it("connected or unreadable: no question", async () => {
      let asked = false;
      const confirm = async () => ((asked = true), true);
      seed({ type: "command", command: guardedCommand(launcher) });
      expect(await offerStatuslineHook({ launcher, confirm, settingsPath: path })).toMatchObject({ ok: true, result: "already" });
      writeFileSync(path, "{ // comment\n}");
      expect(await offerStatuslineHook({ launcher, confirm, settingsPath: path })).toMatchObject({ ok: false, result: "unreadable" });
      expect(asked).toBe(false);
    });

    it("a file changed while the question waits is left alone", async () => {
      seed(undefined);
      const r = await offerStatuslineHook({
        launcher,
        confirm: async () => (writeFileSync(path, JSON.stringify({ model: "fable" })), true),
        settingsPath: path,
      });
      expect(r).toMatchObject({ ok: false, result: "changed" });
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ model: "fable" });
    });

    /** The end of the screen after a no: the question's last line, then the skip line on its own line. */
    const skipped = () => `[y/N] \nSkipped. To connect later, run: ${launcher.join(" ")} usage install-hook\n`;

    it("Ctrl-D, Ctrl-C or the end of input at the question answers no on a new line, and writes nothing", async () => {
      for (const key of ["\x04", "\x03", null]) {
        seed({ type: "command", command: "echo me" });
        const bytes = readFileSync(path);
        const t = fakeTerminal();
        const done = offerStatuslineInteractive(launcher, { settingsPath: path, pathEnv: "", input: t.input, output: t.output });
        await t.answer(key);
        await done;
        expect(t.shown().endsWith(skipped()), `${JSON.stringify(key)}: ${t.shown()}`).toBe(true);
        expect(readFileSync(path).equals(bytes), JSON.stringify(key)).toBe(true);
      }
    });

    it("in a terminal, y and Enter wraps and says so; Enter alone skips", async () => {
      seed({ type: "command", command: "echo me" });
      const t = fakeTerminal();
      const done = offerStatuslineInteractive(launcher, { settingsPath: path, pathEnv: "", input: t.input, output: t.output });
      await t.answer("y\r");
      await done;
      expect(settings().statusLine.command).toBe(guardedCommand(launcher, "echo me"));
      expect(t.shown()).toMatch(/\[y\/N\] y\nWrapped your Claude Code statusLine in the Tidegap usage hook \(.+\); it keeps working\./);
      seed({ type: "command", command: "echo me" });
      const bytes = readFileSync(path);
      const t2 = fakeTerminal();
      const done2 = offerStatuslineInteractive(launcher, { settingsPath: path, pathEnv: "", input: t2.input, output: t2.output });
      await t2.answer("\r");
      await done2;
      expect(t2.shown().endsWith(skipped()), t2.shown()).toBe(true);
      expect(readFileSync(path).equals(bytes)).toBe(true);
    });

    it("tidegap install: Ctrl-D at the question prints the skip line and keeps the install's exit code", async () => {
      vi.mocked(runInstall).mockResolvedValueOnce({ exitCode: 1, launcher, nextSteps: "the install failed" } as Awaited<ReturnType<typeof runInstall>>);
      const t = fakeTerminal();
      const stdin = vi.spyOn(process, "stdin", "get").mockReturnValue(t.input as unknown as typeof process.stdin);
      const stdout = vi.spyOn(process, "stdout", "get").mockReturnValue(t.output as unknown as typeof process.stdout);
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const run = buildProgram().parseAsync(["node", "tidegap", "install", "--no-load"]);
        await t.answer("\x04");
        await run;
        expect(process.exitCode).toBe(1);
        expect(t.shown()).toMatch(/\[y\/N\] \nSkipped\. To connect later, run: .+ usage install-hook\n$/);
        expect(existsSync(join(process.env.HOME!, ".claude", "settings.json"))).toBe(false);
      } finally {
        stdin.mockRestore();
        stdout.mockRestore();
        log.mockRestore();
        process.exitCode = undefined;
      }
    });

    it("without a terminal it prints the state and the install-hook command, and writes nothing", async () => {
      const tty = { in: process.stdin.isTTY, out: process.stdout.isTTY };
      Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
      Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        await offerStatuslineInteractive(launcher, { settingsPath: path, pathEnv: "" });
        seed({ type: "command", command: "echo me" });
        const bytes = readFileSync(path);
        await offerStatuslineInteractive(launcher, { settingsPath: path, pathEnv: "" });
        const lines = log.mock.calls.map((c) => String(c[0]));
        expect(lines).toEqual([
          `Claude Code limits: not connected (no statusLine in ~/.claude/settings.json). To connect, run: ${launcher.join(" ")} usage install-hook`,
          `Claude Code limits: not connected (your own statusLine; the hook wraps it, so it keeps working). To connect, run: ${launcher.join(" ")} usage install-hook`,
        ]);
        expect(readFileSync(path).equals(bytes)).toBe(true);
      } finally {
        log.mockRestore();
        Object.defineProperty(process.stdin, "isTTY", { value: tty.in, configurable: true });
        Object.defineProperty(process.stdout, "isTTY", { value: tty.out, configurable: true });
      }
    });
  });
});

describe.skipIf(!existsSync(ENTRY))("the stored hook command under sh (built CLI)", () => {
  let dir: string;
  let path: string;
  let script: string;
  const input = readFileSync(join(FIX, "statusline-input.json"));
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-statusline-run-"));
    path = join(dir, ".claude", "settings.json");
    mkdirSync(dirname(path));
    // The user's own status line: reads Claude Code's JSON, prints a line with a quote and a dollar.
    script = join(dir, "my statusline.sh");
    writeFileSync(script, "#!/bin/sh\nprintf '%s it'\\''s $5 [%s]\\n' \"$(cat | head -c 13)\" \"$1\"\n");
    chmodSync(script, 0o755);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** Run a statusLine command the way Claude Code does: through sh, Claude Code's JSON on stdin. */
  const run = (command: string) =>
    spawnSync("/bin/sh", ["-c", command], { input, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: dir }, cwd: dir });
  const userCommand = () => `'${script}' "arg one"`;

  it("wrap: the stored command prints the user's line byte for byte and records usage.json (AE3)", () => {
    writeFileSync(path, JSON.stringify({ statusLine: { type: "command", command: userCommand() } }));
    expect(registerHook({ launcher: [process.execPath, ENTRY], settingsPath: path })).toMatchObject({ ok: true, result: "wrapped" });
    const stored: string = JSON.parse(readFileSync(path, "utf8")).statusLine.command;
    const direct = run(userCommand());
    expect(direct.stdout).toBe(`{"session_id" it's $5 [arg one]\n`);
    const hooked = run(stored);
    expect([hooked.status, hooked.stdout, hooked.stderr]).toEqual([0, direct.stdout, ""]);
    const usage = JSON.parse(readFileSync(join(dir, ".tidegap", "usage.json"), "utf8"));
    expect(usage.claude.statusline.data.five_hour.pct).toBe(72);
  });

  it("a missing runtime: the user's line still prints and the exit is 0; no user command prints nothing (AE4)", () => {
    const gone = guardedCommand([join(dir, "moved", "node"), ENTRY], userCommand());
    const r = run(gone);
    expect([r.status, r.stdout]).toEqual([0, `{"session_id" it's $5 [arg one]\n`]);
    expect(existsSync(join(dir, ".tidegap", "usage.json"))).toBe(false);
    const bare = run(guardedCommand([process.execPath, join(dir, "moved", "index.js")]));
    expect([bare.status, bare.stdout, bare.stderr]).toEqual([0, "", ""]);
  });

  it("the bare hook records and prints nothing", () => {
    const r = run(guardedCommand([process.execPath, ENTRY]));
    expect([r.status, r.stdout]).toEqual([0, ""]);
    expect(existsSync(join(dir, ".tidegap", "usage.json"))).toBe(true);
  });
});
