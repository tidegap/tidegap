/**
 * The `command` adapter and the shell step (jobs U6): process-group kill,
 * caps, failure text, the minimal environment, secrets in and scrubbed
 * out, and the tool-less summarize step. Real `/bin/sh` children, temp
 * directories under the hermetic home; no network.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CommandAdapter, durationLabel, summarizeInput, type CommandAdapterOptions } from "../src/providers/command.js";
import { runShell } from "../src/jobs/run-shell.js";

// `spawn` passes through; each call records how many SIGTERM listeners the
// process had at that moment (the runner must listen before its shell runs).
const spawnSeen = vi.hoisted(() => ({ sigtermListeners: [] as number[] }));
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  return {
    ...real,
    spawn: ((...args: Parameters<typeof real.spawn>) => {
      spawnSeen.sigtermListeners.push(process.listenerCount("SIGTERM"));
      return real.spawn(...args);
    }) as typeof real.spawn,
  };
});

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

/**
 * Poll every 50 ms, up to `ms`, until `pid` is gone. `kill(pid, 0)` also
 * succeeds on a dead process that its parent (the runner, or init for an
 * orphan) has not reaped yet, and no event reports the reap. 5 s is far above
 * that and above the grace periods used here, so a miss means the process was
 * never killed.
 */
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

  it("a time limit above the setTimeout maximum does not fire at once", async () => {
    const r = await runShell({ command: "sleep 0.2; echo ok", cwd: root, env: { PATH: "/usr/bin:/bin" }, timeoutMs: 2 ** 31, outputCapBytes: 1024 });
    expect(r).toMatchObject({ code: 0, stdout: "ok\n", timedOut: false });
  });

  it("a background child does not hold the run open after the shell exits", async () => {
    const started = Date.now();
    const r = await runShell({ command: `${JOB} --bg ${join(root, "bg.pid")} --bytes 3`, cwd: root, env: { PATH: "/usr/bin:/bin" }, timeoutMs: 20_000, outputCapBytes: 1024 });
    const bg = readPid(join(root, "bg.pid"));
    if (bg > 1) process.kill(bg, "SIGKILL");
    expect(r).toMatchObject({ code: 0, stdout: "xxx", timedOut: false, truncated: false });
    expect(bg).toBeGreaterThan(1);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 15_000);

  describe("the command group dies with the tick (KTD11)", () => {
    // A child node process stands in for the tick: it starts a run, then is
    // stopped or exits while the run is live. It loads the built module.

    // A settled run's listeners come off two loop turns later: no test starts while they are on.
    afterEach(async () => {
      for (let i = 0; i < 2; i++) await new Promise((r) => setImmediate(r));
    });
    const RUN_SHELL = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "jobs", "run-shell.js")).href;

    /**
     * The tick child: a fixed script that gets its inputs as arguments. It runs
     * `commands` in turn, as a tick runs due jobs. `listen` adds its own
     * SIGTERM listener, as the daemon does. After the runs: `wait` keeps it
     * alive, `finish` exits 1 (the CLI's exit when a task failed), and `exit`
     * exits 0 as soon as `pidFile` exists, while the run is still live. Each
     * settled run adds a line to `runs.log`.
     */
    const TICK = [
      `import { appendFileSync, existsSync } from "node:fs";`,
      `const [moduleUrl, cfgJson] = process.argv.slice(2);`,
      `const { runShell } = await import(moduleUrl);`,
      `const { commands, cwd, pidFile, after, listen, runsLog } = JSON.parse(cfgJson);`,
      `if (listen) process.on("SIGTERM", () => {});`,
      `setInterval(() => { if (after === "exit" && existsSync(pidFile)) process.exit(0); }, 50);`,
      `for (const command of commands) {`,
      `  await runShell({ command, cwd, env: { PATH: "/usr/bin:/bin" }, timeoutMs: 60000, outputCapBytes: 1024, killGraceMs: 500 });`,
      `  appendFileSync(runsLog, "settled\\n");`,
      `}`,
      `if (after === "finish") process.exit(1);`,
    ].join("\n");

    /** Starts the tick child; resolves with it once the first command wrote `pidFile`. */
    async function startTick(commands: string[], pidFile: string, after: "wait" | "exit" | "finish", listen = false) {
      const script = join(root, "tick.mjs");
      writeFileSync(script, TICK);
      const cfg = JSON.stringify({ commands, cwd: root, pidFile, after, listen, runsLog: join(root, "runs.log") });
      const child = spawn(process.execPath, [script, RUN_SHELL, cfg], { stdio: "ignore" });
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
        child.on("exit", (code, signal) => resolve({ code, signal })),
      );
      for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 50));
      return { child, exited };
    }

    it.each(["SIGTERM", "SIGINT"] as const)("%s to the tick stops the command group, and the tick exits with the signal", async (signal) => {
      const shellPid = join(root, "shell.pid");
      const bgPid = join(root, "bg.pid");
      const { child, exited } = await startTick([`sleep 30 & echo $! > ${bgPid}; echo $$ > ${shellPid}; wait`], shellPid, "wait");
      try {
        const shell = readPid(shellPid);
        const bg = readPid(bgPid);
        expect(shell).toBeGreaterThan(1);
        expect(bg).toBeGreaterThan(1);
        child.kill(signal);
        expect(await exited).toEqual({ code: null, signal });
        expect(await goneWithin5s(shell)).toBe(true);
        expect(await goneWithin5s(bg)).toBe(true);
      } finally {
        child.kill("SIGKILL");
      }
    }, 15_000);

    it("a tick that would go on after the stop exits with the signal before it starts the next command", async () => {
      const first = join(root, "first.pid");
      const next = join(root, "next.pid");
      const { child, exited } = await startTick([`echo $$ > ${first}; sleep 30`, `echo $$ > ${next}; sleep 30`], first, "finish");
      try {
        expect(readPid(first)).toBeGreaterThan(1);
        child.kill("SIGTERM");
        // Not the exit code 1 of a tick that went on to the end.
        expect(await exited).toEqual({ code: null, signal: "SIGTERM" });
        expect(await goneWithin5s(readPid(first))).toBe(true);
        expect(existsSync(next)).toBe(false);
      } finally {
        child.kill("SIGKILL");
      }
    }, 15_000);

    it("with another listener the tick lives on: SIGKILL after the grace for a command that traps SIGTERM, and a command that starts later is stopped too", async () => {
      const first = join(root, "first.pid");
      const runsLog = join(root, "runs.log");
      const settled = () => (existsSync(runsLog) ? readFileSync(runsLog, "utf8").split("\n").filter(Boolean).length : 0);
      const { child, exited } = await startTick(
        [`trap '' TERM; echo $$ > ${first}; while :; do sleep 1; done`, "sleep 30"],
        first,
        "wait",
        true,
      );
      try {
        const stubborn = readPid(first);
        expect(stubborn).toBeGreaterThan(1);
        child.kill("SIGTERM");
        expect(await goneWithin5s(stubborn)).toBe(true);
        // The second command would run 30 s; it settles only because it was stopped.
        for (let i = 0; i < 100 && settled() < 2; i++) await new Promise((r) => setTimeout(r, 50));
        expect(settled()).toBe(2);
        expect(child.exitCode).toBeNull();
        expect(child.signalCode).toBeNull();
      } finally {
        child.kill("SIGKILL");
        await exited;
      }
    }, 15_000);

    it("a tick that exits while a command that traps SIGTERM runs leaves no group behind (SIGKILL on exit)", async () => {
      const pidFile = join(root, "stubborn.pid");
      const { child, exited } = await startTick([`trap '' TERM; echo $$ > ${pidFile}; while :; do sleep 1; done`], pidFile, "exit");
      try {
        expect(await exited).toEqual({ code: 0, signal: null });
        const pid = readPid(pidFile);
        expect(pid).toBeGreaterThan(1);
        expect(await goneWithin5s(pid)).toBe(true);
      } finally {
        child.kill("SIGKILL");
      }
    }, 15_000);

    it("the stop listeners are in before the shell is spawned (a signal right after the spawn cannot end the tick by default)", async () => {
      const before = process.listenerCount("SIGTERM");
      spawnSeen.sigtermListeners.length = 0;
      await runShell({ command: "true", cwd: root, env: { PATH: "/usr/bin:/bin" }, timeoutMs: 5_000, outputCapBytes: 1024 });
      expect(spawnSeen.sigtermListeners).toEqual([before + 1]);
    });

    it("a run that settled keeps its listeners two loop turns, then leaves none behind (a signal queued as it settles is not dropped)", async () => {
      const before = ["SIGTERM", "SIGINT", "exit"].map((e) => process.listenerCount(e));
      await runShell({ command: "true", cwd: root, env: { PATH: "/usr/bin:/bin" }, timeoutMs: 5_000, outputCapBytes: 1024 });
      expect(["SIGTERM", "SIGINT", "exit"].map((e) => process.listenerCount(e))).toEqual(before.map((n) => n + 1));
      for (let i = 0; i < 2; i++) await new Promise((r) => setImmediate(r));
      expect(["SIGTERM", "SIGINT", "exit"].map((e) => process.listenerCount(e))).toEqual(before);
    });

    it("a spawn that throws at once rejects and its listeners come off two loop turns later", async () => {
      const before = ["SIGTERM", "SIGINT", "exit"].map((e) => process.listenerCount(e));
      // Node refuses a NUL byte in an argument before it spawns, synchronously.
      const run = runShell({ command: "true\0", cwd: root, env: { PATH: "/usr/bin:/bin" }, timeoutMs: 5_000, outputCapBytes: 1024 });
      await expect(run).rejects.toMatchObject({ code: "ERR_INVALID_ARG_VALUE" });
      expect(process.listenerCount("SIGTERM")).toBe(before[0] + 1);
      for (let i = 0; i < 2; i++) await new Promise((r) => setImmediate(r));
      expect(["SIGTERM", "SIGINT", "exit"].map((e) => process.listenerCount(e))).toEqual(before);
    });

    it("a failed spawn rejects and its listeners come off two loop turns later (a signal during the spawn is not dropped)", async () => {
      const before = ["SIGTERM", "SIGINT", "exit"].map((e) => process.listenerCount(e));
      const run = runShell({ command: "true", cwd: join(root, "missing"), env: { PATH: "/usr/bin:/bin" }, timeoutMs: 5_000, outputCapBytes: 1024 });
      await expect(run).rejects.toMatchObject({ code: "ENOENT" });
      expect(process.listenerCount("SIGTERM")).toBe(before[0] + 1);
      for (let i = 0; i < 2; i++) await new Promise((r) => setImmediate(r));
      expect(["SIGTERM", "SIGINT", "exit"].map((e) => process.listenerCount(e))).toEqual(before);
    });
  });

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
      // The fragment and the y run are one token; the leading-token rule may drop it whole (KTD13).
      expect(f.message).toMatch(/^command exited with code 1; stderr: \[redacted\]y*$/);
      if (kept >= 4) expect(f.message).not.toContain(SECRET.slice(-kept));
    }
  });

  it("a command that fills the stdout cap and then fails still reports its stderr (KTD12)", async () => {
    const f = await failure(
      adapter().dispatch("none", "", opts(`${JOB} --bytes 5000 --stderr "fatal: auth" --exit 1`, {}, { outputCapBytes: 100 })),
    );
    expect(f.message).toBe("command exited with code 1; stderr: fatal: auth");
  });

  it("a vendor key cut by the output cap leaves no fragment in the result (KTD13)", async () => {
    // 16 bytes of the key: too short for its full pattern.
    const r = await adapter().dispatch("none", "", opts(`printf 'key=%s' ${OPENAI_FAKE}`, {}, { outputCapBytes: 4 + 16 }));
    expect(r.text).toBe("key=[redacted]");
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

  it("a summarize timeout is recorded as stopped_by llm_timeout, from the adapter's details", async () => {
    const llm = fakeLlm(() => {
      throw new NonRetryableError("anthropic: timed out after 600s", { stopped_by: "llm_timeout" });
    });
    const f = await failure(adapter({ adapters: { anthropic: llm.adapter } }).dispatch("m", "p", opts("echo hi", { summarize })));
    expect(f.details).toEqual({ steps: ["command", "prompt"], stopped_by: "llm_timeout" });
  });

  it("a model error whose text says timed out is not labeled llm_timeout", async () => {
    const llm = fakeLlm(() => {
      throw new Error("upstream request timed out");
    });
    const f = await failure(adapter({ adapters: { anthropic: llm.adapter } }).dispatch("m", "p", opts("echo hi", { summarize })));
    expect(f.message).toBe("summarize: upstream request timed out");
    expect(f.details).toEqual({ steps: ["command", "prompt"] });
  });

  it("an API summarize step honors llmTimeoutMs (KTD14)", async () => {
    const hang = () => new Promise<never>(() => {});
    const anthropic = new AnthropicAdapter({ apiKey: "test", client: { messages: { create: hang } } });
    const started = Date.now();
    const f = await failure(
      adapter({ adapters: { anthropic } }).dispatch("m", "p", opts("echo hi", { summarize }, { llmTimeoutMs: 100 })),
    );
    expect(Date.now() - started).toBeLessThan(5_000);
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
