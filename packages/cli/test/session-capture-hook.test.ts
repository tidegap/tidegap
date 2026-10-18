import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "..", "..", "claude-code-plugin", "hooks", "session-capture.sh");
const INPUT = join(here, "fixtures", "hook-input");
const FIRST = "d76db676-78da-4dca-b20e-1328074e7009";
const SECOND = "aa11bb22-0000-4000-8000-000000000001";

/**
 * A fake `ps` that answers from $FAKE_PS_TABLE ("pid ppid comm" lines). The
 * row `*` answers for any pid not listed (the script's real parent pid).
 */
const FAKE_PS = `#!/bin/sh
fields=; pid=
while [ $# -gt 0 ]; do
  case $1 in
    -o) fields=$2; shift 2 ;;
    -p) pid=$2; shift 2 ;;
    *) shift ;;
  esac
done
row=$(awk -v p="$pid" '$1 == p { print; exit }' "$FAKE_PS_TABLE")
if [ "$fields" = "pid=" ]; then
  [ -n "$row" ] || exit 1
  echo "$pid"
  exit 0
fi
[ -n "$row" ] || row=$(awk '$1 == "*" { print; exit }' "$FAKE_PS_TABLE")
[ -n "$row" ] || exit 1
echo "$row" | awk '{ $1 = ""; sub(/^ /, ""); print }'
`;

let root: string;
let home: string;
let bin: string;
let table: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tidegap-capture-hook-"));
  home = join(root, "home");
  bin = join(root, "bin");
  mkdirSync(home);
  mkdirSync(bin);
  writeFileSync(join(bin, "ps"), FAKE_PS);
  chmodSync(join(bin, "ps"), 0o755);
  table = join(root, "ps-table");
  // The hook's shell (any pid) -> sh 300 -> claude 200.
  setChain(["* 300 sh", "300 200 sh", "200 1 /Users/u/.local/bin/claude"]);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function setChain(rows: string[]): void {
  writeFileSync(table, `${rows.join("\n")}\n`);
}

function hook(mode: "start" | "end", fixture: string, env: Record<string, string> = {}) {
  const out = spawnSync("sh", [SCRIPT, mode], {
    input: readFileSync(join(INPUT, fixture), "utf8"),
    encoding: "utf8",
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, FAKE_PS_TABLE: table, CLAUDE_PROJECT_DIR: "/work/app", ...env },
  });
  return { code: out.status, stdout: out.stdout, stderr: out.stderr };
}

const sessions = () => join(home, ".tidegap", "sessions");
const capture = (pid: number) => join(sessions(), `claude-${pid}.json`);
const read = (pid: number) => JSON.parse(readFileSync(capture(pid), "utf8")) as Record<string, unknown>;

describe("session-capture.sh", () => {
  it("passes sh -n", () => {
    expect(spawnSync("sh", ["-n", SCRIPT]).status).toBe(0);
  });

  it("start writes the capture file of the ancestor claude", () => {
    const r = hook("start", "startup.json");
    expect(r).toMatchObject({ code: 0, stdout: "" });
    const file = read(200);
    expect(file).toMatchObject({ v: 1, pid: 200, session_id: FIRST, project_dir: "/work/app" });
    expect(file.hook).toMatchObject({
      session_id: FIRST,
      transcript_path: `/home/u/.claude/projects/-work-app/${FIRST}.jsonl`,
      cwd: "/work/app/sub",
      source: "startup",
    });
    expect(typeof file.written_at).toBe("string");
  });

  it("writes the file 0600 in a 0700 directory and leaves no temp file", () => {
    hook("start", "startup.json");
    expect(statSync(capture(200)).mode & 0o777).toBe(0o600);
    expect(statSync(sessions()).mode & 0o777).toBe(0o700);
    expect(readdirSync(sessions())).toEqual(["claude-200.json"]);
  });

  it("escapes the project directory as JSON text", () => {
    hook("start", "startup.json", { CLAUDE_PROJECT_DIR: '/work/a "b"\\c' });
    expect(read(200).project_dir).toBe('/work/a "b"\\c');
  });

  it("start after /clear replaces the content for the same pid", () => {
    hook("start", "startup.json");
    hook("start", "clear.json");
    expect(read(200)).toMatchObject({ session_id: SECOND, hook: { source: "clear" } });
  });

  it("end with the file's session deletes it and leaves another pid's file alone", () => {
    hook("start", "startup.json");
    setChain(["* 300 sh", "300 201 sh", "201 1 claude", "200 1 claude"]);
    hook("start", "clear.json");
    setChain(["* 300 sh", "300 200 sh", "200 1 claude", "201 1 claude"]);
    const r = hook("end", "end.json");
    expect(r).toMatchObject({ code: 0, stdout: "" });
    expect(existsSync(capture(200))).toBe(false);
    expect(read(201).session_id).toBe(SECOND);
  });

  it("an end for the old session after /clear keeps the new one", () => {
    hook("start", "startup.json");
    hook("start", "clear.json");
    hook("end", "end.json");
    expect(read(200).session_id).toBe(SECOND);
  });

  it("writes nothing when no claude is within 6 levels", () => {
    setChain(["* 301 sh", "301 302 sh", "302 303 sh", "303 304 sh", "304 305 sh", "305 306 sh", "306 307 sh", "307 1 claude"]);
    const r = hook("start", "startup.json");
    expect(r).toMatchObject({ code: 0, stdout: "" });
    expect(existsSync(sessions())).toBe(false);
  });

  it("malformed stdin exits 0 silently and writes nothing", () => {
    const r = hook("start", "malformed.txt");
    expect(r).toMatchObject({ code: 0, stdout: "" });
    expect(existsSync(capture(200))).toBe(false);
    expect(hook("end", "malformed.txt")).toMatchObject({ code: 0, stdout: "" });
  });

  it("removes a stale file whose pid no longer runs", () => {
    mkdirSync(sessions(), { recursive: true });
    writeFileSync(join(sessions(), "claude-999.json"), "{}");
    hook("start", "startup.json");
    expect(readdirSync(sessions()).sort()).toEqual(["claude-200.json"]);
  });

  it("never prints to stdout, even without HOME or ps", () => {
    expect(hook("start", "startup.json", { HOME: "" }).stdout).toBe("");
    const r = spawnSync("/bin/sh", [SCRIPT, "start"], {
      input: readFileSync(join(INPUT, "startup.json"), "utf8"),
      encoding: "utf8",
      env: { PATH: "/nonexistent", HOME: home },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });
});
