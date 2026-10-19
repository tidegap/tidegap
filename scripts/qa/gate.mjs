#!/usr/bin/env node
// QA gate: runs one area script, or all of them one after another, and prints
// `PASS` or one `FAIL <area>: <case ids> log: <path>` line per failing area.
// The browser area (ui) runs last and alone: `all` never runs it beside another stream.
//
//   node scripts/qa/gate.mjs <cli|telegram|mcp|release|docs|ui|all> [--prefix <p>] [area flags]
//   pnpm qa <area>

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const AREAS = {
  cli: "cli-flows.mjs",
  telegram: "telegram-flows.mjs",
  mcp: "mcp-tools.mjs",
  release: "release-pack.mjs",
  docs: "docs-drift.mjs",
  ui: "ui-flows.mjs",
};

const argv = process.argv.slice(2);
const area = argv[0];
if (!area || !(area in AREAS || area === "all")) {
  console.log(`usage: gate.mjs <${[...Object.keys(AREAS), "all"].join("|")}> [--prefix <p>] [area flags: --stream --port-base --log-dir --keep ...]`);
  process.exit(2);
}
// Everything after the area is forwarded to the area script, except the gate's own --prefix.
// An explicit --stream wins over the default `<prefix><area>` name.
const rest = [];
let prefix = "";
for (let i = 1; i < argv.length; i++) {
  if (argv[i] === "--") continue;
  if (argv[i] === "--prefix") prefix = argv[++i] ?? "";
  else rest.push(argv[i]);
}
const explicitStream = rest.includes("--stream");
const pass = rest;

/** Runs one area script; resolves with its exit code and its one-line result. */
function run(name) {
  return new Promise((ok) => {
    const child = spawn(process.execPath, [join(here, AREAS[name]), ...(explicitStream ? [] : ["--stream", `${prefix}${name}`]), ...pass], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.once("exit", (code) => ok({ code, line: out.trim().split("\n").pop() ?? "" }));
  });
}

const failed = [];
for (const name of area === "all" ? Object.keys(AREAS) : [area]) {
  const { code, line } = await run(name);
  if (code !== 0) failed.push(`FAIL ${name}: ${line.replace(/^FAIL\s*/, "") || `exit ${code}`}`);
}
console.log(failed.length ? failed.join("\n") : "PASS");
process.exit(failed.length ? 1 : 0);
