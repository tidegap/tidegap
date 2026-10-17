/**
 * End to end: `runTickOnce` finds a fake `claude` on the injected PATH and
 * dispatches through it. Hermetic HOME (test setup), temp ledger, no network.
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TaskStore } from "@tidegap/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runQueueShow } from "../src/commands/queue.js";
import { runTickOnce, type TickCommandOptions } from "../src/commands/tick.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-claude");
const VARS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "OLLAMA_HOST",
  "TIDEGAP_CLAUDE_BIN",
  "TIDEGAP_CLAUDE_CODE",
  "TIDEGAP_CLAUDE_CODE_MAX_BUDGET_USD",
  "TIDEGAP_CLAUDE_TOOLS",
  "FAKE_CLAUDE_MODE",
  "FAKE_CLAUDE_LOG",
  "CLAUDECODE",
] as const;

let root: string;
let dbPath: string;
let log: string;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const k of VARS) {
    saved.set(k, process.env[k]);
    delete process.env[k];
  }
  root = realpathSync(mkdtempSync(join(tmpdir(), "tidegap-tick-cc-")));
  dbPath = join(root, "queue.db");
  log = join(root, "log");
  // The fake and its canned replies, as one directory on the injected PATH.
  cpSync(FIXTURE, join(root, "bin"), { recursive: true });
  // The adapter hands its child this process's environment (minus the API key).
  process.env.FAKE_CLAUDE_LOG = log;
});

afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  saved.clear();
  rmSync(root, { recursive: true, force: true });
});

function tickOpts(): TickCommandOptions {
  return {
    db: dbPath,
    envFile: join(root, "no-env"),
    notify: false,
    claudeLookup: {
      path: join(root, "bin"),
      home: join(root, "home"),
      platform: "linux",
      isExecutable: (p) => p.startsWith(root) && existsSync(p),
      loginShell: () => undefined,
    },
  };
}

function queue(taskId: string, provider: string, model: string, dueNow = true, extra: Record<string, unknown> = {}): void {
  const store = new TaskStore({ dbPath });
  store.upsert({
    taskId,
    status: "scheduled",
    enqueuedAt: new Date(Date.now() - 60_000).toISOString(),
    scheduledFor: new Date(Date.now() + (dueNow ? -1_000 : 3_600_000)).toISOString(),
    region: "US-CAL-CISO",
    bodyJson: JSON.stringify({ type: "provider_call", provider, model, prompt: "Reply OK", ...extra }),
  });
  store.close();
}

function row(taskId: string) {
  const store = new TaskStore({ dbPath });
  try {
    return store.get(taskId);
  } finally {
    store.close();
  }
}

const argv = (): string[] => readFileSync(join(log, "argv"), "utf8").split("\n").slice(0, -1);

describe("tidegap tick with Claude Code", () => {
  it("completes a claude-code task with a claude-code receipt", async () => {
    queue("t-cc", "claude-code", "default");
    const r = await runTickOnce(tickOpts());
    expect(r.message).toContain("1 dispatched, 0 failed");
    expect(r.exitCode).toBe(0);
    const rec = row("t-cc");
    expect(rec?.status).toBe("completed");
    expect(rec?.receipt?.provider).toBe("claude-code");
    expect(rec?.receipt?.model).toBe("claude-haiku-5-5");
    expect(rec?.receipt?.totalTokens).toBe(2056);
    expect(argv()).not.toContain("--model");
  });

  it("records the default web tool set on the receipt, and queue show prints it", async () => {
    queue("t-web", "claude-code", "default");
    await runTickOnce(tickOpts());
    const args = argv();
    expect(args[args.indexOf("--tools") + 1]).toBe("WebSearch,WebFetch");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("WebSearch,WebFetch");
    expect(row("t-web")?.receipt?.tools).toEqual(["WebSearch", "WebFetch"]);
    const { rendered } = await runQueueShow("t-web", { db: dbPath, markRead: false });
    expect(rendered).toContain("tools: WebSearch, WebFetch");
  });

  it("a task's own tools win over the default; [] shows as none", async () => {
    queue("t-none", "claude-code", "default", true, { tools: [] });
    await runTickOnce(tickOpts());
    expect(argv()).not.toContain("--allowedTools");
    expect(row("t-none")?.receipt?.tools).toEqual([]);
    const { rendered } = await runQueueShow("t-none", { db: dbPath, markRead: false });
    expect(rendered).toContain("tools: none");
  });

  it("TIDEGAP_CLAUDE_TOOLS replaces the default tool set", async () => {
    process.env.TIDEGAP_CLAUDE_TOOLS = "";
    queue("t-env-none", "claude-code", "default");
    await runTickOnce(tickOpts());
    const args = argv();
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args).not.toContain("--allowedTools");
    expect(row("t-env-none")?.receipt?.tools).toEqual([]);
  });

  it("warns about an invalid TIDEGAP_CLAUDE_TOOLS and keeps the default", async () => {
    process.env.TIDEGAP_CLAUDE_TOOLS = "Bash";
    queue("t-env-bad", "claude-code", "default");
    const r = await runTickOnce(tickOpts());
    expect(r.message).toContain("TIDEGAP_CLAUDE_TOOLS");
    const args = argv();
    expect(args[args.indexOf("--tools") + 1]).toBe("WebSearch,WebFetch");
  });

  it("hands the child no API key and no nested-session marker", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.OPENAI_API_KEY = "sk-oa-test";
    process.env.CLAUDECODE = "1";
    queue("t-env", "claude-code", "default");
    const r = await runTickOnce(tickOpts());
    expect(r.message).toContain("1 dispatched");
    const env = readFileSync(join(log, "env"), "utf8");
    expect(env).toContain(`FAKE_CLAUDE_LOG=${log}`);
    expect(env).not.toMatch(/^(ANTHROPIC_API_KEY|OPENAI_API_KEY|CLAUDECODE)=/m);
  });

  it("names TIDEGAP_CLAUDE_BIN when a claude-code task is pending and claude is not found", async () => {
    process.env.OPENAI_API_KEY = "sk-oa-test";
    queue("t-nobin", "claude-code", "default", false);
    const opts = tickOpts();
    const r = await runTickOnce({ ...opts, claudeLookup: { ...opts.claudeLookup, path: join(root, "empty") } });
    expect(r.message).toContain("TIDEGAP_CLAUDE_BIN");
  });

  it("runs an anthropic task through Claude Code when there is no key", async () => {
    queue("t-an", "anthropic", "claude-sonnet-5");
    const r = await runTickOnce(tickOpts());
    expect(r.message).toContain("1 dispatched");
    expect(row("t-an")?.status).toBe("completed");
    expect(row("t-an")?.receipt?.provider).toBe("claude-code");
    const args = argv();
    expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual(["--model", "claude-sonnet-5"]);
  });

  it("fails a logged-out run once and does not re-dispatch it", async () => {
    process.env.FAKE_CLAUDE_MODE = "logged-out";
    queue("t-out", "claude-code", "haiku");
    const r = await runTickOnce(tickOpts());
    expect(r.exitCode).toBe(1);
    expect(r.message).toContain("0 dispatched, 1 failed");
    expect(row("t-out")?.status).toBe("failed");
    expect(row("t-out")?.error).toContain("Not logged in");

    rmSync(log, { recursive: true, force: true });
    const again = await runTickOnce(tickOpts());
    expect(again.message).toContain("0 dispatched, 0 failed");
    expect(existsSync(log)).toBe(false);
  });

  it("defers a usage-limit result to the reset and does not re-dispatch it before then", async () => {
    process.env.FAKE_CLAUDE_MODE = "limit";
    queue("t-lim", "claude-code", "default");
    const res = await runTickOnce({ ...tickOpts(), usage: { cachePath: join(root, "usage.json"), configPath: join(root, "cfg"), env: {} } });
    expect(res.exitCode).toBe(0);
    expect(res.message).toMatch(/0 failed, 1 deferred until /);
    const store = new TaskStore({ dbPath });
    const row = store.get("t-lim")!;
    store.close();
    expect(row.status).toBe("scheduled");
    expect(row.error).toBeUndefined();
    expect(Date.parse(row.notBefore!)).toBeGreaterThan(Date.now());
    rmSync(join(log, "argv"));
    const again = await runTickOnce(tickOpts());
    expect(again.message).toMatch(/^tick: 0 inspected/);
    expect(existsSync(join(log, "argv"))).toBe(false);
  });

  it("fails a keyless openai task and still names its key", async () => {
    queue("t-oa", "openai", "gpt-6-sol");
    const r = await runTickOnce(tickOpts());
    expect(row("t-oa")?.status).toBe("failed");
    expect(row("t-oa")?.error).toContain("no adapter configured");
    expect(r.message).toContain("OPENAI_API_KEY");
  });

  it("does not warn about ANTHROPIC_API_KEY when Claude Code serves anthropic", async () => {
    queue("t-later", "anthropic", "claude-sonnet-5", false);
    const r = await runTickOnce(tickOpts());
    expect(r.message).not.toContain("ANTHROPIC_API_KEY");
    expect(r.message).not.toMatch(/no adapters configured/);
  });

  it("warns about an invalid budget cap and uses 1", async () => {
    process.env.TIDEGAP_CLAUDE_CODE_MAX_BUDGET_USD = "lots";
    queue("t-b", "claude-code", "default");
    const r = await runTickOnce(tickOpts());
    expect(r.message).toContain("TIDEGAP_CLAUDE_CODE_MAX_BUDGET_USD");
    const args = argv();
    expect(args[args.indexOf("--max-budget-usd") + 1]).toBe("1");
  });
});
