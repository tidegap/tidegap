/**
 * The `command` adapter and the shell step (jobs U6): process-group kill,
 * caps, failure text, the minimal environment, secrets in and scrubbed
 * out, and the tool-less summarize step. Real `/bin/sh` children, temp
 * directories under the hermetic home; no network.
 */

import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AnthropicAdapter,
  DEFAULT_JOB_CAPS,
  NonRetryableError,
  ProviderDeferError,
  type DispatchOptions,
  type DispatchResult,
  type ProviderAdapter,
  type RunDetails,
} from "@tidegap/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CommandAdapter, durationLabel, summarizeInput, type CommandAdapterOptions } from "../src/providers/command.js";
import { runShell } from "../src/jobs/run-shell.js";

const JOB = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-job", "job.sh");
const SECRET = "imap-fixture-Q7f3kLm9";
// Key-shaped values are built at run time: no key-shaped literal in the repo.
const OPENAI_FAKE = ["sk", "proj", "fixture".repeat(4)].join("-");
const GEMINI_FAKE = ["AI", "za", "Fixture".repeat(5)].join("");

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "tidegap-jobs-runner-")));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Poll every 50 ms, up to `ms`, until `pid` is gone. */
async function goneWithin(pid: number, ms: number): Promise<boolean> {
  for (let i = 0; i < ms / 50; i++) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !isAlive(pid);
}

const goneWithin5s = (pid: number) => goneWithin(pid, 5_000);

function readPid(path: string): number {
  return Number(readFileSync(path, "utf8").trim());
}

/** A summarize adapter fake: records calls, answers with `answer`. */
function fakeLlm(answer: (prompt: string, options: DispatchOptions) => Promise<DispatchResult> | DispatchResult) {
  const calls: Array<{ model: string; prompt: string; options: DispatchOptions }> = [];
  const adapter: ProviderAdapter = {
    provider: "anthropic",
    ready: true,
    async dispatch(model, prompt, options = {}) {
      calls.push({ model, prompt, options });
      return answer(prompt, options);
    },
  };
  return { adapter, calls };
}

function adapter(extra: Partial<CommandAdapterOptions> = {}, secrets: Record<string, string> = {}): CommandAdapter {
  return new CommandAdapter({
    adapters: {},
    jobRunner: (id) => (id === "job-cmd" ? "command" : id === "job-prompt" ? "prompt" : undefined),
    readSecrets: (names) => ({
      values: Object.fromEntries(names.filter((n) => n in secrets).map((n) => [n, secrets[n]!])),
      missing: names.filter((n) => !(n in secrets)),
    }),
    env: { PATH: "/usr/bin:/bin", HOME: root },
    home: root,
    ...extra,
  });
}

function opts(run: string, extra: Partial<DispatchOptions> = {}, caps: Partial<typeof DEFAULT_JOB_CAPS> = {}): DispatchOptions {
  return { jobId: "job-cmd", command: { run, cwd: root, secrets: [] }, caps: { ...DEFAULT_JOB_CAPS, ...caps }, ...extra };
}

async function failure(p: Promise<unknown>): Promise<{ message: string; details?: RunDetails; err: unknown }> {
  try {
    await p;
  } catch (err) {
    return { message: (err as Error).message, details: (err as NonRetryableError).details, err };
  }
  throw new Error("expected a failure");
}

describe("runShell and the command time limit", () => {
  it("a timeout stops the shell and its background child (SIGTERM to the group)", async () => {
    const shellPid = join(root, "shell.pid");
    const bgPid = join(root, "bg.pid");
    const f = await failure(
      // linux: the fixture may live under ~/Documents, which adds the macOS hint.
      adapter({ platform: "linux" }).dispatch("none", "", opts(`${JOB} --pid ${shellPid} --bg ${bgPid} --sleep 30`, {}, { commandTimeoutMs: 2_000 })),
    );
    expect(f.message).toBe("stopped: command time limit 0 min 2 s");
    expect(f.details).toEqual({ steps: ["command"], stopped_by: "command_timeout" });
    expect(f.err).toBeInstanceOf(NonRetryableError);
    const shell = readPid(shellPid);
    const bg = readPid(bgPid);
    expect(shell).toBeGreaterThan(1);
    expect(bg).toBeGreaterThan(1);
    expect(await goneWithin5s(shell)).toBe(true);
    expect(await goneWithin5s(bg)).toBe(true);
  }, 15_000);

  it("a child that ignores SIGTERM gets SIGKILL after the grace", async () => {
    const pidFile = join(root, "stubborn.pid");
    const r = await runShell({
      command: `trap '' TERM; echo $$ > ${pidFile}; while :; do sleep 1; done`,
      cwd: root,
      env: { PATH: "/usr/bin:/bin" },
      timeoutMs: 2_000,
      outputCapBytes: 1024,
      killGraceMs: 500,
    });
    expect(r.timedOut).toBe(true);
    const pid = readPid(pidFile);
    expect(pid).toBeGreaterThan(1);
    expect(await goneWithin5s(pid)).toBe(true);
  }, 15_000);

  it("a timed out run resolves only after the SIGKILL: a group member that ignores SIGTERM is gone", async () => {
    // The shell exits on SIGTERM at once; its background member ignores it. A
    // one-shot tick exits right after the run resolves, so the SIGKILL must
    // be sent by then: with a 3 s grace the member is gone within 1 s.
    const pidFile = join(root, "member.pid");
    const r = await runShell({
      command: `sh -c 'trap "" TERM; echo $$ > ${pidFile}; while :; do sleep 1; done' & wait`,
      cwd: root,
      env: { PATH: "/usr/bin:/bin" },
      timeoutMs: 2_000,
      outputCapBytes: 1024,
      killGraceMs: 3_000,
    });
    expect(r.timedOut).toBe(true);
    const pid = readPid(pidFile);
    expect(pid).toBeGreaterThan(1);
    expect(await goneWithin(pid, 1_000)).toBe(true);
  }, 15_000);

  it("a background child does not hold the run open after the shell exits", async () => {
    const started = Date.now();
    const r = await runShell({ command: `${JOB} --bg ${join(root, "bg.pid")} --bytes 3`, cwd: root, env: { PATH: "/usr/bin:/bin" }, timeoutMs: 20_000, outputCapBytes: 1024 });
    const bg = readPid(join(root, "bg.pid"));
    if (bg > 1) process.kill(bg, "SIGKILL");
    expect(r).toMatchObject({ code: 0, stdout: "xxx", timedOut: false, truncated: false });
    expect(bg).toBeGreaterThan(1);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 15_000);

  it("durationLabel reads minutes and seconds", () => {
    expect(durationLabel(2_000)).toBe("0 min 2 s");
    expect(durationLabel(300_000)).toBe("5 min");
    expect(durationLabel(90_000)).toBe("1 min 30 s");
  });
});

describe("command adapter", () => {
  it("happy path: echo ok -> result ok, provider command, zero tokens", async () => {
    const r = await adapter().dispatch("none", "", opts("echo ok"));
    expect(r).toMatchObject({
      text: "ok",
      provider: "command",
      model: "none",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      details: { steps: ["command"] },
    });
  });

  it("output over the cap is cut and noted; the run is not stopped for it", async () => {
    const r = await adapter().dispatch("none", "", opts(`${JOB} --bytes ${11 * 1024 * 1024}`));
    expect(r.text.length).toBe(10 * 1024 * 1024);
    expect(r.details).toEqual({ steps: ["command"], truncated: true });
  }, 20_000);

  it("exit 127 adds the PATH hint", async () => {
    const f = await failure(adapter().dispatch("none", "", opts("no-such-command-tidegap-xyz")));
    expect(f.message).toMatch(/^command exited with code 127 \(command not found under the daemon's PATH; use an absolute path\); stderr: /);
  });

  it("a missing secret fails before the command starts and names the CLI command", async () => {
    const pidFile = join(root, "ran.pid");
    const f = await failure(adapter().dispatch("none", "", opts(`${JOB} --pid ${pidFile}`, { command: { run: `${JOB} --pid ${pidFile}`, cwd: root, secrets: ["IMAP_PASSWORD"] } })));
    expect(f.message).toBe("secret IMAP_PASSWORD is not set; run: tidegap jobs secrets set IMAP_PASSWORD");
    expect(existsSync(pidFile)).toBe(false);
  });

  it("a missing working directory fails with the path", async () => {
    const missing = join(root, "gone");
    const f = await failure(adapter().dispatch("none", "", opts("echo hi", { command: { run: "echo hi", cwd: missing, secrets: [] } })));
    expect(f.message).toBe(`command: working directory ${missing} does not exist`);
  });

  it("refuses a row without a job and a row of a prompt job", async () => {
    expect((await failure(adapter().dispatch("none", "", { ...opts("echo hi"), jobId: undefined }))).message).toMatch(/not a run of a job/);
    expect((await failure(adapter().dispatch("none", "", { ...opts("echo hi"), jobId: "job-prompt" }))).message).toMatch(/not a command job/);
  });

  it("the command sees only the allowlist plus its secrets: no provider key from the env file", async () => {
    const env = { PATH: "/usr/bin:/bin", HOME: root, LANG: "C", LC_ALL: "C", OPENAI_API_KEY: OPENAI_FAKE, GEMINI_API_KEY: GEMINI_FAKE, TIDEGAP_DEFAULT_REGION: "DE" };
    const r = await adapter({ env }).dispatch("none", "", opts("env"));
    expect(r.text).not.toMatch(/OPENAI_API_KEY|GEMINI_API_KEY|TIDEGAP_/);
    expect(r.text).toContain("LC_ALL=C");
    expect(r.text).toContain(`HOME=${root}`);
  });

  it("covers AE7: the child sees the secret; the output shows [redacted]", async () => {
    const r = await adapter({}, { IMAP_PASSWORD: SECRET }).dispatch(
      "none",
      "",
      opts("x", { command: { run: `${JOB} --env IMAP_PASSWORD`, cwd: root, secrets: ["IMAP_PASSWORD"] } }),
    );
    expect(r.text).toBe("IMAP_PASSWORD=[redacted]");
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it("a secret printed to stderr before exit 1 is scrubbed from the error", async () => {
    const f = await failure(
      adapter({}, { IMAP_PASSWORD: SECRET }).dispatch(
        "none",
        "",
        opts("x", { command: { run: `${JOB} --stderr "login failed for $IMAP_PASSWORD" --exit 1`, cwd: root, secrets: ["IMAP_PASSWORD"] } }),
      ),
    );
    expect(f.message).toBe("command exited with code 1; stderr: login failed for [redacted]");
    expect(f.message).not.toContain(SECRET);
  });

  it("a secret cut by the output cap leaves no fragment in the result", async () => {
    const head = "IMAP_PASSWORD=".length;
    for (const kept of [1, 4, 8, SECRET.length - 1]) {
      const r = await adapter({}, { IMAP_PASSWORD: SECRET }).dispatch(
        "none",
        "",
        opts("x", { command: { run: `${JOB} --env IMAP_PASSWORD`, cwd: root, secrets: ["IMAP_PASSWORD"] } }, { outputCapBytes: head + kept }),
      );
      expect(r.text).toBe("IMAP_PASSWORD=[redacted]");
      expect(r.details).toEqual({ steps: ["command"], truncated: true });
    }
  });

  it("a secret cut by the stderr tail window leaves no fragment in the error", async () => {
    for (const kept of [1, 4, 8, SECRET.length - 1]) {
      const run = `printf '%s' "$IMAP_PASSWORD" >&2; head -c ${4096 - kept} /dev/zero | tr '\\0' y >&2; exit 1`;
      const f = await failure(
        adapter({}, { IMAP_PASSWORD: SECRET }).dispatch("none", "", opts("x", { command: { run, cwd: root, secrets: ["IMAP_PASSWORD"] } })),
      );
      expect(f.message).toMatch(/^command exited with code 1; stderr: \[redacted\]y+$/);
      if (kept >= 4) expect(f.message).not.toContain(SECRET.slice(-kept));
    }
  });

  it("a vendor key shape in the output is redacted too", async () => {
    const r = await adapter().dispatch("none", "", opts(`echo ${OPENAI_FAKE}`));
    expect(r.text).toBe("[REDACTED]");
  });

  it("a silent timeout on macOS under ~/Documents adds the Files & Folders hint", async () => {
    const f = await failure(adapter({ platform: "darwin" }).dispatch("none", "", opts("sleep 5 # ~/Documents/mail", {}, { commandTimeoutMs: 500 })));
    expect(f.message).toBe("stopped: command time limit 0 min 1 s (macOS: check for a pending Files & Folders prompt for the daemon's node)");
  }, 15_000);
});

describe("summarize step", () => {
  const summarize = { provider: "anthropic" as const, model: "claude-sonnet-5" };

  it("covers AE6 for API providers: zero tools, the caps as limits, the result is the answer", async () => {
    const llm = fakeLlm(() => ({ text: "all fine", model: "claude-sonnet-5", provider: "anthropic", raw: null, usage: { inputTokens: 10, outputTokens: 2 } }));
    const r = await adapter({ adapters: { anthropic: llm.adapter } }).dispatch("claude-sonnet-5", "anything odd?", opts("echo disk 42%", { summarize }));
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]!.options).toEqual({ tools: [], timeoutMs: DEFAULT_JOB_CAPS.llmTimeoutMs, maxBudgetUsd: DEFAULT_JOB_CAPS.maxBudgetUsd });
    expect(llm.calls[0]!.prompt).toBe("anything odd?\n\nCommand output:\n```\ndisk 42%\n\n```");
    expect(r).toMatchObject({ text: "all fine", provider: "anthropic", tools: [], details: { steps: ["command", "prompt"] } });
  });

  it("the summarize prompt gets the scrubbed output, never the secret", async () => {
    const llm = fakeLlm(() => ({ text: "ok", model: "m", provider: "anthropic", raw: null }));
    await adapter({ adapters: { anthropic: llm.adapter } }, { IMAP_PASSWORD: SECRET }).dispatch(
      "m",
      "p",
      opts("x", { summarize, command: { run: `${JOB} --env IMAP_PASSWORD`, cwd: root, secrets: ["IMAP_PASSWORD"] } }),
    );
    expect(llm.calls[0]!.prompt).toContain("IMAP_PASSWORD=[redacted]");
    expect(llm.calls[0]!.prompt).not.toContain(SECRET);
  });

  it("a retryable summarize error is retried inside the adapter; the command runs once", async () => {
    let n = 0;
    const llm = fakeLlm(() => {
      n += 1;
      if (n === 1) throw Object.assign(new Error("overloaded"), { status: 503 });
      return { text: "second try", model: "m", provider: "anthropic", raw: null };
    });
    const counter = join(root, "runs");
    const r = await adapter({ adapters: { anthropic: llm.adapter } }).dispatch("m", "p", opts(`echo run >> ${counter}; echo out`, { summarize }));
    expect(r.text).toBe("second try");
    expect(llm.calls).toHaveLength(2);
    expect(readFileSync(counter, "utf8")).toBe("run\n");
  }, 15_000);

  it("1 MB of output: the summarize prompt carries the last 200 KB and a truncation line", async () => {
    const llm = fakeLlm(() => ({ text: "ok", model: "m", provider: "anthropic", raw: null }));
    await adapter({ adapters: { anthropic: llm.adapter } }).dispatch("m", "p", opts(`${JOB} --bytes ${1024 * 1024}`, { summarize }));
    const prompt = llm.calls[0]!.prompt;
    expect(prompt).toContain("[command output truncated: the last 200 KB of 1024 KB follow]");
    expect((prompt.match(/x/g) ?? []).length).toBe(200 * 1024);
  });

  it("a fence longer than any backtick run in the output", () => {
    expect(summarizeInput("p", "a ```` b", 1024)).toBe("p\n\nCommand output:\n`````\na ```` b\n`````");
  });

  it("an unconfigured summarize provider fails before the command runs", async () => {
    const pidFile = join(root, "ran.pid");
    const f = await failure(adapter().dispatch("m", "p", opts(`${JOB} --pid ${pidFile}`, { summarize })));
    expect(f.message).toBe("summarize provider anthropic is not configured");
    expect(f.details).toBeUndefined();
    expect(existsSync(pidFile)).toBe(false);
  });

  it("an API summarize whose input is over budget fails before sending, stopped_by budget", async () => {
    const sent: unknown[] = [];
    const client = { messages: { create: async (p: unknown) => (sent.push(p), {}) } };
    const anthropic = new AnthropicAdapter({ client });
    const f = await failure(
      adapter({ adapters: { anthropic } }).dispatch("claude-sonnet-5", "p", opts(`${JOB} --bytes ${150 * 1024}`, { summarize }, { maxBudgetUsd: 0.01 })),
    );
    expect(f.err).toBeInstanceOf(NonRetryableError);
    expect(f.message).toMatch(/^summarize: stopped: budget 0.01 USD is below the input cost/);
    expect(f.details).toEqual({ steps: ["command", "prompt"], stopped_by: "budget" });
    expect(sent).toHaveLength(0);
  });

  it("a summarize timeout is recorded as stopped_by llm_timeout", async () => {
    const llm = fakeLlm(() => {
      throw new Error("claude-code: timed out after 600s; cwd /tmp; no stderr");
    });
    const f = await failure(adapter({ adapters: { anthropic: llm.adapter } }).dispatch("m", "p", opts("echo hi", { summarize })));
    expect(f.details).toEqual({ steps: ["command", "prompt"], stopped_by: "llm_timeout" });
  });

  it("a usage-limit deferral propagates as is, so the occurrence goes back to the queue", async () => {
    const retryAt = new Date(Date.now() + 3_600_000);
    const llm = fakeLlm(() => {
      throw new ProviderDeferError("usage limit", retryAt);
    });
    const f = await failure(adapter({ adapters: { anthropic: llm.adapter } }).dispatch("m", "p", opts("echo hi", { summarize })));
    expect(f.err).toBeInstanceOf(ProviderDeferError);
  });
});
