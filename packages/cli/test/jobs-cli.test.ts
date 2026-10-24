/**
 * `tidegap jobs` (jobs U7, R24, R29, AE7): flags to jobs, the refusals and
 * their exit codes, secrets by name only, history with receipt ids.
 * Hermetic HOME (test setup), temp ledger and secrets file, no network.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AGENTS_BLOCK, mockGridFeed, renderAgentSnippet, TaskStore } from "@tidegap/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  JOBS_SNIPPET_HINT,
  JobsCommandError,
  SECRET_VALUE_AS_ARGUMENT,
  runJobsAction,
  runJobsAdd,
  runJobsEdit,
  runJobsHistory,
  runJobsList,
  runJobsSecretsList,
  runJobsSecretsRemove,
  runJobsSecretsSet,
  runJobsShow,
  type JobFlags,
} from "../src/commands/jobs.js";
import { runJobsSnippet } from "../src/commands/jobs-snippet.js";
import { buildProgram } from "../src/index.js";

const SECRET = "imap-fixture-Q7f3kLm9";

let dir: string;
let db: string;
let secretsFile: string;
/** Every line the commands printed: none may hold the secret value. */
let outputs: string[];
const feed = mockGridFeed();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tidegap-jobs-cli-"));
  db = join(dir, "queue.db");
  secretsFile = join(dir, "job-secrets.json");
  outputs = [];
});
afterEach(() => {
  for (const o of outputs) expect(o).not.toContain(SECRET);
  rmSync(dir, { recursive: true, force: true });
});

const base = () => ({ db, feed, secretsFile });
async function out(p: Promise<string> | string): Promise<string> {
  const text = await p;
  outputs.push(text);
  return text;
}
/** The refusal of `p`: its exit code and line. */
async function refusal(p: Promise<unknown> | (() => unknown)): Promise<{ exitCode: number; message: string }> {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (err) {
    expect(err).toBeInstanceOf(JobsCommandError);
    outputs.push((err as Error).message);
    return { exitCode: (err as JobsCommandError).exitCode, message: (err as Error).message };
  }
  throw new Error("expected a refusal");
}
const add = (flags: JobFlags) => out(runJobsAdd({ ...base(), ...flags }));
const idOf = (text: string) => /created (job-[0-9a-f]{8})/.exec(text)![1]!;

describe("tidegap jobs add | show", () => {
  it("add --daily --window --prompt: exit 0; show --json has the guarantee sentence and a next run", async () => {
    const id = idOf(await add({ title: "Mail triage", daily: true, window: "00:00-08:00", prompt: "check mail", tz: "Europe/Berlin" }));
    const view = JSON.parse(await out(runJobsShow(id, { ...base(), json: true }))) as Record<string, any>;
    expect(view.guarantee).toBe("runs every day between 00:00 and 08:00");
    expect(view.runner).toBe("prompt");
    expect(view.provider).toBe("claude-code");
    expect(view.next_run.task_id).toBe(`${id}~1`);
    expect(view.origin_host).toBe("cli");
    expect(view.recent).toHaveLength(1);
  });

  it("--every 1h is a usage error (exit 2) naming the cadence rule", async () => {
    const r = await refusal(add({ title: "x", every: "1h", prompt: "p" }));
    expect(r).toEqual({ exitCode: 2, message: "every N hours needs a whole N from 2 to 168" });
  });

  it("usage errors: two cadences, --prompt with --command, no runner, a bad window, a bad duration", async () => {
    expect((await refusal(add({ title: "x", daily: true, weekdays: true, prompt: "p" }))).exitCode).toBe(2);
    expect((await refusal(add({ title: "x", daily: true, prompt: "p", command: "echo" }))).message).toMatch(/--summarize/);
    expect((await refusal(add({ title: "x", daily: true }))).message).toBe("a job needs --prompt <text> or --command <shell>");
    expect((await refusal(add({ title: "x", daily: true, prompt: "p", window: "8-9" }))).exitCode).toBe(2);
    expect((await refusal(add({ title: "x", daily: true, prompt: "p", commandTimeout: "soon" }))).exitCode).toBe(2);
    expect((await refusal(add({ title: "x", daily: true, prompt: "p", tools: "shell" }))).message).toBe("tools must be none, files or web");
  });

  it("a command job with an unset secret is created; show warns by name", async () => {
    const id = idOf(await add({ title: "c", daily: true, command: "echo x", secret: ["IMAP_PASSWORD"], summarize: "say what matters", secretsFile }));
    const text = await out(runJobsShow(id, base()));
    expect(text).toContain("command: echo x");
    expect(text).toContain("summarize (claude-code, no tools): say what matters");
    expect(text).toContain("warning: secret IMAP_PASSWORD is not set; run: tidegap jobs secrets set IMAP_PASSWORD");
  });

  it("covers AE7: after secrets set, show prints the name only; the value has 0 hits in any output", async () => {
    const id = idOf(await add({ title: "c", daily: true, command: "echo x", secret: ["IMAP_PASSWORD"] }));
    expect(await out(runJobsSecretsSet("IMAP_PASSWORD", { secretsFile }, { isTTY: false, readStdin: async () => `${SECRET}\n` }))).toBe("secret IMAP_PASSWORD saved");
    const text = await out(runJobsShow(id, base()));
    expect(text).toContain("secrets: IMAP_PASSWORD");
    expect(text).not.toContain("warning:");
    await out(runJobsShow(id, { ...base(), json: true }));
    expect(await out(runJobsSecretsList({ secretsFile }))).toBe("IMAP_PASSWORD");
    expect(await out(runJobsSecretsList({ secretsFile, json: true }))).toBe('{"names":["IMAP_PASSWORD"]}');
    expect(await out(runJobsSecretsRemove("IMAP_PASSWORD", { secretsFile }))).toBe("secret IMAP_PASSWORD removed");
    expect((await refusal(() => runJobsSecretsRemove("IMAP_PASSWORD", { secretsFile }))).exitCode).toBe(1);
    expect((await refusal(runJobsSecretsSet("bad name", { secretsFile }, { isTTY: false, readStdin: async () => SECRET }))).exitCode).toBe(2);
  });

  it("--file reads the JobInput JSON; flags override its fields", async () => {
    const file = join(dir, "job.json");
    writeFileSync(file, JSON.stringify({ title: "from file", cadence: { kind: "weekly", days: ["mon", "thu"] }, runner: "prompt", prompt: "p", notify: "failures" }));
    const id = idOf(await add({ file, title: "flag title" }));
    const view = JSON.parse(await out(runJobsShow(id, { ...base(), json: true }))) as Record<string, any>;
    expect(view.title).toBe("flag title");
    expect(view.cadence).toEqual({ kind: "weekly", days: ["mon", "thu"] });
    expect(view.notify).toBe("failures");
    expect((await refusal(add({ file: join(dir, "missing.json") }))).exitCode).toBe(2);
  });
});

describe("tidegap jobs edit | pause | resume | run | remove | history | list", () => {
  it("edit changes only the flags given; --window none removes the window", async () => {
    const id = idOf(await add({ title: "t", daily: true, window: "22:00-06:00", prompt: "p", notify: "summary" }));
    await out(runJobsEdit(id, { ...base(), title: "renamed", window: "none" }));
    const view = JSON.parse(await out(runJobsShow(id, { ...base(), json: true }))) as Record<string, any>;
    expect(view).toMatchObject({ title: "renamed", window: null, notify: "summary", prompt: "p" });
    expect((await refusal(runJobsEdit(id, base()))).exitCode).toBe(2);
    expect((await refusal(runJobsEdit("job-00000000", { ...base(), title: "x" }))).message).toBe('job "job-00000000" not found');
  });

  it("pause, run (refused: job is paused), resume, run, remove; the refusals exit 1", async () => {
    const id = idOf(await add({ title: "t", daily: true, prompt: "p" }));
    expect(await out(runJobsAction("pause", id, base()))).toMatch(new RegExp(`^paused ${id}`));
    expect(await refusal(runJobsAction("run", id, base()))).toEqual({ exitCode: 1, message: "job is paused" });
    expect(await refusal(runJobsAction("pause", id, base()))).toEqual({ exitCode: 1, message: "job is already paused" });
    expect(await out(runJobsAction("resume", id, base()))).toMatch(new RegExp(`^resumed ${id}`));
    expect(await out(runJobsAction("run", id, base()))).toMatch(new RegExp(`^${id}: ${id}~\\d+ marked to run now; the next tick runs it$`));
    expect(await out(runJobsAction("remove", id, base()))).toBe(`removed ${id}; its history stays (tidegap jobs history ${id})`);
    expect(await refusal(runJobsAction("resume", id, base()))).toEqual({ exitCode: 1, message: "job was removed" });
  });

  it("history lists runs newest first with receipt ids", async () => {
    const id = idOf(await add({ title: "t", daily: true, prompt: "p" }));
    const store = new TaskStore({ dbPath: db });
    const row = store.get(`${id}~1`)!;
    store.upsert({ ...row, status: "completed", completedAt: new Date().toISOString(), receipt: { taskId: row.taskId, ranAt: new Date().toISOString(), region: "DE", estimatedCarbonGCo2: 0.5 } } as never);
    store.close();
    const text = await out(runJobsHistory(id, base()));
    expect(text).toContain(`${id}~1`);
    expect(text.split("\n")[1]).toMatch(new RegExp(`${id}~1 +completed .+${id}~1 +0\\.50 g`));
    const json = JSON.parse(await out(runJobsHistory(id, { ...base(), json: true }))) as { runs: Array<Record<string, unknown>> };
    expect(json.runs[0]).toMatchObject({ task_id: `${id}~1`, receipt_id: `${id}~1`, status: "completed" });
    expect((await refusal(runJobsHistory(id, { ...base(), limit: "0" }))).exitCode).toBe(2);
  });

  it("jobs with no command lists the jobs and the snippet hint; list --all adds removed jobs", async () => {
    expect(await out(runJobsList({ ...base(), hint: true }))).toContain(JOBS_SNIPPET_HINT);
    const id = idOf(await add({ title: "Mail triage", daily: true, prompt: "p" }));
    const text = await out(runJobsList({ ...base(), hint: true }));
    expect(text).toMatch(new RegExp(`${id} +active +daily .+Mail triage`));
    expect(text.split("\n").at(-1)).toBe(JOBS_SNIPPET_HINT);
    await out(runJobsAction("remove", id, base()));
    expect(await out(runJobsList(base()))).not.toContain(id);
    expect(await out(runJobsList({ ...base(), all: true }))).toContain(id);
  });

  it("through the program: add --json --db reach the leaf command (not the group) and print the Job JSON", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => void lines.push(String(line)));
    try {
      await buildProgram().parseAsync(["node", "tidegap", "jobs", "add", "--title", "p", "--daily", "--prompt", "x", "--json", "--db", db]);
    } finally {
      spy.mockRestore();
    }
    expect(JSON.parse(lines.join("\n"))).toMatchObject({ title: "p", origin_host: "cli" });
    const store = new TaskStore({ dbPath: db });
    expect(store.listJobs()).toHaveLength(1);
    store.close();
  });

  it("through the program: secrets set NAME <value> exits 2 and saves nothing; jobs <unknown> exits 2", async () => {
    const errors: string[] = [];
    const err = vi.spyOn(console, "error").mockImplementation((line: unknown) => void errors.push(String(line)));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const prior = process.exitCode;
    try {
      await buildProgram().parseAsync(["node", "tidegap", "jobs", "secrets", "set", "IMAP_PASSWORD", SECRET]);
      expect(process.exitCode).toBe(2);
      expect(errors).toEqual([SECRET_VALUE_AS_ARGUMENT]);
      process.exitCode = undefined;
      await buildProgram().parseAsync(["node", "tidegap", "jobs", "lsit"]);
      expect(process.exitCode).toBe(2);
      expect(errors[1]).toBe('unknown command "lsit"; see tidegap jobs --help');
      expect(log).not.toHaveBeenCalled();
    } finally {
      process.exitCode = prior;
      err.mockRestore();
      log.mockRestore();
    }
    outputs.push(...errors);
    expect(runJobsSecretsList({ secretsFile })).toMatch(/^No job secrets/);
  });

  it("a bad secret name is a usage error (exit 2) for set and remove, checked before the value is read", async () => {
    const readStdin = vi.fn(async () => SECRET);
    expect((await refusal(runJobsSecretsSet("imap-password", { secretsFile }, { isTTY: false, readStdin }))).exitCode).toBe(2);
    expect(readStdin).not.toHaveBeenCalled();
    expect((await refusal(() => runJobsSecretsRemove("imap-password", { secretsFile }))).exitCode).toBe(2);
  });

  it("the program registers jobs with its commands and secrets subcommands", () => {
    const jobs = buildProgram().commands.find((c) => c.name() === "jobs")!;
    expect(jobs.commands.map((c) => c.name())).toEqual(["list", "show", "add", "edit", "pause", "resume", "run", "remove", "snippet", "history", "secrets"]);
    expect(jobs.commands.find((c) => c.name() === "secrets")!.commands.map((c) => c.name())).toEqual(["list", "set", "remove"]);
  });

  it("snippet: the generic block by default, a host's files with --host, claude-code as an alias (R35, R36)", () => {
    expect(runJobsSnippet({})).toContain(AGENTS_BLOCK.trimEnd());
    const opencode = runJobsSnippet({ host: "opencode" });
    expect(opencode).toBe(renderAgentSnippet("opencode"));
    expect(opencode).toContain("~/.config/opencode/skills/tidegap/SKILL.md:");
    expect(opencode).toContain('"crontab *": "ask"');
    expect(runJobsSnippet({ host: "Claude-Code" })).toBe(renderAgentSnippet("claude"));
  });

  it("snippet: an unknown host is a usage error (exit 2) that lists the hosts", async () => {
    const r = await refusal(() => runJobsSnippet({ host: "vim" }));
    expect(r.exitCode).toBe(2);
    expect(r.message).toBe('unknown host "vim"; use one of: generic, claude, opencode, codex, cursor, gemini');
  });
});
