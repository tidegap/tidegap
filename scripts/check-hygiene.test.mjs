// Tests for scripts/check-hygiene.mjs (node --test).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./check-hygiene.mjs", import.meta.url));
// Forbidden values, assembled from parts so this file never matches the check.
const ID = ["d76d", "b676"].join("");
const TRAILER = ["Claude-", "Session:"].join("");
const LINK = ["claude.ai/", "code/session"].join("");

// The script resolves the repo from its own path, so a copy in a temp tree
// checks that tree. HOME and the config variables keep the user's git config out.
function run(files, { untracked = {}, init = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "hygiene-test-"));
  try {
    const env = { ...process.env, HOME: dir, XDG_CONFIG_HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_CEILING_DIRECTORIES: dirname(dir) };
    for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[key];
    const write = (entries) => {
      for (const [path, body] of Object.entries(entries)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), body);
      }
    };
    mkdirSync(join(dir, "scripts"));
    cpSync(script, join(dir, "scripts", "check-hygiene.mjs"));
    write(files);
    if (init) {
      const git = (...args) => assert.equal(spawnSync("git", args, { cwd: dir, env }).status, 0, `git ${args[0]}`);
      git("init", "-q");
      git("add", "-A");
    }
    write(untracked);
    return spawnSync(process.execPath, [join(dir, "scripts", "check-hygiene.mjs")], { cwd: dir, env, encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a clean tree prints PASS and exits 0", () => {
  const r = run({ "a.txt": "id 11111111-2222-4333-8444-555555555555\n" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "PASS");
});

test("a hit in a tracked file prints path:line and exits 1", () => {
  const r = run({ "a.txt": `clean\nid ${ID}-78da\n` });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^ {2}a\.txt:2$/m);
  assert.doesNotMatch(r.stderr, /78da/, "the matched line is not printed");
});

test("case is ignored", () => {
  assert.equal(run({ "a.txt": `id ${ID.toUpperCase()}\n` }).status, 1);
});

test("a binary file is searched", () => {
  const r = run({ "a.bin": Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(`"originSessionId":"${ID}"`)]) });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /a\.bin/);
});

test("a hit in a file name is reported", () => {
  const r = run({ [`sessions/${ID}-78da.jsonl`]: "{}\n" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, new RegExp(`sessions/${ID}-78da\\.jsonl`));
});

test("a session trailer and a session link fail", () => {
  assert.equal(run({ "msg.txt": `${TRAILER} x\n` }).status, 1);
  assert.equal(run({ "plan.md": `see https://${LINK}_x\n` }).status, 1);
});

test("an untracked file is not searched", () => {
  assert.equal(run({}, { untracked: { "u.txt": `id ${ID}\n` } }).status, 0);
});

test("outside a git repo it exits 2", () => {
  const r = run({}, { init: false });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /git ls-files failed/);
});
