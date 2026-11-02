---
title: "A daemon that writes a file at a path an agent chose: check the real folder by case and identity, never take / or home as a root, write create-only through a link"
date: 2026-11-01
category: best-practices
module: packages/core-ts/src/handoff.ts (locationError, protectedDir, homeSegment, nodeHandoffFs), packages/cli/src/handoff/results.ts (writeResultFile, resultFileSweep), packages/core-ts/src/scheduler.ts (writeOutputFile)
problem_type: best_practice
component: tooling
severity: high
last_updated: 2026-11-01
applies_when:
  - "A task field names a file the daemon writes later (result_path, output_path) or a folder a run uses (cwd)"
  - "Comparing a path against a list of protected folders on macOS"
  - "Writing a file into a folder that another process can change between the check and the write"
  - "Recording a file write in the ledger after the write"
tags: [handoff, result-path, output-path, macos, case-insensitive, firmlink, realpath, dev-ino, toctou, hard-link, o-nofollow, create-only]
---

# Files at a path an agent chose

## Context

Batch 29 PR B (#210) lets a session queue a task with a `cwd` and a `result_path`, and gives `output_path` location rules. The daemon writes these files later, as the user, from outside the session's sandbox. The review found that string rules passed paths that name a protected folder on macOS (P1), and that the writers could be steered by a link or a busy ledger.

## Guidance

### Checking the path (`packages/core-ts/src/handoff.ts`)

- **Compare names in any letter case.** The default macOS disk is case-insensitive: `~/LIBRARY/LaunchAgents` is `~/Library/LaunchAgents`. `protectedDir` lowercases both sides, and `.git` matches in any case.
- **Use the native real path.** `fs.realpathSync` keeps the letter case it was given. `fs.realpathSync.native` returns the case on disk. Neither one removes the `/System/Volumes/Data` firmlink: `/System/Volumes/Data<home>/.ssh` stays as it is.
- **Find the home folder by identity too.** `homeSegment` first matches the spelling, then walks up from the path and compares each folder's `dev:ino` with the home folder's. A firmlink or a case variant of home then has the same identity. The file-system reads are injected (`HandoffFs`), so tests cover the aliases on any OS.
- **Never take `/` or the home folder as a root.** A session started in `~` made its project folder a write root, so `output_path` could replace `~/Documents/*.json`. `isRootOrHome` drops those roots by spelling, real path or identity.
- **Every folder below the root must be the user's.** Another user's folder below `/tmp` could be swapped for a link after the check.
- **Check the given path and the real path.** A protected name in the given path is refused before the folder's existence is checked. The real path of the parent is checked again, so a link into `~/.ssh` is refused.

### Writing the file

- **Create-only result file** (`packages/cli/src/handoff/results.ts`). Run the rules again. Write a temp file with `wx` and mode `0600` in the folder's real path. Then `link` it to the target and remove the temp name. `link` fails with `EEXIST` when anything is at the target, so nothing is ever replaced or followed. Writing through the real folder means that a link swapped in above it later is not followed.
- **When the ledger cannot record the write, undo it.** The sweep wrote the file, then a busy ledger refused the `result_file` event. The next sweep found the file and recorded `written: false`. `queue wait` then exited 1 and the notice said "not written". Now the sweep removes the file when the target is still the same inode (`dev:ino` from `fstat` of the temp file), so the next sweep writes it again and records it.
- **Only a Node tick writes the file, at the end of its pass.** A row the Python core completed waits for the next Node tick, and `queue wait` blocks until then. Since #220 `queue wait` prints one stderr hint when the `result_file` event is still missing one tick interval after `completed_at` (300 s with the unit file on disk, else 60 s). The first version printed while a healthy tick still ran other tasks, because the sweep runs after them, and it told the user to check an error that did not exist. The hint now waits while a fresh `<ledger>.tick.lock` is held (`tickRunning` in `packages/cli/src/commands/tick.ts`: touched every 10 s, stale after 60 s), then reads the file event once more before it prints. A "nothing happens" hint checks that the writer is not in the middle of its pass, not only the time since the event.
- **Replace writer for `output_path`** (`writeOutputFile` in `packages/core-ts/src/scheduler.ts`). Open with `O_WRONLY | O_CREAT | O_NOFOLLOW | O_NONBLOCK` and no `O_TRUNC`. `fstat` the opened file: it must be a regular file, `nlink === 1` and owned by the user. Truncate only then. `O_TRUNC` on a planted hard link empties the linked file before any check. `O_NONBLOCK` makes a FIFO fail at once instead of blocking the tick.

## Why This Matters

The daemon writes as the user, after the agent's turn, and outside the session's Bash sandbox. A path rule that compares strings is only as strong as the most unusual spelling of a protected folder. A check-then-write gap is open for as long as the task waits in the queue, often hours.

## When to Apply

- A new task field that names a file or folder.
- A new protected folder: add it to `PROTECTED_HOME_DIRS`, to the lists on the handoff and tools pages (docs-drift K20 fails until they are equal), and add a case-variant test.
- Any writer that runs after a check in another process or at another time.

## Examples

Tests: `packages/core-ts/test/handoff-spec.test.ts` ("refuses another letter case of a protected folder", "never takes / or the home folder, in any spelling, as an allowed folder", "refuses a result folder below the allowed folder that another user owns"), `packages/core-ts/test/handoff-enqueue.test.ts` ("never writes into a file with a second name (a hard link) put there after enqueue"), `packages/cli/test/handoff-results.test.ts` ("a ledger too busy to record the event leaves no file, so the next sweep writes it and records it written").

The case-variant test runs on every OS. Its `cwd` check expects "protected folder" on a case-insensitive disk (macOS) and "not an existing folder" elsewhere (`CASE_INSENSITIVE_TMP`). A first version used `it.runIf` and was skipped on Linux, so the test count differed between CI legs and `gen:tests:check` failed.

## Related

- `channels-url-policy-and-child-process-rules.md`: the owner and write-bit checks on a program the tick runs.
- `session-notices-claim-once-per-finish.md`: the notice that names the result file.
- Open residual (#210): a folder the user owns, swapped for a link between the check and the open, is not caught. The protected-folder list on the docs pages has a drift rule since #220 (K20, `generated-docs-embed-and-drift-rule-with-vacuous-pass-guards.md`).
