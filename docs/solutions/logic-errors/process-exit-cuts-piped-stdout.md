---
title: "process.exit after console.log cuts piped stdout at 64 KiB; set process.exitCode instead"
date: 2026-11-01
category: logic-errors
module: packages/cli/src/index.ts (queue wait action)
problem_type: logic_error
component: tooling
severity: medium
symptoms:
  - "`tidegap queue wait <id> | cat` prints the first 64 KiB of a long result and exits 0"
  - "The same command in a terminal prints the whole result"
  - "The task's notice was already claimed, so the cut result is the only copy the session got"
root_cause: wrong_api
resolution_type: code_fix
tags: [node, stdout, pipe, process-exit, exit-code, cli, queue-wait, bash-tool]
---

# process.exit cuts piped stdout

## Problem

`tidegap queue wait` printed the result with `console.log`, then called `process.exit(code)`. A Bash tool reads the CLI through a pipe. On a pipe, a result over 64 KiB was cut, and the exit code was still 0 (#209 review, P1).

## Symptoms

On macOS:

```sh
node -e 'console.log("x".repeat(200000)); process.exit(0)' | wc -c       # 65536
node -e 'console.log("x".repeat(200000)); process.exitCode = 0' | wc -c  # 200001
```

A terminal shows no problem, so a manual check passes.

## Why

Node can write stdout to a pipe asynchronously (Node docs, "A note on process I/O"). `console.log` returns before the data is written: the pipe takes 64 KiB on macOS, and Node queues the rest. `process.exit` ends the process at once and drops the queued data. `process.exitCode` lets the event loop drain stdout first, then exits with that code.

## Solution

```ts
// packages/cli/src/index.ts, queue wait
if (res.rendered) console.log(res.rendered);
code = res.exitCode;
// ...
process.exitCode = code; // not process.exit(code)
```

Test: `packages/cli/test/queue-watch.test.ts`, "a result over 64 KiB reaches a pipe in full, with exit 0". It runs the built CLI through a pipe with a 200 KB result, in text and `--json`. It fails with `process.exit`.

## Prevention

- A command that can print more than a few KiB on its success path ends with `process.exitCode = code`, never with `process.exit(code)`.
- `process.exit` is safe only when nothing large is still queued, for example after a one-line `console.error` in a `catch`.
- When a command must stop at once (a daemon, a signal handler), wait for the write callback first: `process.stdout.write(text, () => process.exit(code))`.
- To find candidates: `grep -n "process.exit(" packages/cli/src/index.ts`, then look for a `console.log` of a result, a receipt or a list before each hit.
- Test with a pipe and a result over 64 KiB. A test that calls the function directly, or runs in a terminal, does not see the cut.

## Related

- `../best-practices/session-notices-claim-once-per-finish.md`: why the cut was worse than a display problem (`queue wait` claims the notice).
