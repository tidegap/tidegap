/**
 * `tidegap queue add`: one task for any runner, its deadline forms, the
 * options each runner takes, stdin, the session it is queued from, and its
 * text and JSON output.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { mockGridFeed, TaskStore } from "@tidegap/core";
import type { ProviderCallSpec, TaskRecord } from "@tidegap/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { QUEUE_ADD_JSON_KEYS, runQueueAdd, type QueueAddOptions } from "../src/commands/queue-add.js";
import { runQueueShow } from "../src/commands/queue.js";
import { defaultDbPath } from "../src/commands/tick.js";
import { UsageError, type SessionSources } from "../src/handoff/session.js";
import type { CapturedSession } from "../src/session/capture.js";

const SESSION = "5e55a0b1-2222-4333-8444-955566667777";
const OTHER = "0aaa0bbb-2222-4333-8444-955566667777";

let dir: string;
let db: string;
let work: string;

/** No session: no capture, no environment id. */
const outside: SessionSources = { claudePid: () => undefined, readCapture: () => undefined, envSessionId: () => undefined };
/** A session found through the plugin's capture file, started in `projectDir`. */
const inside = (projectDir: string): SessionSources => ({
  claudePid: () => 42,
  readCapture: (pid): CapturedSession | undefined => (pid === 42 ? { sessionId: SESSION, pid, projectDir } : undefined),
  envSessionId: () => undefined,
});

function add(text: string, opts: QueueAddOptions = {}) {
  return runQueueAdd(text, { db, feed: mockGridFeed(), region: "DE", workDir: work, sessionSources: outside, ...opts });
}

function row(taskId: string): TaskRecord<unknown> {
  const s = new TaskStore({ dbPath: db });
  try {
    return s.get(taskId)!;
  } finally {
    s.close();
  }
}

const body = (taskId: string) => JSON.parse(row(taskId).bodyJson!) as ProviderCallSpec;

async function usageError(p: Promise<unknown>): Promise<UsageError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(UsageError);
    return err as UsageError;
  }
  throw new Error("expected a usage error");
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "tidegap-queue-add-")));
  db = join(dir, "queue.db");
  work = join(dir, "work");
  mkdirSync(work);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("queue add", () => {
  it("covers AE1: queue add --runner command --cwd /tmp --by 10m prints a task id first and show prints runner command and cwd /tmp", async () => {
    const res = await add("echo hello > /tmp/tg-hello.txt", { runner: "command", cwd: "/tmp", by: "10m" });
    const lines = res.rendered.split("\n");
    expect(lines[0]).toMatch(/^t-[0-9a-f-]{36}$/);
    expect(lines[0]).toBe(res.record.taskId);
    expect(lines).toContain("status: scheduled");
    expect(lines).toContain("runner: command");
    // No flag: the task stores no limit and the setting or default applies when it runs.
    expect(lines).toContain("time limit: 30m (default)");
    const shown = (await runQueueShow(res.record.taskId, { db, markRead: false, config: join(dir, "none") })).rendered;
    expect(shown).toMatch(/^status: scheduled$/m);
    expect(shown).toMatch(/^runner: command$/m);
    expect(shown).toMatch(/^cwd: \/tmp$/m);
    expect(shown).toContain("Command:\necho hello > /tmp/tg-hello.txt");
    expect(shown).toMatch(/^time_limits: command 30m \(default\), if it ran now$/m);
    expect(body(res.record.taskId).caps).toEqual({ capsVersion: 2 });
  });

  it("covers AE4: --command-timeout 0 exits 2 naming none; none is stored as none; 8d exits 2", async () => {
    const zero = await usageError(add("make", { runner: "command", by: "2h", commandTimeout: "0" }));
    expect(zero.exitCode).toBe(2);
    expect(zero.message).toBe("queue add: --command-timeout: 0 is not a time limit; use none for no time limit.");
    const none = await add("make", { runner: "command", by: "2h", commandTimeout: "none" });
    expect(body(none.record.taskId).caps).toEqual({ commandTimeoutMs: "none", capsVersion: 2 });
    expect(none.rendered.split("\n")).toContain("time limit: none (task)");
    const long = await usageError(add("make", { runner: "command", by: "2h", commandTimeout: "8d" }));
    expect(long.message).toBe("queue add: --command-timeout: A time limit must be from 1s to 7d; use none for no time limit.");
  });

  it("--llm-timeout sets an LLM run's limit; it is refused on runner command", async () => {
    const res = await add("summarize", { runner: "anthropic", by: "2h", llmTimeout: "45m" });
    expect(body(res.record.taskId).caps).toEqual({ llmTimeoutMs: 2_700_000, capsVersion: 2 });
    expect(res.rendered.split("\n")).toContain("time limit: 45m (task)");
    const plain = await add("summarize", { runner: "anthropic", by: "2h" });
    expect(body(plain.record.taskId).caps).toBeUndefined();
    expect(plain.rendered.split("\n")).toContain("time limit: 10m (default)");
    const refused = await usageError(add("make", { runner: "command", by: "2h", llmTimeout: "1h" }));
    expect(refused.message).toBe("queue add: --llm-timeout applies to the LLM runners, not command; use --command-timeout");
  });

  it("--retries and --retry-delay store both; a command prints the retry line and how to run it once; bad values exit 2", async () => {
    const res = await add("make", { runner: "command", by: "6h", retries: "2", retryDelay: "10m" });
    expect(body(res.record.taskId).caps).toEqual({ retries: 2, retryDelayMs: 600_000, capsVersion: 2 });
    expect(res.rendered.split("\n")).toContain("retries: 2 after 10m, doubling (task); --retries 0 runs it once");
    const plain = await add("make", { runner: "command", by: "2h" });
    expect(plain.rendered.split("\n")).toContain("retries: 1 after 30m (default); --retries 0 runs it once");
    const once = await add("make", { runner: "command", by: "2h", retries: "0" });
    expect(once.rendered.split("\n")).toContain("retries: 0, no automatic retry (task; delay default)");
    const api = await add("summarize", { runner: "anthropic", by: "2h" });
    expect(api.rendered.split("\n")).toContain("retries: 1 after 30m (default)");
    const none = await usageError(add("make", { runner: "command", by: "2h", retries: "none" }));
    expect(none).toMatchObject({ exitCode: 2, message: "queue add: --retries: Retries must be a whole number from 0 to 10; 0 turns automatic retries off." });
    const zero = await usageError(add("make", { runner: "command", by: "2h", retryDelay: "0" }));
    expect(zero.message).toBe("queue add: --retry-delay: A retry delay must be a duration from 1s to 7d, such as 90s, 30m or 2h; 0 and none are refused.");
  });

  it("--llm-timeout on an API task that may go to a Batch API says the Batch run applies no time limit", async () => {
    const batch = await add("summarize", { runner: "anthropic", by: "3d", llmTimeout: "45m" });
    expect(batch.rendered).toContain("llm_timeout: not applied if the task runs through the provider Batch API");
    const sync = await add("summarize", { runner: "gemini", by: "3d", llmTimeout: "45m" });
    expect(sync.rendered).not.toContain("Batch API");
    const json = JSON.parse((await add("summarize", { runner: "openai", by: "3d", llmTimeout: "45m", json: true })).rendered) as { notes: string[] };
    expect(json.notes).toEqual([expect.stringContaining("llm_timeout: not applied if the task runs through the provider Batch API")]);
    const quiet = JSON.parse((await add("summarize", { runner: "openai", by: "2h", llmTimeout: "45m", json: true })).rendered) as { notes: string[] };
    expect(quiet.notes).toEqual([]);
  });

  it("queue add with no --by exits 2 and lists the forms", async () => {
    const err = await usageError(add("hi"));
    expect(err.exitCode).toBe(2);
    expect(err.message).toBe("queue add: --by is required: a duration (30m, 2h, 3d, 1w), an ISO-8601 time, or quota-reset");
    await usageError(add("hi", { by: "soonish" }));
  });

  it("--by 2h, --by <ISO> and --by quota-reset set deadline and deadline_kind", async () => {
    const now = new Date();
    const inTwo = await add("a", { by: "2h", now: () => now });
    expect(row(inTwo.record.taskId).deadline).toBe(new Date(now.getTime() + 2 * 3_600_000).toISOString());
    expect(row(inTwo.record.taskId).deadlineKind).toBe("absolute");
    const iso = new Date(now.getTime() + 5 * 3_600_000).toISOString();
    expect(row((await add("b", { by: iso })).record.taskId).deadline).toBe(iso);
    const config = join(dir, "config");
    writeFileSync(config, "TIDEGAP_QUOTA_RESET_CLAUDE=mon 10:00 UTC\n");
    const quota = row((await add("c", { by: "quota-reset", config })).record.taskId);
    expect(quota.deadlineKind).toBe("quota_reset");
    expect(quota.quotaProvider).toBe("claude");
    expect(new Date(quota.deadline!).getUTCDay()).toBe(1);
  });

  it("--by quota-reset with two labels and no --quota-provider exits 2", async () => {
    const config = join(dir, "config");
    writeFileSync(config, "TIDEGAP_QUOTA_RESET_CLAUDE=mon 10:00 UTC\nTIDEGAP_QUOTA_RESET_CODEX=tue 10:00 UTC\n");
    const err = await usageError(add("c", { by: "quota-reset", config }));
    expect(err.message).toMatch(/^queue add: --by quota-reset: /);
    const ok = row((await add("c", { by: "quota-reset", config, quotaProvider: "codex" })).record.taskId);
    expect(ok.quotaProvider).toBe("codex");
    await usageError(add("c", { by: "2h", quotaProvider: "codex" }));
  });

  it("--after-limit-reset sets not_before from the reset source", async () => {
    const at = new Date(Date.now() + 3 * 3_600_000);
    const seen: Array<string | undefined> = [];
    const res = await add("later", {
      by: "12h",
      afterLimitReset: true,
      resetTarget: async (model) => {
        seen.push(model);
        return { ok: true, target: { at, window: "five_hour", exhausted: true, pct: 100 } };
      },
    });
    expect(row(res.record.taskId).notBefore).toBe(at.toISOString());
    expect(seen).toEqual(["claude-sonnet-5"]);
    await expect(add("x", { by: "12h", afterLimitReset: true, resetTarget: async () => ({ ok: false, reason: "no limit reading" }) })).rejects.toThrow(
      /--after-limit-reset: no limit reading/,
    );
    await usageError(add("x", { by: "12h", afterLimitReset: true, notBefore: "1h" }));
    const pinned = await add("x", { by: "12h", notBefore: "1h" });
    expect(Date.parse(row(pinned.record.taskId).notBefore!)).toBeGreaterThan(Date.now());
  });

  it("--profile on runner anthropic and --cwd on runner openai exit 2", async () => {
    expect((await usageError(add("x", { runner: "anthropic", profile: "read", by: "1h" }))).message).toBe(
      "queue add: --profile applies to runner claude-code only, not anthropic",
    );
    expect((await usageError(add("x", { runner: "openai", cwd: work, by: "1h" }))).message).toBe(
      "queue add: --cwd applies to runner claude-code or command only, not openai",
    );
    await usageError(add("x", { runner: "command", model: "m", by: "1h" }));
    await usageError(add("x", { runner: "claude-code", commandTimeout: "1m", by: "1h" }));
    await usageError(add("x", { runner: "shell", by: "1h" }));
    await usageError(add("x", { runner: "claude-code", profile: "web", cwd: work, by: "1h" }));
    await usageError(add("x", { runner: "claude-code", profile: "edit", by: "1h" }));
  });

  it("--cwd without --profile on claude-code stores the read tools", async () => {
    const res = await add("review", { runner: "claude-code", cwd: ".", by: "1h" });
    const spec = body(res.record.taskId);
    expect(spec.handoff).toEqual({ cwd: work, profile: "read" });
    expect(spec.tools).toEqual(["Read", "Grep", "Glob"]);
    expect(res.rendered.split("\n")).toEqual(expect.arrayContaining([`cwd: ${work}`, "profile: read"]));
    const web = body((await add("search", { runner: "claude-code", profile: "web", by: "1h" })).record.taskId);
    expect(web.tools).toEqual(["WebSearch", "WebFetch"]);
    expect(web.handoff).toEqual({ profile: "web" });
    await usageError(add("x", { runner: "claude-code", cwd: homedir(), by: "1h" }));
  });

  it("text - reads stdin, refuses more than 1 MiB, and refuses a command over 32,000 characters", async () => {
    const res = await add("-", { by: "1h", readStdin: () => "a prompt from stdin\n" });
    expect(body(res.record.taskId).prompt).toBe("a prompt from stdin\n");
    const cmd = await add("-", { runner: "command", by: "1h", readStdin: () => "echo one\n" });
    expect(body(cmd.record.taskId).command?.run).toBe("echo one");
    expect((await usageError(add("-", { by: "1h", readStdin: () => "x".repeat(1024 * 1024 + 1) }))).message).toMatch(/longer than 1048576 bytes/);
    expect((await usageError(add("x".repeat(32_001), { runner: "command", by: "1h" }))).message).toMatch(/longer than 32000 characters/);
    await usageError(add("   ", { runner: "command", by: "1h" }));
  });

  it("inside a session the task records origin_session_id and a body origin; --session with another id exits 2", async () => {
    const app = join(dir, "app");
    mkdirSync(app);
    const res = await add("check the build", { by: "1h", sessionSources: inside(app) });
    const r = row(res.record.taskId);
    expect(r.originSessionId).toBe(SESSION);
    expect(r.originCwd).toBe(app);
    expect(r.originHost).toBe("cli");
    const spec = body(res.record.taskId);
    // Inside a session the default runner is claude-code.
    expect(spec.provider).toBe("claude-code");
    expect(spec.origin).toEqual({ agent: "claude-code", via: "hook" });
    expect(res.rendered).toContain(`origin_session: ${SESSION}`);
    expect(row((await add("x", { by: "1h", session: "current", sessionSources: inside(app) })).record.taskId).originSessionId).toBe(SESSION);
    expect(row((await add("x", { by: "1h", session: SESSION, sessionSources: inside(app) })).record.taskId).originSessionId).toBe(SESSION);
    const foreign = (await usageError(add("x", { by: "1h", session: OTHER, sessionSources: inside(app) }))).message;
    expect(foreign).toMatch(/is not this Claude Code session; drop --session/);
    expect(foreign).not.toMatch(/--peek/);
    // A result path inside the session's project folder is allowed.
    const withFile = await add("x", { runner: "anthropic", by: "1h", resultPath: join(app, "out.md"), sessionSources: inside(app) });
    expect(body(withFile.record.taskId).handoff).toEqual({ resultPath: join(app, "out.md") });
  });

  it("outside a session, --session <id> exits 2; without it the task has no origin and the output says notices are off", async () => {
    expect((await usageError(add("x", { by: "1h", session: SESSION }))).message).toMatch(/needs a Claude Code session, and none was found; drop --session/);
    await usageError(add("x", { by: "1h", session: "current" }));
    const res = await add("x", { by: "1h" });
    const r = row(res.record.taskId);
    expect(r.originSessionId).toBeUndefined();
    expect(body(res.record.taskId).origin).toBeUndefined();
    expect(body(res.record.taskId).provider).toBe("anthropic");
    expect(res.rendered).toContain("notices: off (not queued from a Claude Code session)");
  });

  it("--json prints task_id, status, runner, scheduled_for, deadline, origin_session_id, result_path, wake, wake_armed and notes", async () => {
    const out = join(work, "result.txt");
    const res = await add("ls", { runner: "command", by: "1h", json: true, resultPath: "result.txt", commandTimeout: "90s" });
    const json = JSON.parse(res.rendered) as Record<string, unknown>;
    expect(Object.keys(json)).toEqual(["task_id", "status", "runner", "scheduled_for", "deadline", "origin_session_id", "result_path", "wake", "wake_armed", "notes"]);
    expect(Object.keys(json)).toEqual([...QUEUE_ADD_JSON_KEYS]);
    expect(json).toMatchObject({ task_id: res.record.taskId, status: "scheduled", runner: "command", origin_session_id: null, result_path: out, wake: false, wake_armed: false });
    expect(body(res.record.taskId).caps?.commandTimeoutMs).toBe(90_000);
    await usageError(add("ls", { runner: "command", by: "1h", commandTimeout: "8d" }));
  });

  it("--json with --wake prints the same keys in the same order", async () => {
    // A wake needs the default ledger: the sandbox HOME's.
    const res = await add("x", { by: "1h", json: true, wake: true, db: defaultDbPath(), sessionSources: inside(work) });
    try {
      const json = JSON.parse(res.rendered) as Record<string, unknown>;
      expect(Object.keys(json)).toEqual([...QUEUE_ADD_JSON_KEYS]);
      expect(json).toMatchObject({ origin_session_id: SESSION, wake: true, wake_armed: true });
    } finally {
      rmSync(join(homedir(), ".tidegap"), { recursive: true, force: true });
    }
  });

  it("refuses a protected or existing result path with exit 2 and queues nothing", async () => {
    writeFileSync(join(work, "exists.txt"), "x");
    expect((await usageError(add("x", { by: "1h", resultPath: "exists.txt" }))).message).toMatch(/already exists/);
    expect((await usageError(add("x", { by: "1h", resultPath: join(homedir(), ".ssh", "config") }))).message).toMatch(/protected folder/);
    expect((await usageError(add("x", { by: "1h", resultPath: "/elsewhere/x.md" }))).message).toMatch(/result path/);
    const s = new TaskStore({ dbPath: db });
    try {
      expect(s.list()).toHaveLength(0);
    } finally {
      s.close();
    }
  });
});
