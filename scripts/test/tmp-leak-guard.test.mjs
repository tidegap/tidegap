import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const GUARD = join(dirname(fileURLToPath(import.meta.url)), "tmp-leak-guard.mjs");

/** Runs the guard with its own temp dir, so the test leaves nothing behind. */
function guard(args, fn) {
  const tmp = mkdtempSync(join(tmpdir(), "tidegap-guard-test-"));
  try {
    const r = spawnSync(process.execPath, [GUARD, ...args], { encoding: "utf8", env: { ...process.env, TMPDIR: tmp } });
    return fn(r, tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const node = (code) => ["--", process.execPath, "-e", code];
const mk = (name) => `require("node:fs").mkdirSync(require("node:path").join(require("node:os").tmpdir(), ${JSON.stringify(name)}))`;

test("a clean command passes and removes the sandbox", () => {
  guard(node(mk("other-cache")), (r, tmp) => {
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /before 0, after 0, new 0/);
    const sandbox = /\((.+)\)/.exec(r.stdout)[1];
    assert.ok(sandbox.startsWith(tmp));
    assert.equal(existsSync(sandbox), false);
  });
});

test("a leaked tidegap entry fails and stays for inspection; lock files are ignored", () => {
  guard(node(`${mk("tidegap-test-home-x")}; ${mk("tidegap-build.lock")}`), (r) => {
    assert.equal(r.status, 1);
    assert.match(r.stdout, /new 1/);
    assert.match(r.stdout, /leaked: tidegap-test-home-x/);
    assert.ok(existsSync(join(/\((.+)\)/.exec(r.stdout)[1], "tidegap-test-home-x")));
  });
});

test("the command's own failure is passed through", () => {
  guard(node("process.exit(3)"), (r) => assert.equal(r.status, 3));
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  test(`${signal} to the guard stops the command, then reports and removes a clean sandbox`, async () => {
    const tmp = mkdtempSync(join(tmpdir(), "tidegap-guard-test-"));
    try {
      const args = node('console.log("ready"); setTimeout(() => {}, 30_000)');
      const child = spawn(process.execPath, [GUARD, ...args], { env: { ...process.env, TMPDIR: tmp } });
      let stdout = "";
      let sent = false;
      child.stdout.on("data", (d) => {
        stdout += d;
        if (!sent && stdout.includes("ready")) sent = child.kill(signal);
      });
      const status = await new Promise((resolve) => child.once("close", (code) => resolve(code)));
      assert.equal(status, 128 + constants.signals[signal], stdout);
      assert.match(stdout, /before 0, after 0, new 0/);
      assert.equal(existsSync(/\((.+)\)/.exec(stdout)[1]), false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
}

test("snapshot and check compare tmpdir() across steps", () => {
  const tmp = mkdtempSync(join(tmpdir(), "tidegap-guard-test-"));
  try {
    const env = { ...process.env, TMPDIR: tmp };
    const run = (...a) => spawnSync(process.execPath, a, { encoding: "utf8", env });
    const state = join(tmp, "state.json.lock");
    assert.equal(run(GUARD, "snapshot", state).status, 0);
    assert.equal(run(GUARD, "check", state).status, 0);
    run("-e", mk("tidegap-count-x"));
    const r = run(GUARD, "check", state);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /before 0, after 1, new 1/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
