import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AnthropicAdapter } from "@tidegap/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claudeChildEnv,
  claudeMaxBudget,
  claudeResumeMaxBudget,
  claudeTools,
  findClaudeBinary,
  isExecutableFile,
  queryLoginShell,
  type ClaudeLookup,
} from "../src/claude-code.js";
import { buildAdapters, runTickOnce } from "../src/commands/tick.js";
import { readEnvCredentials } from "../src/env.js";
import { ClaudeCodeAdapter } from "../src/providers/claude-code.js";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-claude", "claude");

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "tidegap-cc-lookup-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Install a fake `claude` at `<root>/<rel>/claude` and return its path. */
function installFake(rel: string): string {
  const dir = join(root, rel);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "claude");
  copyFileSync(FAKE, path);
  return path;
}

/** The real executable check, limited to this test's temp dir so no real install is found. */
function inRootExecutable(path: string): boolean {
  if (!path.startsWith(root)) return false;
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function lookup(extra: ClaudeLookup = {}): ClaudeLookup {
  return {
    path: "",
    home: join(root, "home"),
    platform: "linux",
    isExecutable: inRootExecutable,
    loginShell: () => {
      throw new Error("login shell must not run");
    },
    ...extra,
  };
}

const on = { claudeCodeDisabled: false };
const noPending = () => false;

describe("findClaudeBinary", () => {
  it("prefers TIDEGAP_CLAUDE_BIN over a PATH hit", async () => {
    installFake("bin");
    const explicit = installFake("explicit");
    expect(
      await findClaudeBinary({ ...on, claudeBin: explicit }, noPending, lookup({ path: join(root, "bin") })),
    ).toBe(explicit);
  });

  it("a TIDEGAP_CLAUDE_BIN that does not exist finds nothing, even with a PATH hit", async () => {
    installFake("bin");
    expect(
      await findClaudeBinary({ ...on, claudeBin: "/nonexistent/claude" }, noPending, lookup({ path: join(root, "bin") })),
    ).toBeUndefined();
  });

  it("finds claude on PATH", async () => {
    const fake = installFake("bin");
    expect(await findClaudeBinary(on, noPending, lookup({ path: `${join(root, "empty")}:${join(root, "bin")}` }))).toBe(fake);
  });

  it("finds ~/.local/bin/claude with an empty PATH", async () => {
    const fake = installFake("home/.local/bin");
    expect(await findClaudeBinary(on, noPending, lookup())).toBe(fake);
  });

  it("asks the login shell on macOS only, and only when a pending task needs claude", async () => {
    const fake = installFake("shell-only");
    const loginShell = vi.fn(async () => fake);
    expect(await findClaudeBinary(on, () => true, lookup({ platform: "darwin", loginShell }))).toBe(fake);
    expect(loginShell).toHaveBeenCalledTimes(1);

    loginShell.mockClear();
    expect(await findClaudeBinary(on, () => true, lookup({ platform: "linux", loginShell }))).toBeUndefined();
    expect(await findClaudeBinary(on, noPending, lookup({ platform: "darwin", loginShell }))).toBeUndefined();
    expect(loginShell).not.toHaveBeenCalled();
  });

  it("ignores a login-shell answer that is not an absolute executable path", async () => {
    const loginShell = async () => "alias claude=foo";
    expect(await findClaudeBinary(on, () => true, lookup({ platform: "darwin", loginShell }))).toBeUndefined();
  });

  it("TIDEGAP_CLAUDE_CODE=off turns the lookup off", async () => {
    installFake("bin");
    const saved = process.env.TIDEGAP_CLAUDE_CODE;
    process.env.TIDEGAP_CLAUDE_CODE = "off";
    try {
      const env = readEnvCredentials(() => {});
      expect(env.claudeCodeDisabled).toBe(true);
      expect(await findClaudeBinary(env, noPending, lookup({ path: join(root, "bin") }))).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.TIDEGAP_CLAUDE_CODE;
      else process.env.TIDEGAP_CLAUDE_CODE = saved;
    }
  });

  it("rejects a binary that another user could swap", () => {
    const fake = installFake("safe");
    chmodSync(join(root, "safe"), 0o755);
    expect(isExecutableFile(fake)).toBe(true);

    const open = installFake("open");
    chmodSync(join(root, "open"), 0o777);
    expect(isExecutableFile(open)).toBe(false);

    // A symlink in a safe directory to a binary in a world-writable one.
    symlinkSync(open, join(root, "safe", "linked"));
    expect(isExecutableFile(join(root, "safe", "linked"))).toBe(false);

    chmodSync(fake, 0o777);
    expect(isExecutableFile(fake)).toBe(false);
  });

  it("finds nothing under the test runner without injected lookup inputs", async () => {
    expect(await findClaudeBinary({ ...on, claudeBin: "/explicit/claude" }, () => true)).toBeUndefined();
  });
});

/** True while the pid exists (signal 0 only probes); EPERM counts as alive. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

describe("queryLoginShell", () => {
  /** A fake login shell at `<root>/<name>`; it gets the real `-ilc <command>` arguments. */
  function fakeShell(name: string, body: string): string {
    const path = join(root, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  }

  it("kills a shell that ignores SIGTERM at the limit, answers nothing, leaves no process, and never blocks the loop", async () => {
    const pidFile = join(root, "shell.pid");
    // A hung interactive zsh: SIGTERM is ignored, and an ignored signal stays ignored across exec.
    const shell = fakeShell("hung-zsh", `echo $$ > "${pidFile}"\ntrap '' TERM\nexec sleep 30`);
    const LIMIT_MS = 2_000;
    let turns = 0;
    const loop = setInterval(() => turns++, 50);
    const started = performance.now();
    const answer = await queryLoginShell(shell, LIMIT_MS);
    const elapsed = performance.now() - started;
    clearInterval(loop);

    expect(answer).toBeUndefined();
    expect(elapsed).toBeGreaterThanOrEqual(LIMIT_MS - 20);
    expect(elapsed).toBeLessThan(LIMIT_MS + 1_500);
    // A blocking spawnSync would leave no turn for the interval.
    expect(turns).toBeGreaterThan(10);
    const line = readFileSync(pidFile, "utf8");
    expect(line).toMatch(/^\d+\n$/);
    const pid = Number(line);
    expect(pid).toBeGreaterThan(1);
    expect(pid).not.toBe(process.pid);
    await vi.waitFor(() => expect(isAlive(pid)).toBe(false), { timeout: 5_000, interval: 50 });
  }, 15_000);

  it("at the limit, answers the path the shell printed before it hung", async () => {
    const fake = installFake("shell-bin");
    const pidFile = join(root, "shell.pid");
    const shell = fakeShell(
      "printed-then-hung-zsh",
      `echo $$ > "${pidFile}"\nPATH="${join(root, "shell-bin")}:/usr/bin:/bin" /bin/sh -c "$2"\ntrap '' TERM\nexec sleep 30`,
    );
    const LIMIT_MS = 2_000;
    const started = performance.now();
    expect(await queryLoginShell(shell, LIMIT_MS)).toBe(fake);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(LIMIT_MS - 20);
    expect(elapsed).toBeLessThan(LIMIT_MS + 1_500);
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(pid).toBeGreaterThan(1);
    expect(pid).not.toBe(process.pid);
    await vi.waitFor(() => expect(isAlive(pid)).toBe(false), { timeout: 5_000, interval: 50 });
  }, 15_000);

  it("answers by the limit when a child that a startup file started keeps stdout open", async () => {
    const fake = installFake("shell-bin");
    const childPidFile = join(root, "child.pid");
    // The shell answers and exits; its background child holds the stdout pipe for 30 s.
    const shell = fakeShell(
      "child-holds-stdout-zsh",
      `sleep 30 &\necho $! > "${childPidFile}"\nPATH="${join(root, "shell-bin")}:/usr/bin:/bin" exec /bin/sh -c "$2"`,
    );
    const LIMIT_MS = 2_000;
    let child = 0;
    try {
      const started = performance.now();
      expect(await queryLoginShell(shell, LIMIT_MS)).toBe(fake);
      expect(performance.now() - started).toBeLessThan(LIMIT_MS + 1_500);
      child = Number(readFileSync(childPidFile, "utf8"));
      expect(child).toBeGreaterThan(1);
      expect(child).not.toBe(process.pid);
    } finally {
      // The orphan is this test's own `sleep 30`: the fake shell wrote its pid.
      if (child > 1 && child !== process.pid && isAlive(child)) process.kill(child, "SIGKILL");
    }
    await vi.waitFor(() => expect(isAlive(child)).toBe(false), { timeout: 5_000, interval: 50 });
  }, 15_000);

  it("a spawn that throws, or fails without stdout (EMFILE), answers nothing and raises no error", async () => {
    const throws = () => {
      throw new Error("spawn E2BIG");
    };
    expect(await queryLoginShell("/bin/zsh", 5_000, throws)).toBeUndefined();
    // Node's shape for EMFILE and ENFILE: a child with no stdout, and an `error` event on the next tick.
    const noStdout = () => {
      const child = Object.assign(new EventEmitter(), { stdout: null, kill: () => false });
      process.nextTick(() => child.emit("error", Object.assign(new Error("spawn /bin/zsh EMFILE"), { code: "EMFILE" })));
      return child as never;
    };
    expect(await queryLoginShell("/bin/zsh", 5_000, noStdout)).toBeUndefined();
  });

  it("answers the path that `command -v claude` prints after the startup output", async () => {
    const fake = installFake("shell-bin");
    const shell = fakeShell("zsh", `echo "startup output"\nPATH="${join(root, "shell-bin")}:/usr/bin:/bin" exec /bin/sh -c "$2"`);
    expect(await queryLoginShell(shell, 5_000)).toBe(fake);
  });

  it("a shell that cannot start answers nothing", async () => {
    expect(await queryLoginShell(join(root, "no-such-shell"), 5_000)).toBeUndefined();
  });
});

describe("claudeChildEnv", () => {
  it("drops credentials, the nested-session markers and TIDEGAP_* variables, keeps the rest", () => {
    const env = claudeChildEnv({
      ANTHROPIC_API_KEY: "sk",
      ANTHROPIC_AUTH_TOKEN: "tok",
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      OPENAI_API_KEY: "sk-oa",
      GEMINI_API_KEY: "g",
      GOOGLE_API_KEY: "g2",
      WATTTIME_USERNAME: "u",
      WATTTIME_PASSWORD: "p",
      TIDEGAP_ELECTRICITY_MAPS_API_KEY: "em",
      TIDEGAP_CLAUDE_BIN: "/x/claude",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth",
      HOME: "/Users/me",
      PATH: "/usr/bin",
    });
    expect(env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "oauth", HOME: "/Users/me", PATH: "/usr/bin" });
  });

  it("drops the variables of a Claude Code session that started the tick, keeps CLAUDE_CONFIG_DIR (KTD15)", () => {
    const session = [
      "CLAUDE_CODE_SESSION_ID",
      "CLAUDE_PROJECT_DIR",
      "CLAUDE_PID",
      "CLAUDE_CODE_CHILD_SESSION",
      "CLAUDE_CODE_SESSION_ATTENDED",
      "CLAUDE_CODE_BRIDGE_SESSION_ID",
      "CLAUDE_CODE_MESSAGING_SOCKET",
      "CLAUDE_CODE_MESSAGING_TOKEN",
    ];
    const env = claudeChildEnv({
      ...Object.fromEntries(session.map((k) => [k, "x"])),
      CLAUDE_CONFIG_DIR: "/Users/me/.claude-alt",
      HOME: "/Users/me",
    });
    expect(env).toEqual({ CLAUDE_CONFIG_DIR: "/Users/me/.claude-alt", HOME: "/Users/me" });
  });
});

describe("claudeResumeMaxBudget", () => {
  it("defaults to 3 and names its own variable in the warning", () => {
    expect(claudeResumeMaxBudget(undefined)).toEqual({ usd: 3 });
    expect(claudeResumeMaxBudget("5")).toEqual({ usd: 5 });
    expect(claudeResumeMaxBudget("x").warning).toContain("TIDEGAP_CLAUDE_CODE_RESUME_MAX_BUDGET_USD");
  });
});

describe("claudeMaxBudget", () => {
  it("parses a positive number and falls back to 1 with a warning otherwise", () => {
    expect(claudeMaxBudget(undefined)).toEqual({ usd: 1 });
    expect(claudeMaxBudget("2.5")).toEqual({ usd: 2.5 });
    for (const bad of ["abc", "0", "-1"]) {
      const b = claudeMaxBudget(bad);
      expect(b.usd).toBe(1);
      expect(b.warning).toContain("TIDEGAP_CLAUDE_CODE_MAX_BUDGET_USD");
    }
  });
});

describe("claudeTools", () => {
  it("reads TIDEGAP_CLAUDE_TOOLS against the allowlist; an invalid value warns and keeps the default", () => {
    expect(claudeTools(undefined)).toEqual({ tools: ["WebSearch", "WebFetch"] });
    expect(claudeTools("")).toEqual({ tools: [] });
    expect(claudeTools(" Read , Grep ")).toEqual({ tools: ["Read", "Grep"] });
    const mixed = claudeTools("WebFetch,Read");
    expect(mixed.tools).toEqual(["WebSearch", "WebFetch"]);
    expect(mixed.warning).toContain("cannot combine a file tool");
    const bad = claudeTools("WebSearch,Bash");
    expect(bad.tools).toEqual(["WebSearch", "WebFetch"]);
    expect(bad.warning).toContain("TIDEGAP_CLAUDE_TOOLS");
    expect(bad.warning).toContain("Bash");
  });
});

describe("buildAdapters with Claude Code", () => {
  const claude = new ClaudeCodeAdapter({ binaryPath: FAKE });

  it("serves anthropic through Claude Code when there is no key", () => {
    const a = buildAdapters({}, claude);
    expect(a["claude-code"]).toBe(claude);
    expect(a.anthropic).toBe(claude);
    expect(a.openai).toBeUndefined();
  });

  it("keeps the API adapter for anthropic when the key is set", () => {
    const a = buildAdapters({ anthropicApiKey: "sk" }, claude);
    expect(a["claude-code"]).toBe(claude);
    expect(a.anthropic).toBeInstanceOf(AnthropicAdapter);
  });

  it("with no binary and no key, tick reports no adapters and mentions Claude Code", async () => {
    const keys = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "OLLAMA_HOST"];
    const saved = keys.map((k) => [k, process.env[k]] as const);
    for (const k of keys) delete process.env[k];
    try {
      const r = await runTickOnce({
        db: ":memory:",
        envFile: join(root, "no-env"),
        claudeLookup: lookup({ loginShell: async () => undefined }),
      });
      expect(r.exitCode).toBe(0);
      expect(r.message).toMatch(/no adapters configured/);
      expect(r.message).toContain("install Claude Code");
      expect(r.message).toContain("TIDEGAP_CLAUDE_BIN");
    } finally {
      for (const [k, v] of saved) if (v !== undefined) process.env[k] = v;
    }
  });
});
