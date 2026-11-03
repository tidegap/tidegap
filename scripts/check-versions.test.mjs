// Tests for scripts/check-versions.mjs (node --test).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./check-versions.mjs", import.meta.url));
const version = JSON.parse(
  readFileSync(new URL("../packages/core-ts/package.json", import.meta.url), "utf8"),
).version;
const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });

test("no --tag: lockstep check only", () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /tag/);
});

test("--tag v<version> passes", () => {
  const r = run("--tag", `v${version}`);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(`tag v${version} matches`), r.stdout);
});

test("--tag=v<version> passes", () => {
  assert.equal(run(`--tag=v${version}`).status, 0);
});

test("a different version fails and names both", () => {
  const r = run("--tag", "v0.0.0");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /tag v0\.0\.0 does not match v/);
});

test("--tag=<other> fails", () => {
  assert.equal(run("--tag=v0.0.0").status, 1);
});

test("a tag without the v prefix fails", () => {
  assert.equal(run("--tag", version).status, 1);
});

test("--tag with no value fails", () => {
  assert.equal(run("--tag").status, 1);
  assert.equal(run("--tag", "--other").status, 1);
  assert.equal(run("--tag=").status, 1);
});

test("a misspelled or repeated tag option fails", () => {
  assert.equal(run("--tags", `v${version}`).status, 1);
  assert.equal(run("--tag", `v${version}`, "--tag", `v${version}`).status, 1);
});

// The Mac app follows the lockstep through MARKETING_VERSION. The script
// resolves the repo from its own path, so a copy in a temp tree checks that tree.
const VERSIONED = [
  "scripts/check-versions.mjs",
  "packages/core-ts/package.json",
  "packages/cli/package.json",
  "packages/mcp-server/package.json",
  "packages/mcp-server/server.json",
  "packages/openclaw-plugin/package.json",
  "packages/openclaw-plugin/openclaw.plugin.json",
  "packages/claude-code-plugin/.claude-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
  "packages/core-py/pyproject.toml",
  "README.md",
  "CHANGELOG.md",
  "apps/macos/Config/Base.xcconfig",
  "apps/web/public/llms.txt",
];
const repo = fileURLToPath(new URL("..", import.meta.url));

/** Runs a temp copy of the versioned files after `edit` rewrites the text of `path`. */
function runCopyWith(path, edit) {
  const tree = mkdtempSync(join(tmpdir(), "tidegap-check-versions-"));
  try {
    for (const p of VERSIONED) cpSync(join(repo, p), join(tree, p), { recursive: false });
    const file = join(tree, path);
    writeFileSync(file, edit(readFileSync(file, "utf8")));
    return spawnSync(process.execPath, [join(tree, "scripts/check-versions.mjs")], { encoding: "utf8" });
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
}

const runCopy = (marketingVersion) =>
  runCopyWith("apps/macos/Config/Base.xcconfig", (text) =>
    text.replace(/^MARKETING_VERSION = \S+$/m, `MARKETING_VERSION = ${marketingVersion}`),
  );
const runLlms = (release) =>
  runCopyWith("apps/web/public/llms.txt", (text) => text.replace(/^Current release: \S+?\.(?=\s|$)/m, `Current release: ${release}.`));

test("MARKETING_VERSION equal to the core version passes", () => {
  const r = runCopy(version);
  assert.equal(r.status, 0, r.stderr);
});

test("MARKETING_VERSION that differs fails and names the xcconfig", () => {
  const r = runCopy("0.0.1");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /apps\/macos\/Config\/Base\.xcconfig \(MARKETING_VERSION\): 0\.0\.1/);
});

test("the llms.txt Current release line equal to the core version passes", () => {
  const r = runLlms(version);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /everywhere \(14 files\)/);
});

test("an llms.txt Current release line that differs fails and names llms.txt", () => {
  const r = runLlms("0.0.1");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /apps\/web\/public\/llms\.txt \(Current release line\): 0\.0\.1/);
});

test("an llms.txt without the Current release line fails as not found", () => {
  const r = runCopyWith("apps/web/public/llms.txt", (text) => text.replace(/^Current release: /m, "Release: "));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /apps\/web\/public\/llms\.txt \(Current release line\): \(not found\)/);
});
