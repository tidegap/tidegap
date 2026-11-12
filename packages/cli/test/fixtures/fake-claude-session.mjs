/**
 * A fake `claude` session for the waiter's real-process tests. The test
 * runs it through a link to the Node binary named `claude`, so `ps -o comm=`
 * ends in `claude` and the waiter finds it as its ancestor.
 *
 * Usage: claude fake-claude-session.mjs <out-dir> <hook-script> [--wrap] < hook-input
 *
 * It starts the Stop hook as Claude Code does (`sh <hook-script>`, the hook
 * JSON on stdin), or with `--wrap` under a shell that stays alive
 * (`sh -c 'sh <hook-script>; exit $?'`). It writes the pid of the process it
 * started to `<out-dir>/hook.pid` and, when that process ends,
 * `{code, signal, stderr}` to `<out-dir>/hook.exit` (both written under a
 * temporary name, then renamed). It lives on after the hook ends, like
 * Claude Code, until a signal ends it.
 */

import { spawn } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// On Linux a newer Node names its main thread "node", which is the
// process's `comm`; the title is set with prctl(PR_SET_NAME), so `ps -o
// comm=` shows `claude` again. On macOS `comm` is the path the link was
// started by, so the title is left alone there.
if (process.platform === "linux") process.title = "claude";

const [outDir, hookScript, mode] = process.argv.slice(2);
if (!outDir || !hookScript) {
  process.stderr.write("usage: claude fake-claude-session.mjs <out-dir> <hook-script> [--wrap]\n");
  process.exit(1);
}

function writeAtomic(name, text) {
  const tmp = join(outDir, `.${name}.tmp`);
  writeFileSync(tmp, text);
  renameSync(tmp, join(outDir, name));
}

const input = readFileSync(0);
const args = mode === "--wrap" ? ["-c", 'sh "$0"; exit $?', hookScript] : [hookScript];
const hook = spawn("/bin/sh", args, { stdio: ["pipe", "ignore", "pipe"] });
let stderr = "";
hook.stderr.setEncoding("utf8");
hook.stderr.on("data", (chunk) => {
  stderr += chunk;
});
hook.on("close", (code, signal) => writeAtomic("hook.exit", JSON.stringify({ code, signal, stderr })));
hook.stdin.end(input);
writeAtomic("hook.pid", `${hook.pid}\n`);

// Claude Code stays up after its hook ends; only a signal ends this process.
setInterval(() => {}, 60_000);
