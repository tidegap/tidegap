import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AnthropicAdapter } from "@tidegap/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claudeChildEnv,
  claudeMaxBudget,
  claudeTools,
  findClaudeBinary,
  isExecutableFile,
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
  it("prefers TIDEGAP_CLAUDE_BIN over a PATH hit", () => {
    installFake("bin");
    expect(
      findClaudeBinary({ ...on, claudeBin: "/explicit/claude" }, noPending, lookup({ path: join(root, "bin") })),
    ).toBe("/explicit/claude");
  });

  it("finds claude on PATH", () => {
    const fake = installFake("bin");
    expect(findClaudeBinary(on, noPending, lookup({ path: `${join(root, "empty")}:${join(root, "bin")}` }))).toBe(fake);
  });

  it("finds ~/.local/bin/claude with an empty PATH", () => {
    const fake = installFake("home/.local/bin");
    expect(findClaudeBinary(on, noPending, lookup())).toBe(fake);
  });

  it("asks the login shell on macOS only, and only when a pending task needs claude", () => {
    const fake = installFake("shell-only");
    const loginShell = vi.fn(() => fake);
    expect(findClaudeBinary(on, () => true, lookup({ platform: "darwin", loginShell }))).toBe(fake);
    expect(loginShell).toHaveBeenCalledTimes(1);

    loginShell.mockClear();
    expect(findClaudeBinary(on, () => true, lookup({ platform: "linux", loginShell }))).toBeUndefined();
    expect(findClaudeBinary(on, noPending, lookup({ platform: "darwin", loginShell }))).toBeUndefined();
    expect(loginShell).not.toHaveBeenCalled();
  });

  it("ignores a login-shell answer that is not an absolute executable path", () => {
    const loginShell = () => "alias claude=foo";
    expect(findClaudeBinary(on, () => true, lookup({ platform: "darwin", loginShell }))).toBeUndefined();
  });

  it("TIDEGAP_CLAUDE_CODE=off turns the lookup off", () => {
    installFake("bin");
    const saved = process.env.TIDEGAP_CLAUDE_CODE;
    process.env.TIDEGAP_CLAUDE_CODE = "off";
    try {
      const env = readEnvCredentials(() => {});
      expect(env.claudeCodeDisabled).toBe(true);
      expect(findClaudeBinary(env, noPending, lookup({ path: join(root, "bin") }))).toBeUndefined();
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

  it("finds nothing under the test runner without injected lookup inputs", () => {
    expect(findClaudeBinary({ ...on, claudeBin: "/explicit/claude" }, () => true)).toBeUndefined();
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
        claudeLookup: lookup({ loginShell: () => undefined }),
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
