import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProviderDeferError, ProviderRefusalError, type DispatchOptions } from "@tidegap/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeCodeAdapter, resetFromText, type ClaudeCodeAdapterOptions } from "../src/providers/claude-code.js";
import { resumeSettings } from "../src/session/index.js";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-claude", "claude");

let root: string;
let log: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "tidegap-cc-adapter-")));
  log = join(root, "log");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function adapter(mode: string, extra: Partial<ClaudeCodeAdapterOptions> = {}): ClaudeCodeAdapter {
  return new ClaudeCodeAdapter({
    binaryPath: FAKE,
    env: { PATH: "/usr/bin:/bin", FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_LOG: log },
    scratchRoot: root,
    ...extra,
  });
}

const argv = (): string[] => readFileSync(join(log, "argv"), "utf8").split("\n").slice(0, -1);
const logged = (name: string): string => readFileSync(join(log, name), "utf8");
const scratchDirs = (): string[] => readdirSync(root).filter((n) => n.startsWith("tidegap-claude-"));

/** True while the pid exists (signal 0 only probes). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The error a rejected dispatch throws. */
async function failure(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the dispatch to fail");
}

describe("ClaudeCodeAdapter", () => {
  it("is ready only with a binary path", () => {
    expect(new ClaudeCodeAdapter({ binaryPath: FAKE }).ready).toBe(true);
    expect(new ClaudeCodeAdapter().ready).toBe(false);
  });

  it("maps a successful run onto the dispatch result", async () => {
    const r = await adapter("success").dispatch("haiku", "Reply OK");
    expect(r.text).toBe("OK");
    expect(r.provider).toBe("claude-code");
    // The modelUsage entry with the most output tokens.
    expect(r.model).toBe("claude-haiku-5-5");
    expect(r.stopReason).toBe("end_turn");
    // input_tokens + cache_creation_input_tokens; cache reads stay out.
    expect(r.usage).toEqual({ inputTokens: 2051, outputTokens: 5, totalTokens: 2056 });
    const raw = r.raw as { session_id: string; total_cost_usd: number };
    expect(raw.session_id).toBe("0b6f2c1e-5d1a-4c0e-9a51-3f7e8d2c4b10");
    expect(raw.total_cost_usd).toBe(0.00042);
  });

  it("sends the prompt on stdin with the read-only web argv", async () => {
    const r = await adapter("success").dispatch("default", "secret prompt text");
    expect(logged("stdin")).toBe("secret prompt text");
    const args = argv();
    expect(args.join("\n")).not.toContain("secret prompt text");
    expect(args).toEqual([
      "-p",
      "--output-format", "json",
      "--tools", "WebSearch,WebFetch",
      "--allowedTools", "WebSearch,WebFetch",
      "--permission-mode", "dontAsk",
      "--max-budget-usd", "1",
      "--safe-mode",
      "--strict-mcp-config",
      "--no-session-persistence",
    ]);
    expect(args).not.toContain("--bare");
    expect(r.tools).toEqual(["WebSearch", "WebFetch"]);
  });

  it("an empty tool set sends --tools \"\" and no --allowedTools", async () => {
    const r = await adapter("success").dispatch("default", "hi", { tools: [] });
    const args = argv();
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args).not.toContain("--allowedTools");
    expect(r.tools).toEqual([]);
  });

  it("a per-task tool set wins over the adapter default", async () => {
    const r = await adapter("success", { defaultTools: [] }).dispatch("default", "hi", { tools: ["Read", "Grep"] });
    const args = argv();
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Grep");
    // File tools are never pre-approved by bare name: that would allow reads anywhere.
    expect(args).not.toContain("--allowedTools");
    expect(r.tools).toEqual(["Read", "Grep"]);
  });

  it("uses the adapter default when the task names no tools", async () => {
    await adapter("success", { defaultTools: ["WebSearch"] }).dispatch("default", "hi");
    const args = argv();
    expect(args[args.indexOf("--tools") + 1]).toBe("WebSearch");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("WebSearch");
  });

  it("refuses a tool outside the allowlist without running claude", async () => {
    const err = await failure(adapter("success").dispatch("default", "hi", { tools: ["WebFetch", "Bash"] }));
    expect(err.message).toContain("Bash");
    expect(err.message).toContain("WebSearch, WebFetch, Read, Grep, Glob");
    expect(existsSync(join(log, "argv"))).toBe(false);
  });

  it("refuses a bad default tool set or a file+web mix without running claude", async () => {
    const bad = await failure(adapter("success", { defaultTools: ["Bash"] }).dispatch("default", "hi"));
    expect(bad.message).toContain("Bash");
    const mixed = await failure(adapter("success").dispatch("default", "hi", { tools: ["Read", "WebFetch"] }));
    expect(mixed.message).toContain("cannot combine a file tool");
    const notArray = await failure(
      adapter("success").dispatch("default", "hi", { tools: "Bash" as unknown as string[] }),
    );
    expect(notArray.message).toContain("must be an array");
    expect(existsSync(join(log, "argv"))).toBe(false);
  });

  it("passes a custom budget cap", async () => {
    await adapter("success", { maxBudgetUsd: 0.25 }).dispatch("default", "hi");
    const args = argv();
    expect(args[args.indexOf("--max-budget-usd") + 1]).toBe("0.25");
  });

  it("runs in a fresh scratch dir and removes it on success and on failure", async () => {
    await adapter("success").dispatch("default", "hi");
    const cwd = logged("cwd").trim();
    expect(dirname(cwd)).toBe(root);
    expect(cwd.split("/").pop()).toMatch(/^tidegap-claude-/);
    expect(existsSync(cwd)).toBe(false);

    await failure(adapter("logged-out").dispatch("default", "hi"));
    expect(scratchDirs()).toEqual([]);
  });

  it.each([
    ["claude-sonnet-5", true],
    ["haiku", true],
    ["opus[1m]", true],
    ["default", false],
    ["", false],
    ["gpt-6-sol", false],
  ])("model %j passes --model: %s", async (model, passes) => {
    await adapter("success").dispatch(model, "hi");
    const args = argv();
    if (passes) expect(args.slice(args.indexOf("--model"))).toEqual(["--model", model]);
    else expect(args).not.toContain("--model");
  });

  it("sends the system prompt through a file and prior turns on stdin", async () => {
    await adapter("success").dispatch("default", "and now?", {
      system: "You are terse.",
      messages: [
        { role: "user", content: "first question" },
        { role: "assistant", content: "first answer" },
      ],
    });
    const args = argv();
    const file = args[args.indexOf("--system-prompt-file") + 1]!;
    expect(dirname(file)).toBe(logged("cwd").trim());
    expect(logged("system")).toBe("You are terse.");
    const stdin = logged("stdin");
    expect(stdin.indexOf("first question")).toBeLessThan(stdin.indexOf("first answer"));
    expect(stdin.indexOf("first answer")).toBeLessThan(stdin.indexOf("and now?"));
    expect(stdin).toContain("[assistant]");
  });

  it("fails a logged-out run with the login hint and no status", async () => {
    const err = await failure(adapter("logged-out").dispatch("default", "hi"));
    expect(err.message).toContain("Not logged in");
    expect(err.message).toContain("complete /login");
    expect(err).not.toHaveProperty("status");
  });

  describe("usage-limit result: ProviderDeferError (KTD13)", () => {
    const NOW = new Date("2026-10-17T12:00:00.000Z");
    let tz: string | undefined;
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);
      tz = process.env.TZ;
    });
    afterEach(() => {
      vi.useRealTimers();
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    });
    const resolver = (at: string, exhausted: boolean) => async () => ({ at: new Date(at), exhausted });

    it("an exhausted window: retryAt is the host's reset, named in the message", async () => {
      const err = await failure(
        adapter("limit", { resetTarget: resolver("2026-10-17T18:00:00.000Z", true) }).dispatch("default", "hi"),
      );
      expect(err).toBeInstanceOf(ProviderDeferError);
      expect((err as ProviderDeferError).retryAt.toISOString()).toBe("2026-10-17T18:00:00.000Z");
      expect(err.message).toMatch(/^claude-code: .*usage limit reached.*deferred until 2026-10-17T18:00:00.000Z/);
      expect(err).not.toHaveProperty("status");
    });

    it("nothing exhausted: the text's 7pm (Europe/Kyiv) wins over the host's reset", async () => {
      const err = (await failure(
        adapter("limit", { resetTarget: resolver("2026-10-17T16:30:00.000Z", false) }).dispatch("default", "hi"),
      )) as ProviderDeferError;
      expect(err.retryAt.toISOString()).toBe("2026-10-17T16:00:00.000Z");
    });

    it("the scoped window of the task's model is passed through the resolver", async () => {
      const seen: string[] = [];
      const err = (await failure(
        adapter("limit", {
          resetTarget: async (model) => (seen.push(model), { at: new Date("2026-10-19T18:00:00.000Z"), exhausted: model === "fable" }),
        }).dispatch("fable", "hi"),
      )) as ProviderDeferError;
      expect(seen).toEqual(["fable"]);
      expect(err.retryAt.toISOString()).toBe("2026-10-19T18:00:00.000Z");
    });

    it.each(["UTC", "America/Los_Angeles"])("no target: the text's zone is used under TZ=%s", async (zone) => {
      process.env.TZ = zone;
      const err = (await failure(adapter("limit", { resetTarget: async () => undefined }).dispatch("default", "hi"))) as ProviderDeferError;
      expect(err.retryAt.toISOString()).toBe("2026-10-17T16:00:00.000Z");
    });

    it("the epoch form", async () => {
      const err = (await failure(adapter("limit-epoch").dispatch("default", "hi"))) as ProviderDeferError;
      expect(err.retryAt.toISOString()).toBe("2026-10-17T16:00:00.000Z");
    });

    it.each([
      ["UTC", "2026-10-17T19:00:00.000Z"],
      ["Asia/Kolkata", "2026-10-17T13:30:00.000Z"],
    ])("a time with no zone is read in this machine's zone (TZ=%s)", (zone, want) => {
      process.env.TZ = zone;
      expect(resetFromText("5-hour limit reached \u2219 resets 7pm", NOW)?.toISOString()).toBe(want);
    });

    it.each([
      ["resets 9am", "2026-10-18T09:00:00.000Z"],
      ["resets 12am", "2026-10-18T00:00:00.000Z"],
      ["resets 12pm", "2026-10-18T12:00:00.000Z"],
      ["resets 7:30pm (Europe/Kyiv)", "2026-10-17T16:30:00.000Z"],
      ["resets 7pm (Not/AZone)", undefined],
      ["resets 13pm", undefined],
    ])("resetFromText(%j) under TZ=UTC", (text, want) => {
      process.env.TZ = "UTC";
      expect(resetFromText(`Claude usage limit reached. ${text}`, NOW)?.toISOString()).toBe(want);
    });

    it("unparseable text and no target: now + 60 min", async () => {
      const err = (await failure(adapter("limit-bare").dispatch("default", "hi"))) as ProviderDeferError;
      expect(err.retryAt.toISOString()).toBe("2026-10-17T13:00:00.000Z");
    });

    it("a host reset that has passed is ignored: the text's time wins", async () => {
      const err = (await failure(
        adapter("limit", { resetTarget: resolver("2026-10-17T11:00:00.000Z", true) }).dispatch("default", "hi"),
      )) as ProviderDeferError;
      expect(err.retryAt.toISOString()).toBe("2026-10-17T16:00:00.000Z");
    });

    it("a time 1 min ahead is raised to now + 5 min", async () => {
      const err = (await failure(
        adapter("limit", { resetTarget: resolver("2026-10-17T12:01:00.000Z", true) }).dispatch("default", "hi"),
      )) as ProviderDeferError;
      expect(err.retryAt.toISOString()).toBe("2026-10-17T12:05:00.000Z");
    });

    it("a logged-out result still fails (no defer)", async () => {
      const err = await failure(adapter("logged-out", { resetTarget: resolver("2026-10-17T18:00:00.000Z", true) }).dispatch("default", "hi"));
      expect(err).not.toBeInstanceOf(ProviderDeferError);
    });
  });

  it("fails an exhausted budget with the subtype", async () => {
    const err = await failure(adapter("budget").dispatch("default", "hi"));
    expect(err.message).toContain("error_max_budget_usd");
    expect(err.message).toContain("budget_exhausted");
  });

  it("fails a non-JSON exit with the exit code and the stderr tail", async () => {
    const err = await failure(adapter("garbage").dispatch("default", "hi"));
    expect(err.message).toContain("exit 2");
    expect(err.message).toContain("boom");
  });

  it("fails a missing binary with the install hint", async () => {
    const err = await failure(
      adapter("success", { binaryPath: join(root, "no-such-claude") }).dispatch("default", "hi"),
    );
    expect(err.message).toContain("TIDEGAP_CLAUDE_BIN");
    expect(err.message).toContain("install Claude Code");
    expect(err).not.toHaveProperty("code");
    expect(scratchDirs()).toEqual([]);
  });

  it("fails without a binary path", async () => {
    const err = await failure(new ClaudeCodeAdapter().dispatch("default", "hi"));
    expect(err.message).toContain("TIDEGAP_CLAUDE_BIN");
  });

  it("times out, kills the child and cleans up", async () => {
    const err = await failure(adapter("sleep", { timeoutMs: 200 }).dispatch("default", "hi"));
    expect(err.message).toContain("timed out");
    const pid = Number(logged("pid").trim());
    expect(() => process.kill(pid, 0)).toThrow();
    expect(scratchDirs()).toEqual([]);
  });

  it("on timeout, also kills what the child started", async () => {
    // The timeout leaves slack for a slow runner to start the shell and its
    // grandchild; a pid file that is missing or half-written must not read as 0
    // (kill(0, 0) signals our own group and always succeeds).
    const err = await failure(adapter("group", { timeoutMs: 2000 }).dispatch("default", "hi"));
    expect(err.message).toContain("timed out");
    const grandchild = Number(logged("grandchild").trim());
    expect(grandchild).toBeGreaterThan(1);
    // The group dies after the signal lands, not at the instant dispatch rejects.
    const deadline = Date.now() + 5000;
    while (isAlive(grandchild) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(isAlive(grandchild)).toBe(false);
    expect(scratchDirs()).toEqual([]);
  });

  it("throws ProviderRefusalError on a refusal", async () => {
    const err = await failure(adapter("refusal").dispatch("haiku", "hi"));
    expect(err).toBeInstanceOf(ProviderRefusalError);
    expect((err as ProviderRefusalError).provider).toBe("claude-code");
  });

  it("falls back to the requested model when modelUsage is empty", async () => {
    expect((await adapter("empty-usage").dispatch("haiku", "hi")).model).toBe("haiku");
    expect((await adapter("empty-usage").dispatch("default", "hi")).model).toBe("claude-code");
  });

  it("rejects a prompt over 10 MB before spawning", async () => {
    const err = await failure(adapter("success").dispatch("default", "x".repeat(10 * 1024 * 1024 + 1)));
    expect(err.message).toContain("10 MB");
    expect(existsSync(log)).toBe(false);
    expect(scratchDirs()).toEqual([]);
  });
});

describe("ClaudeCodeAdapter with an origin session (KTD6-KTD11)", () => {
  const ORIGIN_ID = "d76db676-78da-4dca-b20e-1328074e7009";
  const FORK_ID = "f1a2b3c4-5d6e-4f70-8a9b-0c1d2e3f4a5b";
  const TRANSCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "transcripts");
  let app: string;

  beforeEach(() => {
    app = join(root, "app");
    mkdirSync(app);
  });

  const origin = (over: Partial<NonNullable<DispatchOptions["origin"]>> = {}) => ({
    sessionId: ORIGIN_ID,
    cwd: app,
    agent: "claude-code" as const,
    transcriptPath: join(TRANSCRIPTS, "small.jsonl"),
    ...over,
  });
  const nth = (name: string, n: number) => readFileSync(join(log, `${name}.${n}`), "utf8");
  const calls = () => Number(logged("calls").trim());
  const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

  it("forks the session in its directory with read-only file tools scoped there", async () => {
    const r = await adapter("success").dispatch("default", "quote the word", { origin: origin() });
    const args = argv();
    expect(args).toEqual([
      "-p",
      "--output-format", "json",
      "--tools", "Read,Grep,Glob",
      "--allowedTools", `Read(/${app}/**)`,
      "--permission-mode", "dontAsk",
      "--max-budget-usd", "3",
      "--safe-mode",
      "--strict-mcp-config",
      "--resume", ORIGIN_ID,
      "--fork-session",
    ]);
    expect(args).not.toContain("--no-session-persistence");
    expect(args).not.toContain("--bare");
    expect(args.join("\n")).not.toContain("quote the word");
    expect(logged("stdin")).toBe("quote the word");
    expect(logged("cwd").trim()).toBe(app);
    expect(scratchDirs()).toEqual([]);
    expect(r.session).toEqual({ mode: "fork", sessionId: FORK_ID, originSessionId: ORIGIN_ID, contextTokens: 12_000 });
    expect(r.tools).toEqual(["Read", "Grep", "Glob"]);
    expect(r.text).toBe("The unique word is heron-42.");
    expect(r.model).toBe("claude-sonnet-5");
    expect(r.usage).toEqual({ inputTokens: 12_012, outputTokens: 30, totalTokens: 12_042 });
  });

  it("a fork with a system prompt removes its scratch dir", async () => {
    await adapter("success").dispatch("default", "hi", { origin: origin(), system: "be brief" });
    expect(logged("system")).toBe("be brief");
    expect(logged("cwd").trim()).toBe(app);
    expect(scratchDirs()).toEqual([]);
  });

  it("AE3: a session above the cap runs fresh in its directory with the header", async () => {
    const r = await adapter("success").dispatch("default", "quote the word", {
      origin: origin({ transcriptPath: join(TRANSCRIPTS, "large.jsonl") }),
    });
    const args = argv();
    expect(args).not.toContain("--resume");
    expect(after(args, "--tools")).toBe("Read,Grep,Glob");
    expect(after(args, "--max-budget-usd")).toBe("1");
    expect(args).toContain("--no-session-persistence");
    const stdin = logged("stdin");
    expect(stdin.startsWith(`This task was queued from a Claude Code session in ${app}.`)).toBe(true);
    expect(stdin).toContain("session too large (about 620k tokens)");
    expect(stdin.endsWith("quote the word")).toBe(true);
    expect(logged("cwd").trim()).toBe(app);
    expect(r.session).toEqual({
      mode: "fresh",
      reason: "too-large",
      sessionId: "0b6f2c1e-5d1a-4c0e-9a51-3f7e8d2c4b10",
      originSessionId: ORIGIN_ID,
      contextTokens: 620_000,
    });
  });

  it("AE4: web tools run fresh in a scratch dir", async () => {
    const r = await adapter("success").dispatch("default", "search", { origin: origin(), tools: ["WebSearch", "WebFetch"] });
    const args = argv();
    expect(args).not.toContain("--resume");
    expect(after(args, "--allowedTools")).toBe("WebSearch,WebFetch");
    expect(dirname(logged("cwd").trim())).toBe(root);
    expect(logged("stdin")).toContain("reason: web tools");
    expect(r.session).toMatchObject({ mode: "fresh", reason: "web-tools" });
    expect(scratchDirs()).toEqual([]);
  });

  it.each([
    ["in the JSON result", "dead0000-0000-4000-8000-000000000000"],
    ["on stderr with no JSON", "0de00000-0000-4000-8000-000000000000"],
  ])("No conversation found %s reruns once fresh as session-missing", async (_how, id) => {
    const r = await adapter("success").dispatch("default", "hi", {
      origin: origin({ sessionId: id, transcriptPath: undefined }),
    });
    expect(calls()).toBe(2);
    expect(nth("argv", 1)).toContain("--resume");
    expect(nth("argv", 2)).not.toContain("--resume");
    expect(nth("stdin", 2)).toContain("reason: the session transcript is gone");
    expect(r.text).toBe("OK");
    expect(r.session).toMatchObject({ mode: "fresh", reason: "session-missing", originSessionId: id });
  });

  it("a deleted directory runs fresh as cwd-missing", async () => {
    const r = await adapter("success").dispatch("default", "hi", { origin: origin({ cwd: join(root, "gone") }) });
    expect(argv()).not.toContain("--resume");
    expect(dirname(logged("cwd").trim())).toBe(root);
    expect(r.session).toMatchObject({ mode: "fresh", reason: "cwd-missing" });
  });

  it.each([
    ["the root directory", () => "/"],
    ["the home directory", () => app],
  ])("%s runs fresh as cwd-unsafe, outside it", async (_what, cwd) => {
    const r = await adapter("success", { resume: { ...resumeSettings({}), home: app } }).dispatch("default", "hi", {
      origin: origin({ cwd: cwd() }),
    });
    expect(argv()).not.toContain("--resume");
    expect(argv()).not.toContain("--allowedTools");
    expect(dirname(logged("cwd").trim())).toBe(root);
    expect(r.session).toMatchObject({ mode: "fresh", reason: "cwd-unsafe" });
  });

  it("a session id that is not a UUID never reaches --resume", async () => {
    const r = await adapter("success").dispatch("default", "hi", {
      origin: origin({ sessionId: "--dangerously-skip-permissions" }),
    });
    expect(argv()).not.toContain("--resume");
    expect(argv()).not.toContain("--dangerously-skip-permissions");
    expect(r.session).toMatchObject({ mode: "fresh", reason: "no-origin" });
  });

  it("a fork whose answer quotes 'No conversation found' keeps its answer", async () => {
    const r = await adapter("fork-quotes").dispatch("default", "hi", { origin: origin() });
    expect(calls()).toBe(1);
    expect(r.text).toContain("No conversation found");
    expect(r.session).toMatchObject({ mode: "fork", sessionId: FORK_ID });
  });

  it("TIDEGAP_RESUME=off runs fresh as disabled", async () => {
    const r = await adapter("success", { resume: resumeSettings({ resume: "off" }) }).dispatch("default", "hi", {
      origin: origin(),
    });
    expect(argv()).not.toContain("--resume");
    expect(logged("stdin")).toBe("hi");
    expect(r.session).toMatchObject({ mode: "fresh", reason: "disabled" });
  });

  it("a task without an origin keeps today's argv and has no session", async () => {
    const r = await adapter("success").dispatch("default", "hi");
    expect(argv()).toContain("--no-session-persistence");
    expect(after(argv(), "--tools")).toBe("WebSearch,WebFetch");
    expect(r.session).toBeUndefined();
  });

  it("fails a fork that reports the origin's own session id", async () => {
    const err = await failure(adapter("fork-same").dispatch("default", "hi", { origin: origin() }));
    expect(err.message).toContain(ORIGIN_ID);
    expect(err.message).toMatch(/same session id/);
  });

  it("a usage limit in a fork still defers the task", async () => {
    const err = await failure(adapter("limit").dispatch("default", "hi", { origin: origin() }));
    expect(argv()).toContain("--resume");
    expect(err).toBeInstanceOf(ProviderDeferError);
  });

  it("a directory with rule syntax in its name gets no Read rule", async () => {
    const odd = join(root, "my app (copy)");
    mkdirSync(odd);
    await adapter("success").dispatch("default", "hi", { origin: origin({ cwd: odd }) });
    expect(argv()).not.toContain("--allowedTools");
    expect(after(argv(), "--tools")).toBe("Read,Grep,Glob");
  });
});
