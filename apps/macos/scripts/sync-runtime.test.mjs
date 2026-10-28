// Tests for sync-runtime.sh (jobs leftovers plan U5, R8). Each test copies the
// script into a fake repo in a temp dir and runs it with HOME set to a temp
// dir and PATH stubs for pnpm and launchctl that log their arguments. Nothing
// reads or writes the real ~/.tidegap, and no real launchctl runs: launchd
// labels are per user, not per HOME.
// Run: node --test apps/macos/scripts/sync-runtime.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "sync-runtime.sh");
const UID = process.getuid();
const BUILD = "pnpm --filter @tidegap/core --filter @tidegap/cli build";

const REPO_CLI = {
  name: "@tidegap/cli",
  version: "0.19.0",
  dependencies: { "@tidegap/core": "workspace:*", commander: "^12.1.0" },
  peerDependencies: { openai: ">=4.70.0" },
  devDependencies: { vitest: "^2.0.0" },
};
const REPO_CORE = {
  name: "@tidegap/core",
  version: "0.19.0",
  optionalDependencies: { "better-sqlite3": "^11.5.0" },
  peerDependencies: { openai: ">=4.70.0" },
  devDependencies: { vitest: "^2.0.0" },
};
// What an installed runtime holds: core pinned to a version, no devDependencies.
const RUNTIME_CLI = { ...REPO_CLI, dependencies: { ...REPO_CLI.dependencies, "@tidegap/core": "0.19.0" }, devDependencies: undefined };
const RUNTIME_CORE = { ...REPO_CORE, devDependencies: undefined };

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function put(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function stub(file, body) {
  put(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
}

/** Relative path and content of every file under `dir`, sorted. */
function tree(dir, base = dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) tree(p, base, out);
    else out.push(`${p.slice(base.length + 1)}: ${readFileSync(p, "utf8")}`);
  }
  return out;
}

/** A temp dir with an empty HOME, a fake repo holding the script and a built tree, and the stubs. */
function sandbox(t, { repoCli = REPO_CLI, repoCore = REPO_CORE } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tidegap-sync-runtime-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const box = { dir, home: join(dir, "home"), repo: join(dir, "repo"), bin: join(dir, "bin"), log: join(dir, "calls.log") };
  mkdirSync(box.home);
  // The build must run in the repo: elsewhere --filter finds no workspace.
  const repoReal = join(realpathSync(dir), "repo");
  stub(
    join(box.bin, "pnpm"),
    `echo "pnpm $*" >> "${box.log}"
[ "$(pwd -P)" = "${repoReal}" ] || { echo "pnpm stub: run outside the repo" >&2; exit 99; }
exit "\${STUB_PNPM_EXIT:-0}"`,
  );
  // STUB_CHANNELS / STUB_TICK: what `launchctl print` shows for the unit; empty means not loaded.
  stub(
    join(box.bin, "launchctl"),
    `echo "launchctl $*" >> "${box.log}"
case "$1 $2" in
  "print "*/com.tidegap.channels) [ -n "\${STUB_CHANNELS:-}" ] || exit 113; echo "$STUB_CHANNELS" ;;
  "print "*/com.tidegap.tick) [ -n "\${STUB_TICK:-}" ] || exit 113; echo "$STUB_TICK" ;;
  "kickstart -k") exit "\${STUB_CHANNELS_KICKSTART_EXIT:-0}" ;;
  "kickstart "*/com.tidegap.tick) exit "\${STUB_TICK_KICKSTART_EXIT:-0}" ;;
esac`,
  );
  const r = box.repo;
  put(join(r, "apps/macos/scripts/sync-runtime.sh"), readFileSync(SCRIPT, "utf8"));
  put(join(r, "packages/cli/package.json"), json(repoCli));
  put(join(r, "packages/cli/dist/index.js"), "// new cli\n");
  put(join(r, "packages/cli/ui/index.html"), "<!-- new page -->\n");
  put(join(r, "packages/core-ts/package.json"), json(repoCore));
  put(join(r, "packages/core-ts/dist/index.js"), "// new core\n");
  const git = (...args) => {
    const g = spawnSync("git", ["-c", "init.defaultBranch=main", "-c", "user.name=QA", "-c", "user.email=qa@example.invalid", "-c", "commit.gpgsign=false", ...args], {
      cwd: r,
      encoding: "utf8",
      env: { HOME: box.home, PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1" },
    });
    assert.equal(g.status, 0, g.stderr);
    return g.stdout.trim();
  };
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "fake repo");
  box.sha = git("rev-parse", "--short", "HEAD");
  return box;
}

/** An installed runtime at `root` with files a sync must replace, delete or leave alone. */
function runtime(root, { cli = RUNTIME_CLI, core = RUNTIME_CORE, withCore = true } = {}) {
  put(join(root, "cli/package.json"), json(cli));
  // Sizes differ from the repo files: rsync skips a file whose size and mtime match.
  put(join(root, "cli/dist/index.js"), "// the installed cli\n");
  put(join(root, "cli/dist/old.js"), "// removed in the repo\n");
  put(join(root, "cli/ui/old.css"), "/* removed in the repo */\n");
  put(join(root, "cli/node_modules/commander/package.json"), json({ name: "commander", version: "12.1.0" }));
  if (withCore) {
    put(join(root, "cli/node_modules/@tidegap/core/package.json"), json(core));
    put(join(root, "cli/node_modules/@tidegap/core/dist/stale.js"), "// removed in the repo\n");
  }
  return root;
}

function run(box, args = [], env = {}) {
  const r = spawnSync("/bin/sh", [join(box.repo, "apps/macos/scripts/sync-runtime.sh"), ...args], {
    cwd: box.dir,
    encoding: "utf8",
    env: { HOME: box.home, PATH: `${box.bin}:${dirname(process.execPath)}:/usr/bin:/bin`, ...env },
  });
  const calls = existsSync(box.log) ? readFileSync(box.log, "utf8").trim().split("\n") : [];
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, calls };
}

const defaultRoot = (box) => join(box.home, ".tidegap/runtime");

test("refuses when the runtime dir is missing: names it, creates nothing, builds nothing", (t) => {
  const box = sandbox(t);
  const r = run(box);
  assert.equal(r.code, 1);
  assert.match(r.stderr, new RegExp(`no runtime at ${join(defaultRoot(box), "cli")}`));
  assert.deepEqual(readdirSync(box.home), []);
  assert.deepEqual(r.calls, []);
});

test("refuses when the runtime has no node_modules/@tidegap/core", (t) => {
  const box = sandbox(t);
  runtime(defaultRoot(box), { withCore: false });
  const before = tree(box.home);
  const r = run(box);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /cli\/node_modules\/@tidegap\/core; the runtime is incomplete/);
  assert.deepEqual(tree(box.home), before);
  assert.deepEqual(r.calls, []);
});

for (const [what, field, name, change] of [
  ["a dependency", "dependencies", "commander", (rt) => ({ cli: { ...rt.cli, dependencies: { ...rt.cli.dependencies, commander: "^11.0.0" } } })],
  ["an optional dependency", "optionalDependencies", "better-sqlite3", (rt) => ({ core: { ...rt.core, optionalDependencies: { "better-sqlite3": "^9.0.0" } } })],
  ["a peer dependency", "peerDependencies", "openai", (rt) => ({ cli: { ...rt.cli, peerDependencies: { openai: ">=4.0.0" } } })],
]) {
  test(`refuses when the runtime names another version of ${what}, before any build`, (t) => {
    const box = sandbox(t);
    runtime(defaultRoot(box), change({ cli: RUNTIME_CLI, core: RUNTIME_CORE }));
    const before = tree(box.home);
    const r = run(box);
    assert.equal(r.code, 1);
    assert.match(r.stderr, new RegExp(`${name} \\(${field}\\): repo `));
    assert.match(r.stderr, /reinstall the runtime/);
    assert.deepEqual(tree(box.home), before);
    assert.deepEqual(r.calls, []);
  });
}

test("refuses when the repo adds an @tidegap package other than core", (t) => {
  const box = sandbox(t, { repoCli: { ...REPO_CLI, dependencies: { ...REPO_CLI.dependencies, "@tidegap/extra": "workspace:*" } } });
  runtime(defaultRoot(box));
  const r = run(box);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /@tidegap\/extra \(dependencies\): repo workspace:\*, runtime none/);
  assert.deepEqual(r.calls, []);
});

test("passes the check when only devDependencies differ, then builds", (t) => {
  const box = sandbox(t);
  runtime(defaultRoot(box), { cli: { ...RUNTIME_CLI, devDependencies: { vitest: "^1.0.0" } } });
  const before = tree(box.home);
  // The stub build fails, so the run stops right after it.
  const r = run(box, [], { STUB_PNPM_EXIT: "7" });
  assert.equal(r.code, 7);
  assert.deepEqual(r.calls, [BUILD]);
  assert.deepEqual(tree(box.home), before);
});

test("syncs the four paths, restarts the listener, starts the tick, prints the commit", (t) => {
  const box = sandbox(t);
  // The runtime comes from the argument; the default under HOME stays empty.
  const root = runtime(join(box.dir, "rt"));
  const cli = join(root, "cli");
  const core = join(cli, "node_modules/@tidegap/core");
  const r = run(box, [root], {
    STUB_CHANNELS: `arguments = {\n  node\n  ${cli}/dist/index.js\n  channels\n}`,
    STUB_TICK: `arguments = {\n  node\n  ${cli}/dist/index.js\n  tick\n}`,
    STUB_TICK_KICKSTART_EXIT: "1",
  });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(tree(join(cli, "dist")), ["index.js: // new cli\n"]);
  assert.deepEqual(tree(join(cli, "ui")), ["index.html: <!-- new page -->\n"]);
  assert.deepEqual(tree(join(core, "dist")), ["index.js: // new core\n"]);
  assert.equal(readFileSync(join(core, "package.json"), "utf8"), json(REPO_CORE));
  assert.equal(readFileSync(join(cli, "package.json"), "utf8"), json(RUNTIME_CLI));
  assert.ok(existsSync(join(cli, "node_modules/commander/package.json")));
  assert.deepEqual(r.calls, [
    BUILD,
    `launchctl print gui/${UID}/com.tidegap.channels`,
    `launchctl kickstart -k gui/${UID}/com.tidegap.channels`,
    `launchctl print gui/${UID}/com.tidegap.tick`,
    `launchctl kickstart gui/${UID}/com.tidegap.tick`,
  ]);
  assert.match(r.stdout, /com\.tidegap\.channels: restarted/);
  // A failed tick kickstart is reported, not fatal.
  assert.match(r.stderr, new RegExp(`warning: launchctl kickstart gui/${UID}/com.tidegap.tick failed`));
  assert.doesNotMatch(r.stderr, /runs another tidegap/);
  assert.match(r.stdout, new RegExp(`synced commit: ${box.sha}\\n`));
  assert.match(r.stdout, /Quit and reopen the Mac app/);
  assert.deepEqual(readdirSync(box.home), []);
});

test("skips a unit that is not loaded, warns on a unit that runs another tidegap, marks a dirty tree", (t) => {
  const box = sandbox(t);
  // The runtime comes from TIDEGAP_RUNTIME_DIR.
  const root = runtime(join(box.dir, "rt"));
  put(join(box.repo, "packages/cli/src/new.ts"), "export {};\n");
  const r = run(box, [], { TIDEGAP_RUNTIME_DIR: root, STUB_TICK: "arguments = {\n  /usr/local/bin/tidegap\n  tick\n}" });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /com\.tidegap\.channels: not loaded, skipped/);
  assert.ok(!r.calls.some((c) => c.includes("kickstart -k")), r.calls.join("\n"));
  assert.match(r.stderr, /warning: com\.tidegap\.tick does not run .*; it runs another tidegap/);
  assert.match(r.stdout, /com\.tidegap\.tick: started/);
  assert.match(r.stdout, new RegExp(`synced commit: ${box.sha}-dirty\\n`));
});

test("a failed listener restart still starts the tick and prints the commit, then exits 1", (t) => {
  const box = sandbox(t);
  const root = runtime(join(box.dir, "rt"));
  const unit = `arguments = {\n  node\n  ${join(root, "cli")}/dist/index.js\n}`;
  const r = run(box, [root], { STUB_CHANNELS: unit, STUB_TICK: unit, STUB_CHANNELS_KICKSTART_EXIT: "1" });
  assert.equal(r.code, 1);
  assert.match(r.stderr, new RegExp(`kickstart -k gui/${UID}/com.tidegap.channels failed; the listener still runs the old code`));
  assert.ok(r.calls.includes(`launchctl kickstart gui/${UID}/com.tidegap.tick`), r.calls.join("\n"));
  assert.match(r.stdout, new RegExp(`synced commit: ${box.sha}\\n`));
});

test("a relative runtime dir does not hide a unit that runs another runtime with the same tail", (t) => {
  const box = sandbox(t);
  runtime(join(box.dir, "rt"));
  // run() starts the script in box.dir, so "rt" is the runtime above.
  const r = run(box, ["rt"], { STUB_TICK: "arguments = {\n  node\n  /opt/other/rt/cli/dist/index.js\n  tick\n}" });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /warning: com\.tidegap\.tick does not run .*; it runs another tidegap/);
});

test("the script holds no local path and no owner name (public repo)", () => {
  const text = readFileSync(SCRIPT, "utf8");
  assert.doesNotMatch(text, /\/Users\/|\/home\/|\/opt\/homebrew|\/private\//);
  assert.ok(!text.includes(homedir()), "the script names this machine's home directory");
  const name = userInfo().username;
  if (name.length > 2) assert.doesNotMatch(text, new RegExp(`\\b${name.replace(/[^\w]/g, "\\$&")}\\b`, "i"));
});
