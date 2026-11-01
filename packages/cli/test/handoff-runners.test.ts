/**
 * The runners on handed-off rows: the command adapter runs a one-off
 * command the user queued and nothing else, and the claude-code adapter
 * runs a task that names another folder fresh there, with the origin
 * header, and never with a tool that runs commands or writes files.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_JOB_CAPS, type DispatchOptions } from "@tidegap/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ClaudeCodeAdapter } from "../src/providers/claude-code.js";
import { CommandAdapter } from "../src/providers/command.js";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-claude", "claude");
const TRANSCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "transcripts");
const ORIGIN_ID = "d76db676-78da-4dca-b20e-1328074e7009";
/** Built at run time: a vendor key shape, not a key. */
const KEY_SHAPE = ["sk", "proj", "handofffixture".repeat(3)].join("-");

let root: string;
let log: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "tidegap-handoff-runners-")));
  log = join(root, "log");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function failure(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the dispatch to fail");
}

describe("the command adapter on a one-off row", () => {
  const adapter = (env: Record<string, string> = { PATH: "/usr/bin:/bin", HOME: "/nonexistent" }) =>
    new CommandAdapter({
      adapters: {},
      jobRunner: () => undefined,
      readSecrets: () => ({ values: {}, missing: [] }),
      env,
      home: root,
    });
  const oneOff = (run: string, cwd: string, extra: Partial<NonNullable<DispatchOptions["command"]>> = {}): DispatchOptions => ({
    command: { run, cwd, secrets: [], origin: "cli", ...extra },
    caps: { ...DEFAULT_JOB_CAPS },
  });

  it("a one-off command row runs in its cwd with the minimal environment and returns its scrubbed stdout", async () => {
    const work = join(root, "work");
    mkdirSync(work);
    const env = { PATH: "/usr/bin:/bin", HOME: root, LANG: "C", OPENAI_API_KEY: KEY_SHAPE, TIDEGAP_DEFAULT_REGION: "DE" };
    const r = await adapter(env).dispatch("none", "", oneOff(`pwd; env; echo "token ${KEY_SHAPE}"`, work));
    expect(r.text.split("\n")[0]).toBe(work);
    expect(r.text).not.toMatch(/OPENAI_API_KEY|TIDEGAP_/);
    expect(r.text).toContain(`HOME=${root}`);
    expect(r.text).not.toContain(KEY_SHAPE);
    expect(r.text).toContain("token [REDACTED]");
    expect(r).toMatchObject({ provider: "command", model: "none", details: { steps: ["command"] } });
  });

  it("a command row with no job id and no origin cli is refused before anything runs", async () => {
    const marker = join(root, "ran");
    const err = await failure(adapter().dispatch("none", "", oneOff(`touch ${marker}`, root, { origin: undefined })));
    expect(err.message).toMatch(/not a run of a job or a one-off command queued with tidegap queue add/);
    expect(existsSync(marker)).toBe(false);
  });

  it("the command text reaches /bin/sh -c as one argument; cwd and result_path never appear in argv", async () => {
    const work = join(root, "work dir");
    mkdirSync(work);
    const run = `echo "$#"; ps -o args= -p $$`;
    const r = await adapter().dispatch("none", "", oneOff(run, work));
    const [count, args] = r.text.split("\n");
    expect(count).toBe("0");
    expect(args).toBe(`/bin/sh -c ${run}`);
    expect(args).not.toContain(work);
  });

  it("a one-off whose folder was removed after enqueue fails with the path", async () => {
    const gone = join(root, "gone");
    const err = await failure(adapter().dispatch("none", "", oneOff("echo hi", gone)));
    expect(err.message).toBe(`command: working directory ${gone} does not exist`);
  });
});

describe("the claude-code adapter on a handoff row", () => {
  let app: string;
  let work: string;
  beforeEach(() => {
    app = join(root, "app");
    work = join(root, "work");
    mkdirSync(app);
    mkdirSync(work);
  });

  const adapter = () =>
    new ClaudeCodeAdapter({
      binaryPath: FAKE,
      env: { PATH: "/usr/bin:/bin", FAKE_CLAUDE_MODE: "success", FAKE_CLAUDE_LOG: log },
      scratchRoot: root,
    });
  const origin = () => ({ sessionId: ORIGIN_ID, cwd: app, agent: "claude-code" as const, transcriptPath: join(TRANSCRIPTS, "small.jsonl") });
  const argv = (): string[] => readFileSync(join(log, "argv"), "utf8").split("\n").slice(0, -1);
  const logged = (name: string): string => readFileSync(join(log, name), "utf8");

  it("a claude-code handoff run in another cwd gets --tools Read,Grep,Glob, Read(//<cwd>/**), dontAsk, no --resume, the origin header on stdin, and session fresh other-cwd", async () => {
    const r = await adapter().dispatch("default", "review the change", { origin: origin(), cwd: work, tools: ["Read", "Grep", "Glob"] });
    const args = argv();
    expect(args).toEqual([
      "-p",
      "--output-format", "json",
      "--tools", "Read,Grep,Glob",
      "--allowedTools", `Read(/${work}/**)`,
      "--permission-mode", "dontAsk",
      "--max-budget-usd", "1",
      "--safe-mode",
      "--strict-mcp-config",
      "--no-session-persistence",
    ]);
    expect(args).not.toContain("--resume");
    expect(logged("cwd").trim()).toBe(work);
    expect(logged("stdin")).toBe(
      `This task was queued from a Claude Code session in ${app}. It runs in a fresh session without that conversation ` +
        "(reason: the task names another folder), so work from the task text alone.\n\nTask:\n\nreview the change",
    );
    expect(r.session).toMatchObject({ mode: "fresh", reason: "other-cwd", originSessionId: ORIGIN_ID });
    expect(r.tools).toEqual(["Read", "Grep", "Glob"]);
  });

  it("a claude-code handoff run whose cwd is the session's project folder still forks", async () => {
    const r = await adapter().dispatch("default", "hi", { origin: origin(), cwd: app, tools: ["Read", "Grep", "Glob"] });
    expect(argv()).toContain("--resume");
    expect(r.session).toMatchObject({ mode: "fork", originSessionId: ORIGIN_ID });
  });

  it("a claude-code handoff run with profile web gets the web tools in a fresh temporary directory", async () => {
    const r = await adapter().dispatch("default", "search", { origin: origin(), tools: ["WebSearch", "WebFetch"] });
    const args = argv();
    expect(args.slice(3, 7)).toEqual(["--tools", "WebSearch,WebFetch", "--allowedTools", "WebSearch,WebFetch"]);
    expect(args).not.toContain("--resume");
    const ranIn = logged("cwd").trim();
    expect(ranIn).not.toBe(app);
    expect(ranIn.startsWith(join(root, "tidegap-claude-"))).toBe(true);
    expect(r.session).toMatchObject({ mode: "fresh", reason: "web-tools" });
  });

  it("a claude-code handoff run never gets Bash, Write or Edit even when the stored tools name them", async () => {
    for (const tools of [["Read", "Bash"], ["Write"], ["Edit", "Grep"]]) {
      const err = await failure(adapter().dispatch("default", "hi", { origin: origin(), cwd: work, tools }));
      expect(err.message).toMatch(/not allowed/);
    }
    expect(existsSync(join(log, "argv"))).toBe(false);
  });

  it("a claude-code handoff run whose cwd was removed after enqueue fails with the path", async () => {
    const gone = join(root, "gone");
    const withOrigin = await failure(adapter().dispatch("default", "hi", { origin: origin(), cwd: gone, tools: [] }));
    expect(withOrigin.message).toBe(`claude-code: cwd ${gone} is not an existing folder`);
    const noOrigin = await failure(adapter().dispatch("default", "hi", { cwd: gone, tools: [] }));
    expect(noOrigin.message).toBe(`claude-code: cwd ${gone} is not an existing folder`);
    expect(existsSync(join(log, "argv"))).toBe(false);
  });
});
