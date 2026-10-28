#!/usr/bin/env node
// Fails when tests leave `tidegap*` entries in the temp dir. It never deletes
// a leaked entry: what leaked stays for inspection.
//
//   node scripts/test/tmp-leak-guard.mjs -- <cmd> [args...]
//       Runs <cmd> with TMPDIR set to a private sandbox, so concurrent runs
//       cannot skew the count. The sandbox is removed only when nothing leaked.
//       SIGINT/SIGTERM to the guard is passed to <cmd>; the guard still reports
//       and cleans up, then exits with <cmd>'s status (128 + signal if killed).
//   node scripts/test/tmp-leak-guard.mjs snapshot <state.json>
//   node scripts/test/tmp-leak-guard.mjs check <state.json>
//       Compare tmpdir() before and after the steps in between (CI).
//
// Counted: names starting with "tidegap" (tidegapkit- too), our own `*.lock`
// files included. The locks SwiftPM leaves in the same folder are named after
// the flattened absolute path (`_Users_..._.build.lock`), so they never match.
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const counted = (name) => name.startsWith("tidegap");

function entries(dir) {
  return readdirSync(dir).filter(counted).sort();
}

/** Prints the counts and the new names; returns the number of new entries. */
function report(before, after, where) {
  const known = new Set(before);
  const fresh = after.filter((n) => !known.has(n));
  console.log(`tmp-leak-guard: before ${before.length}, after ${after.length}, new ${fresh.length} (${where})`);
  for (const n of fresh.slice(0, 20)) console.log(`  leaked: ${n}`);
  if (fresh.length > 20) console.log(`  ... and ${fresh.length - 20} more`);
  return fresh.length;
}

/** Runs <cmd> in a fresh sandbox TMPDIR; resolves to the guard's exit code. */
async function sandboxed(cmd, args) {
  const sandbox = mkdtempSync(join(tmpdir(), "tidegap-leak-guard-"));
  const child = spawn(cmd, args, { stdio: "inherit", env: { ...process.env, TMPDIR: sandbox } });
  // A terminal Ctrl-C reaches the child too; a signal sent to the guard alone
  // is forwarded. Either way the guard lives on to report and clean up.
  const forward = (signal) => child.kill(signal);
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);
  const r = await new Promise((resolve) => {
    child.once("error", (error) => resolve({ error }));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  process.off("SIGINT", forward);
  process.off("SIGTERM", forward);
  const leaked = report([], entries(sandbox), sandbox);
  // Only the sandbox itself and caches outside the counted names remain.
  if (leaked === 0) rmSync(sandbox, { recursive: true, force: true });
  if (r.error) throw r.error;
  if (r.signal) return 128 + (constants.signals[r.signal] ?? 0);
  if (r.code !== 0) return r.code ?? 1;
  return leaked === 0 ? 0 : 1;
}

async function main(argv) {
  const [mode, ...rest] = argv;
  if (mode === "snapshot" && rest[0]) {
    writeFileSync(rest[0], JSON.stringify(entries(tmpdir())));
    console.log(`tmp-leak-guard: snapshot ${entries(tmpdir()).length} entries in ${tmpdir()}`);
    return 0;
  }
  if (mode === "check" && rest[0]) {
    const before = JSON.parse(readFileSync(rest[0], "utf8"));
    return report(before, entries(tmpdir()), tmpdir()) === 0 ? 0 : 1;
  }
  if (mode === "--" && rest.length > 0) return sandboxed(rest[0], rest.slice(1));
  console.error("usage: tmp-leak-guard.mjs -- <cmd> [args...] | snapshot <file> | check <file>");
  return 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
