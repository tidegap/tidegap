/**
 * Queueing handed-off work: the one-off command row, the handoff checks of
 * `enqueueProviderCall`, where a handoff row is dispatched, its events, the
 * retry refusal of a one-off command, and the `output_path` rules at the
 * write.
 */

import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { COMMAND_MAX_CHARS, DEFAULT_JOB_CAPS, mockGridFeed, Scheduler, TaskActionError, taskWorkShape } from "../src/index.js";
import type { DispatchOptions, ProviderAdapter, ProviderCallSpec } from "../src/index.js";

const SESSION = "0d9d6a8e-1111-4222-8333-944455556666";
const ORIGIN = { agent: "claude-code" as const, via: "hook" as const };

/** A fake adapter that records each call's options. */
function recorder(provider: string, fail?: string) {
  const calls: Array<{ model: string; prompt: string; options: DispatchOptions }> = [];
  const adapter: ProviderAdapter = {
    provider,
    ready: true,
    async dispatch(model, prompt, options = {}) {
      calls.push({ model, prompt, options });
      if (fail) throw Object.assign(new Error(fail), { status: 400 });
      return { text: "the answer", model, provider, raw: null };
    },
  };
  return { adapter, calls };
}

describe("handoff enqueue", () => {
  let dir: string;
  let work: string;
  let app: string;
  let s: Scheduler;
  const soon = () => new Date(Date.now() + 60 * 60 * 1000);

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "tidegap-handoff-enqueue-")));
    work = join(dir, "work");
    app = join(dir, "app");
    mkdirSync(work);
    mkdirSync(app);
    s = new Scheduler({ dbPath: join(dir, "queue.db"), feed: mockGridFeed(), signing: false, rng: () => 0, defaultRegion: "DE" });
  });
  afterEach(() => {
    s.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  const claude = (extra: Partial<ProviderCallSpec> = {}): ProviderCallSpec => ({
    type: "provider_call",
    provider: "claude-code",
    model: "sonnet",
    prompt: "review the change",
    origin: ORIGIN,
    ...extra,
  });
  const fromSession = () => ({ deadline: soon(), originCwd: app, originSessionId: SESSION, originHost: "cli" as const });

  it("enqueueProviderCall still refuses provider command", async () => {
    await expect(
      s.enqueueProviderCall({ type: "provider_call", provider: "command", model: "none", prompt: "x" }, { deadline: soon() }),
    ).rejects.toThrow(/unsupported provider "command"/);
  });

  it("enqueueCommandTask writes a scheduled row with command.origin cli, model none and the caps", async () => {
    const rec = await s.enqueueCommandTask(
      { run: "echo hello > out.txt", cwd: work, caps: { commandTimeoutMs: 120_000 }, origin: ORIGIN },
      { deadline: soon(), originHost: "cli", originSessionId: SESSION, originCwd: app, title: "Say hello" },
    );
    const row = s.ledger()!.get(rec.taskId)!;
    expect(row.status).toBe("scheduled");
    expect(row.jobId).toBeUndefined();
    expect(row.title).toBe("Say hello");
    expect(row.originSessionId).toBe(SESSION);
    expect(JSON.parse(row.bodyJson!)).toEqual({
      type: "provider_call",
      provider: "command",
      model: "none",
      prompt: "",
      command: { run: "echo hello > out.txt", cwd: work, secrets: [], origin: "cli" },
      caps: { ...DEFAULT_JOB_CAPS, commandTimeoutMs: 120_000 },
      origin: ORIGIN,
    });
    const created = s.listTaskEvents(rec.taskId).find((e) => e.kind === "created")!;
    expect(created.details).toMatchObject({ provider: "command", model: "none", cwd: work });
  });

  it("enqueueCommandTask titles a row by its command and keeps a result path", async () => {
    const out = join(work, "result.txt");
    const rec = await s.enqueueCommandTask({ run: "uname -a", cwd: work, resultPath: out }, { deadline: soon() });
    const body = JSON.parse(s.ledger()!.get(rec.taskId)!.bodyJson!) as ProviderCallSpec;
    expect(body.handoff).toEqual({ resultPath: out });
    expect(rec.title).toBe("uname -a");
  });

  it("enqueueCommandTask refuses an empty command, a 32,001-character command, a missing cwd and a file as cwd", async () => {
    const file = join(dir, "file.txt");
    writeFileSync(file, "x");
    const opts = { deadline: soon() };
    await expect(s.enqueueCommandTask({ run: "  ", cwd: work }, opts)).rejects.toThrow(/non-empty/);
    await expect(s.enqueueCommandTask({ run: "x".repeat(COMMAND_MAX_CHARS + 1), cwd: work }, opts)).rejects.toThrow(/longer than 32000/);
    await expect(s.enqueueCommandTask({ run: "ls", cwd: join(dir, "gone") }, opts)).rejects.toThrow(/not an existing folder/);
    await expect(s.enqueueCommandTask({ run: "ls", cwd: file }, opts)).rejects.toThrow(/not an existing folder/);
    await expect(s.enqueueCommandTask({ run: "ls", cwd: work, caps: { commandTimeoutMs: 0 } }, opts)).rejects.toThrow(/positive number/);
    await expect(s.enqueueCommandTask({ run: "ls", cwd: work, resultPath: join(homedir(), ".zshrc") }, opts)).rejects.toThrow(/result path/);
    expect(s.ledger()!.list()).toHaveLength(0);
  });

  it("a cwd alone stores the read profile and its tools", async () => {
    const rec = await s.enqueueProviderCall(claude({ handoff: { cwd: work } }), fromSession());
    const body = JSON.parse(s.ledger()!.get(rec.taskId)!.bodyJson!) as ProviderCallSpec;
    expect(body.handoff).toEqual({ cwd: work, profile: "read" });
    expect(body.tools).toEqual(["Read", "Grep", "Glob"]);
  });

  it("refuses handoff fields that do not fit the runner or the profile", async () => {
    const opts = fromSession();
    const anthropic = { ...claude(), provider: "anthropic" as const, model: "claude-sonnet-5" };
    await expect(s.enqueueProviderCall({ ...anthropic, handoff: { cwd: work } }, opts)).rejects.toThrow(/claude-code runner only/);
    await expect(s.enqueueProviderCall({ ...anthropic, handoff: { profile: "read" } }, opts)).rejects.toThrow(/claude-code runner only/);
    await expect(s.enqueueProviderCall(claude({ handoff: { cwd: work, profile: "web" } }), opts)).rejects.toThrow(/cannot take a cwd/);
    await expect(s.enqueueProviderCall(claude({ handoff: { profile: "read" }, tools: ["WebSearch"] }), opts)).rejects.toThrow(/differ from profile read/);
    await expect(s.enqueueProviderCall(claude({ handoff: { cwd: homedir() } }), opts)).rejects.toThrow(/root or home folder/);
    await expect(s.enqueueProviderCall(claude({ handoff: { resultPath: join(homedir(), ".zshrc") } }), opts)).rejects.toThrow(/result path .*\.zshrc/);
    await expect(s.enqueueProviderCall(claude({ outputPath: join(homedir(), "Library", "x.plist") }), opts)).rejects.toThrow(/protected folder/);
    expect(s.ledger()!.list()).toHaveLength(0);
  });

  it("an LLM runner may ask for a result file inside the session's project folder", async () => {
    const rec = await s.enqueueProviderCall(
      { type: "provider_call", provider: "anthropic", model: "claude-sonnet-5", prompt: "x", handoff: { resultPath: join(app, "r.md") } },
      fromSession(),
    );
    expect(s.ledger()!.get(rec.taskId)!.status).toBe("scheduled");
  });

  it("a claude-code handoff row whose cwd is the origin project dir dispatches with origin (fork)", async () => {
    const rec = await s.enqueueProviderCall(claude({ handoff: { cwd: app } }), fromSession());
    s.runNow(rec.taskId);
    const { adapter, calls } = recorder("claude-code");
    await s.tick({ "claude-code": adapter });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options.origin).toEqual({ sessionId: SESSION, cwd: app, agent: "claude-code" });
    expect(calls[0]!.options.cwd).toBe(app);
    expect(calls[0]!.options.tools).toEqual(["Read", "Grep", "Glob"]);
    const dispatched = s.listTaskEvents(rec.taskId).find((e) => e.kind === "dispatched")!;
    expect(dispatched.details).toMatchObject({ planned_mode: "fork", cwd: app });
  });

  it("a claude-code handoff row with another cwd dispatches with origin and that cwd", async () => {
    const rec = await s.enqueueProviderCall(claude({ handoff: { cwd: work, profile: "none" } }), fromSession());
    s.runNow(rec.taskId);
    const { adapter, calls } = recorder("claude-code");
    await s.tick({ "claude-code": adapter });
    expect(calls[0]!.options.origin).toEqual({ sessionId: SESSION, cwd: app, agent: "claude-code" });
    expect(calls[0]!.options.cwd).toBe(work);
    expect(calls[0]!.options.tools).toEqual([]);
  });

  it("the created and dispatched events of a handoff row name profile, tools, cwd and planned_mode", async () => {
    const rec = await s.enqueueProviderCall(claude({ handoff: { cwd: work } }), fromSession());
    s.runNow(rec.taskId);
    await s.tick({ "claude-code": recorder("claude-code").adapter });
    const events = s.listTaskEvents(rec.taskId);
    const want = { profile: "read", tools: ["Read", "Grep", "Glob"], cwd: work, planned_mode: "fresh" };
    expect(events.find((e) => e.kind === "created")!.details).toMatchObject(want);
    expect(events.find((e) => e.kind === "dispatched")!.details).toMatchObject(want);
    // A row without handoff fields keeps its old event details.
    const plain = await s.enqueueProviderCall(claude(), fromSession());
    expect(s.listTaskEvents(plain.taskId).find((e) => e.kind === "created")!.details).not.toHaveProperty("planned_mode");
  });

  it("retryTask refuses a failed one-off command row and names queue add", async () => {
    const rec = await s.enqueueCommandTask({ run: "false", cwd: work }, { deadline: soon() });
    s.runNow(rec.taskId);
    const { adapter } = recorder("command", "command exited with code 1");
    await s.tick({ command: adapter });
    expect(s.ledger()!.get(rec.taskId)!.status).toBe("failed");
    await expect(s.retryTask(rec.taskId, { command: adapter })).rejects.toThrow(TaskActionError);
    await expect(s.retryTask(rec.taskId, { command: adapter })).rejects.toThrow(/tidegap queue add --runner command/);
  });

  it("a result path needs a one-off task: a repeat is refused at enqueue and in the preview", async () => {
    const opts = { ...fromSession(), repeat: "daily" as const };
    const spec = claude({ handoff: { resultPath: join(app, "r.md") } });
    await expect(s.enqueueProviderCall(spec, opts)).rejects.toThrow(/result path needs a one-off task/);
    await expect(s.previewProviderCall(spec, opts)).rejects.toThrow(/result path needs a one-off task/);
    expect(s.ledger()!.list()).toHaveLength(0);
  });

  it("a reply to a handoff row works in its folder with its profile, and writes no result file", async () => {
    const parent = await s.enqueueProviderCall(claude({ handoff: { cwd: work, resultPath: join(app, "r.md") } }), fromSession());
    s.runNow(parent.taskId);
    const { adapter, calls } = recorder("claude-code");
    await s.tick({ "claude-code": adapter });
    expect(s.ledger()!.get(parent.taskId)!.status).toBe("completed");
    const reply = await s.replyToTask(parent.taskId, "and the tests?", { keepOrigin: true });
    expect(JSON.parse(reply.bodyJson!).handoff).toEqual({ cwd: work, profile: "read" });
    s.runNow(reply.taskId);
    await s.tick({ "claude-code": adapter });
    expect(calls[1]!.options.cwd).toBe(work);
    expect(calls[1]!.options.tools).toEqual(["Read", "Grep", "Glob"]);
  });

  it("a one-off command's text is redacted when it completes, like a prompt", async () => {
    const key = `sk-ant-${"c".repeat(30)}`;
    const rec = await s.enqueueCommandTask({ run: `curl -H 'x-api-key: ${key}' https://example.invalid`, cwd: work }, { deadline: soon() });
    s.runNow(rec.taskId);
    const { adapter, calls } = recorder("command");
    await s.tick({ command: adapter });
    // The run got the text as written; the ledger keeps it redacted.
    expect(calls[0]!.options.command?.run).toContain(key);
    const done = s.ledger()!.get(rec.taskId)!;
    expect(done.status).toBe("completed");
    expect(done.bodyJson).not.toContain(key);
    expect(taskWorkShape(done).command).toBe("curl -H 'x-api-key: [REDACTED]' https://example.invalid");
  });

  it("a one-off command row hands its shell step, with origin cli, and no job id to the command adapter", async () => {
    const rec = await s.enqueueCommandTask({ run: "echo hi", cwd: work }, { deadline: soon() });
    s.runNow(rec.taskId);
    const { adapter, calls } = recorder("command");
    await s.tick({ command: adapter });
    expect(calls[0]!.options.jobId).toBeUndefined();
    expect(calls[0]!.options.command).toEqual({ run: "echo hi", cwd: work, secrets: [], origin: "cli" });
    expect(calls[0]!.options.caps).toEqual(DEFAULT_JOB_CAPS);
  });
});

describe("output_path at the write", () => {
  let dir: string;
  let s: Scheduler;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "tidegap-output-path-")));
    s = new Scheduler({ dbPath: join(dir, "queue.db"), feed: mockGridFeed(), signing: false, rng: () => 0, defaultRegion: "DE" });
  });
  afterEach(() => {
    s.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  const spec = (outputPath: string): ProviderCallSpec => ({
    type: "provider_call",
    provider: "anthropic",
    model: "claude-sonnet-5",
    prompt: "x",
    outputPath,
  });

  it("replaces a regular file it may write and never follows a link put there after enqueue", async () => {
    const out = join(dir, "digest.json");
    writeFileSync(out, "old");
    const rec = await s.enqueueProviderCall(spec(out), { deadline: new Date(Date.now() + 3_600_000) });
    s.runNow(rec.taskId);
    await s.tick({ anthropic: recorder("anthropic").adapter });
    expect(JSON.parse(readFileSync(out, "utf8")).taskId).toBe(rec.taskId);

    const victim = join(dir, "victim.txt");
    writeFileSync(victim, "keep");
    const linked = join(dir, "linked.json");
    const rec2 = await s.enqueueProviderCall(spec(linked), { deadline: new Date(Date.now() + 3_600_000) });
    symlinkSync(victim, linked);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    s.runNow(rec2.taskId);
    await s.tick({ anthropic: recorder("anthropic").adapter });
    warn.mockRestore();
    expect(readFileSync(victim, "utf8")).toBe("keep");
    expect(s.ledger()!.get(rec2.taskId)!.status).toBe("completed");
  });

  it("never writes into a file with a second name (a hard link) put there after enqueue", async () => {
    const victim = join(dir, "victim.txt");
    writeFileSync(victim, "keep");
    const out = join(dir, "hard.json");
    const rec = await s.enqueueProviderCall(spec(out), { deadline: new Date(Date.now() + 3_600_000) });
    linkSync(victim, out);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    s.runNow(rec.taskId);
    await s.tick({ anthropic: recorder("anthropic").adapter });
    expect(warn.mock.calls.flat().join(" ")).toMatch(/one name/);
    warn.mockRestore();
    expect(readFileSync(victim, "utf8")).toBe("keep");
    expect(s.ledger()!.get(rec.taskId)!.status).toBe("completed");
  });

  it("no longer creates a missing folder", async () => {
    const out = join(dir, "new", "digest.json");
    await expect(s.enqueueProviderCall(spec(out), { deadline: new Date(Date.now() + 3_600_000) })).rejects.toThrow(/does not exist/);
    expect(existsSync(join(dir, "new"))).toBe(false);
  });
});
