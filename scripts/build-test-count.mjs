#!/usr/bin/env node
// Generate the test count shown on the site and in the README (owner decision D7:
// the number is generated, never hand-edited).
//
// Counts, per package, the tests the runner collects (nothing is executed):
//   vitest list --json      core-ts, cli, mcp-server, openclaw-plugin, web
//   node --test (tap)       apps/extension (plain node:test, no list mode)
//   pytest --collect-only   core-py (needs pytest; else the committed value is kept)
//
// Outputs (committed):
//   apps/web/src/lib/tests.generated.ts   export const TEST_COUNTS = { total, perPackage, generatedAt }
//   README.md                             between <!-- tests:start --> … <!-- tests:end -->
//                                         and <!-- tests-badge:start --> … <!-- tests-badge:end -->
//
//   node scripts/build-test-count.mjs [--check] [--only python] [--python <exe>]
//
// --check          write nothing; exit 1 with a diff summary when committed values differ.
// --only python    count only core-py (the python CI job has no built TypeScript packages).
// A package that cannot be counted keeps its committed value; the run still succeeds.
// `generatedAt` changes only when a count changes, so two runs give identical bytes.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const OUT_TS = join(ROOT, "apps/web/src/lib/tests.generated.ts");
export const README = join(ROOT, "README.md");

/** [key, dir, kind]; the order is the order shown in the README. */
export const PACKAGES = [
  ["core-ts", "packages/core-ts", "vitest"],
  ["cli", "packages/cli", "vitest"],
  ["mcp-server", "packages/mcp-server", "vitest"],
  ["openclaw-plugin", "packages/openclaw-plugin", "vitest"],
  ["extension", "apps/extension", "node"],
  ["web", "apps/web", "vitest"],
  ["core-py", "packages/core-py", "pytest"],
];

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

/** Pure parsers, exported for the unit test. */
export function parseVitestList(stdout) {
  const start = stdout.indexOf("[");
  const list = JSON.parse(stdout.slice(start, stdout.lastIndexOf("]") + 1));
  return list.length;
}
export function parseNodeTap(stdout) {
  const m = /^# tests (\d+)$/m.exec(stdout);
  return m ? Number(m[1]) : NaN;
}
export function parsePytestCollect(stdout) {
  const m = /(\d+) tests? collected/.exec(strip(stdout));
  return m ? Number(m[1]) : NaN;
}

/** The extension's test files, as `node --test` needs them listed (no shell globbing in spawn). */
function nodeTestFiles(cwd) {
  const dir = join(cwd, "test");
  return readdirSync(dir).filter((f) => f.endsWith(".test.js")).map((f) => join("test", f));
}

function countPackage(kind, dir, opts) {
  const cwd = join(ROOT, dir);
  // A fresh HOME keeps the suites from reading the developer's ~/.tidegap.
  // Corepack downloads pnpm into it (~19 MB a package), so it goes when done.
  const home = mkdtempSync(join(tmpdir(), "tidegap-count-"));
  try {
    return countIn(kind, cwd, { ...process.env, HOME: home, FORCE_COLOR: "0" }, opts);
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  }
}

function countIn(kind, cwd, env, opts) {
  const run = (cmd, args) => spawnSync(cmd, args, { cwd, env, encoding: "utf8", timeout: 180_000, maxBuffer: 64 << 20 });
  if (kind === "vitest") {
    const r = run("pnpm", ["exec", "vitest", "list", "--json"]);
    return r.status === 0 ? parseVitestList(r.stdout) : NaN;
  }
  if (kind === "node") {
    const r = run("node", ["--test", "--test-reporter=tap", ...nodeTestFiles(cwd)]);
    return parseNodeTap(r.stdout ?? "");
  }
  const exe = opts.python ?? (existsSync(join(cwd, ".venv/bin/python")) ? join(cwd, ".venv/bin/python") : "python3");
  const r = run(exe, ["-m", "pytest", "--collect-only", "-q"]);
  return parsePytestCollect(r.stdout ?? "");
}

/** The committed `TEST_COUNTS` object, or null. */
export function readCommitted(path = OUT_TS) {
  if (!existsSync(path)) return null;
  const m = /export const TEST_COUNTS = (\{[\s\S]*?\n\}) as const;/.exec(readFileSync(path, "utf8"));
  return m ? JSON.parse(m[1]) : null;
}

/** Merge fresh counts over the committed ones; NaN or missing keeps the committed value. */
export function merge(fresh, committed, today) {
  const perPackage = {};
  const unavailable = [];
  for (const [key] of PACKAGES) {
    const n = fresh[key];
    if (Number.isFinite(n)) perPackage[key] = n;
    else if (Number.isFinite(committed?.perPackage?.[key])) {
      perPackage[key] = committed.perPackage[key];
      if (key in fresh) unavailable.push(key);
    } else if (key in fresh) unavailable.push(key);
  }
  const total = Object.values(perPackage).reduce((a, b) => a + b, 0);
  const same = committed && JSON.stringify(committed.perPackage) === JSON.stringify(perPackage) && committed.total === total;
  return { value: { total, perPackage, generatedAt: same ? committed.generatedAt : today }, unavailable };
}

export function renderTs(c) {
  return `// GENERATED by scripts/build-test-count.mjs — DO NOT EDIT.
// Run \`pnpm gen:tests\` to regenerate. Counts are tests collected per package
// (vitest list, node --test, pytest --collect-only); see docs/claims.md row 13.

export const TEST_COUNTS = ${JSON.stringify(c, null, 2)} as const;
`;
}

const fmt = (n) => n.toLocaleString("en-US");

/** README fragments. */
export function renderProse(c) {
  const parts = Object.entries(c.perPackage).map(([k, n]) => `${n} ${k}`);
  return `**${fmt(c.total)} automated tests** (${parts.join(" + ")}) across ${parts.length} packages`;
}
export function renderBadge(c) {
  return `[![Tests](https://img.shields.io/badge/tests-${c.total}%20automated-22c55e)](#tests)`;
}

/** Replace the text between a marker pair; throws when the pair is missing. */
export function patchMarkers(text, name, body) {
  const re = new RegExp(`(<!-- ${name}:start -->)[\\s\\S]*?(<!-- ${name}:end -->)`);
  if (!re.test(text)) throw new Error(`README.md: markers <!-- ${name}:start --> … <!-- ${name}:end --> not found`);
  return text.replace(re, (_, a, b) => `${a}${body}${b}`);
}
export function renderReadme(text, c) {
  return patchMarkers(patchMarkers(text, "tests", renderProse(c)), "tests-badge", renderBadge(c));
}

function main() {
  const argv = process.argv.slice(2);
  const check = argv.includes("--check");
  const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : null;
  const python = argv.includes("--python") ? argv[argv.indexOf("--python") + 1] : undefined;
  const committed = readCommitted();

  const fresh = {};
  for (const [key, dir, kind] of PACKAGES) {
    if (only === "python" && kind !== "pytest") continue;
    fresh[key] = countPackage(kind, dir, { python });
  }
  const today = new Date().toISOString().slice(0, 10);
  const { value, unavailable } = merge(fresh, committed, today);
  if (unavailable.length) console.log(`kept committed value for: ${unavailable.join(", ")} (could not count)`);

  const wantTs = renderTs(value);
  const readme = readFileSync(README, "utf8");
  const wantReadme = renderReadme(readme, value);
  const haveTs = existsSync(OUT_TS) ? readFileSync(OUT_TS, "utf8") : "";

  if (check) {
    const diffs = [];
    for (const [key] of PACKAGES) {
      const a = committed?.perPackage?.[key];
      const b = value.perPackage[key];
      if (a !== b) diffs.push(`${key}: committed ${a ?? "none"}, counted ${b ?? "none"}`);
    }
    if (committed?.total !== value.total) diffs.push(`total: committed ${committed?.total ?? "none"}, counted ${value.total}`);
    if (haveTs !== wantTs && !diffs.length) diffs.push("apps/web/src/lib/tests.generated.ts: formatting differs");
    if (readme !== wantReadme) diffs.push("README.md: test-count blocks differ from tests.generated.ts");
    if (diffs.length) {
      console.error(`test count drift:\n  ${diffs.join("\n  ")}\nRun \`pnpm gen:tests\` and commit the result.`);
      process.exit(1);
    }
    console.log(`test count OK: ${value.total} across ${Object.keys(value.perPackage).length} packages`);
    return;
  }
  writeFileSync(OUT_TS, wantTs);
  writeFileSync(README, wantReadme);
  console.log(`${value.total} tests: ${JSON.stringify(value.perPackage)}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
