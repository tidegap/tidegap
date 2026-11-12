#!/usr/bin/env node
/**
 * Public-repo hygiene check, run by `pnpm preflight` and CI.
 *
 * Searches the path and the content of every tracked file (binary files
 * included, case ignored) for values that must never be committed again,
 * and exits 1 with one `path:line` or path per hit; prints PASS otherwise.
 * It also fails on a merge conflict marker (a line that starts with seven
 * `<` or seven `>` and a space): an agent rebase once committed one, and a
 * marker in a Markdown or JSON file fails no build step.
 * Untracked files are not searched. Tests: scripts/check-hygiene.test.mjs.
 * The rules behind it: docs/solutions/workflow-issues/public-repo-hygiene.md.
 * Dependency-free (Node built-ins and git).
 *
 * Each pattern is assembled from parts so this file never matches itself.
 * The parts still name the value: the check stops new copies, and it does
 * not hide a value that is already in the public history.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

const FORBIDDEN = [
  {
    pattern: ["d76d", "b676"].join(""),
    why: "a non-synthetic session id; use 11111111-2222-4333-8444-555555555555 in fixtures",
  },
  {
    pattern: ["019e", "4c85"].join(""),
    why: "a non-synthetic Codex session id; use a synthetic id such as 00000000-0000-4000-8000-000000000002",
  },
  {
    pattern: ["Claude-", "Session:"].join(""),
    why: "a session trailer; committed files carry no session attribution",
  },
  {
    pattern: ["claude.ai/", "code/session"].join(""),
    why: "a session link; committed files carry no session links",
  },
];

/** Runs git in the repo; exits 2 on any failure except `git grep` finding nothing (1). */
function git(args) {
  const res = spawnSync("git", args, { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (res.status === 0 || (res.status === 1 && args[0] === "grep")) return res;
  console.error(`check-hygiene: git ${args[0]} failed: ${res.stderr?.trim() || res.error}`);
  process.exit(2);
}

const paths = git(["ls-files", "-z"]).stdout.split("\0").filter(Boolean);

let failed = false;
for (const { pattern, why } of FORBIDDEN) {
  const needle = pattern.toLowerCase();
  const hits = new Set(paths.filter((p) => p.toLowerCase().includes(needle)));
  // -o prints the match, not the whole line, so a long or binary line stays
  // small; a binary file prints as "Binary file <path> matches".
  const res = git(["grep", "-n", "-o", "-i", "-F", "-e", pattern]);
  if (res.status === 0) {
    for (const line of res.stdout.trimEnd().split("\n")) hits.add(line.split(":", 2).join(":"));
  }
  if (hits.size === 0) continue;
  failed = true;
  console.error(`check-hygiene: ${why}`);
  for (const hit of hits) console.error(`  ${hit}`);
}

// Written as a quantifier so this file never matches itself. -I skips binary files.
const markers = git(["grep", "-n", "-I", "-E", "-e", "^(<{7}|>{7}) "]);
if (markers.status === 0) {
  failed = true;
  console.error("check-hygiene: a merge conflict marker; resolve the conflict (a generated file: take main's side and run its generator)");
  for (const line of markers.stdout.trimEnd().split("\n")) console.error(`  ${line.split(":", 2).join(":")}`);
}

if (failed) process.exit(1);
console.log("PASS");
