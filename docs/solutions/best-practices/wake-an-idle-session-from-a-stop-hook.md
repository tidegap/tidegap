---
title: "Wake an idle Claude Code session from a background Stop hook: keep the marker while a task is pending, claim only after the hook has the text, prove it in a real session"
date: 2026-11-01
last_updated: 2026-11-12
category: best-practices
module: packages/cli/src/handoff/waiter.ts (runWakeWaiter), packages/cli/src/handoff/notices.ts (wakeSweep, pendingWakeTasks), packages/claude-code-plugin/hooks/session-wake.sh, packages/claude-code-plugin/hooks/hooks.json
problem_type: best_practice
component: tooling
severity: medium
applies_when:
  - "A background hook (asyncRewake) must start a turn in an idle Claude Code session"
  - "A marker file decides whether a hook starts a process, and a sweep removes old markers"
  - "A process started by a hook claims a ledger row after it writes to the hook's pipe"
  - "A plugin hook change can only be proven in a real Claude Code session"
tags: [claude-code, hooks, stop-hook, async-rewake, waiter, wake-marker, pid-file, session-notices, live-check, plugin-dir]
---

# Wake an idle session from a Stop hook

## Context

#211 (batch 29 PR C) added `queue add --wake` and `schedule_task` `wake_session`. The enqueue writes `~/.tidegap/sessions/wake/<session_id>`. The plugin's `Stop` hook (`packages/claude-code-plugin/hooks/session-wake.sh`, `asyncRewake: true`, `timeout` 43200) starts `tidegap queue notices --wait --rewake` only when that marker exists. The waiter runs in the background. When a wake task finishes, it writes the notice to stderr and exits 2, and Claude Code starts a turn with that text. Every other way out exits 0 and leaves the notice to the prompt hook (`session-notices-claim-once-per-finish.md`). The #211 review found five P2s on this path. Each one lost a wake, or could wake the wrong conversation, with no error.

## Guidance

- **Keep the wake marker while a wake task is pending.** The plan (KTD4) let the tick sweep remove a marker older than 12 h. After an idle night, a wake task with a long deadline lost its marker, and the next turn's Stop hook started no waiter. Now each waiter start refreshes the marker's age, so the 12 h count from the last turn. `wakeSweep` (`packages/cli/src/handoff/notices.ts`) removes a marker older than 12 h only when `pendingWakeTasks` finds nothing left to wait for, and any marker older than 7 days (`SESSION_NOTICE_MAX_AGE_MS`). Without a ledger only the 7-day rule applies. A completed wake task whose result file never came stops counting after 7 days.
- **Claim only after the write reached the hook's pipe.** When only the hook's shell was killed, the waiter lived on, wrote into a pipe with no reader and claimed the notice. Nobody delivered it, and the prompt hook then skipped it. `writeStderr` (`waiter.ts`) resolves on the write callback. A pipe with no reader gives false, and its EPIPE error does not end the process. No reader: exit 0, nothing claimed.
- **After a won claim, the exit code must deliver.** A `markRead` error after the claim returned "lost", so the waiter exited 0 with the notice claimed. Now mark-read is best effort: the claim stands and the waiter exits 2. A claim that throws exits 0 with nothing claimed.
- **One failed `ps` is not a gone process.** A `ps` timeout under load ended the wait as `claude-gone`. `psIdentity` returns null (unknown) when `ps` fails and `kill(pid, 0)` still finds the pid. Three unknown polls in a row count as gone (`UNKNOWN_IDENTITY_LIMIT`). The identity compares owner, start time and name, not the pid alone (`vetting-a-process-by-pid-before-signalling.md`).
- **Stop on a session change.** After `/clear` or `/resume`, the same `claude` process runs another conversation, and the waiter could wake it with the old session's notice. Each poll reads that process's capture file. Another session id ends the wait with exit 0 (`session-changed`).
- **The pid file alone ranks the waiters.** Each Stop starts a waiter. The pid file is written under a temporary name and renamed into place, and an older waiter that reads another pid exits 0. A waiter whose pid file is gone writes it again and keeps waiting. Batch 38 removed the old rule ("exit when the marker's mtime is newer than my start"): `queue add --wake` refreshes the same marker, so an enqueue while the pid file was missing ended the only waiter, and an enqueue in the same millisecond compared equal. The exit's read-then-unlink of its own pid file can still remove a newer waiter's file; that waiter writes it again at its next poll, so the race costs nothing. When a newer waiter ends, an older one still running takes the file back and serves the session until its own hook shell, `claude` process or limit ends it.
- **Remove, then look again.** The waiter and `wakeSweep` read the pending wake tasks, then removed the marker. The enqueue commits the row, then writes the marker, so a row committed after the read and a refresh before the unlink left a pending wake task with no marker. `removeWakeMarkerUnlessPending` (`notices.ts`) unlinks, reads once more and writes the marker again when a wake task is pending or the read fails. The sweep counts only tasks queued after the marker's last refresh, so its 7-day rule still removes a marker of an old pending task. A remover that dies between the unlink and the rewrite, or a marker write that fails, would still leave a pending task with no marker: each tick's `wakeSweep` writes the marker back for a session whose wake task of the last 7 days is still to come, with that task's enqueue time. `writeWakeMarker` looks once more when a concurrent remover or writer makes its refresh hit ENOENT or its create hit EEXIST, so the enqueue does not report `wake: not armed` for a marker that is there. Test it with a store wrapper that commits a row from a second connection inside the first read.
- **The markers belong to the default ledger.** The hooks read `~/.tidegap/queue.db` only (`isDefaultLedger`, now in the core). `queue add --wake` with another `--db` and `schedule_task` `wake_session` on a server with another `TIDEGAP_DB_PATH` (or `:memory:`, or no ledger at all) exit 2 or refuse before they enqueue: the waiter would never see the task and would remove the marker. A waiter on another ledger may wake, but removes no wake or notice marker.
- **A cancel never wakes.** Only a completed or failed wake task wakes. A cancel, also the agent's own cancel in its turn, goes to the next prompt.
- **Say when the wake is not armed.** `queue add --json` has `wake` (asked for) and `wake_armed` (false when the marker write failed; the text output says `wake: not armed`). Docs-drift K21 keeps the documented key list equal to `QUEUE_ADD_JSON_KEYS`.
- **Pass only the notice through.** `session-wake.sh` keeps stderr from the first `Tidegap: ` line, so a Node warning (the `node:sqlite` warning on Node 22) is not part of the wake text. An exit 2 without a notice line exits 0. `scripts/plugin-hooks.test.mjs` exempts this one `asyncRewake` entry from the trailing `exit 0` rule of the other hooks and pins its own: one entry, on `Stop`, timeout 43200, no `exit 0`.

## Proving it in a real session

The unit tests use fake process tables, the test's own clock and a second store that completes the row. They cannot show what Claude Code does with a background hook. #211 merged after the owner's live check:

1. Build the branch. Put a shim first on `PATH`, in every terminal, that runs the branch's `packages/cli/dist/index.js`.
2. Stop the installed tick daemon (macOS: `launchctl bootout gui/$(id -u)/com.tidegap.tick`). Run `tidegap tick --daemon --interval 30` from the branch in a second terminal. Otherwise the installed build completes the task.
3. Disable the marketplace copy of the plugin, then start `claude --plugin-dir packages/claude-code-plugin`. Two enabled copies named `tidegap` register one `hooks.json`, so the branch's hooks are not sure to run.
4. Ask the agent to queue a short wake task (`--runner command ... --wake "sleep 30; ..."`). End the turn and send nothing.
5. Afterwards, run `tidegap install` (it loads the daemon again) and enable the marketplace plugin again.

Run 1 passed: the idle session started a turn by itself about 35 s after the task finished. Claude Code showed it as a "Stop hook feedback" turn that held the notice. Run 2 passed: a task queued with `--not-before 70m --by 3h --wake` woke the session 2 h 48 min after enqueue, about 2 s after the task finished. The hook's shell lived that long without a turn. Note the timing: `--not-before` is an early bound, not a run time. The scheduler picked the cleanest hour inside the 70 min to 3 h window, so the task ran near the end of it. A check script that waits "about 70 minutes" and then reads the ledger reads it too early; wait for the `notified` event (`tidegap queue events <id> --json`) or for the deadline.

Not proven yet: what Claude Code signals at the hook's timeout, at `/clear` and at exit (the hook's shell only, or its whole process group). The waiter no longer depends on the answer. `session-wake.sh` passes its own shell's pid as `TIDEGAP_HOOK_PID`; the waiter takes that shell's owner, start time, command and parent pid at start, in the same `ps` as the `claude` process, and exits 0 at its next poll when the shell is gone, runs another process or has a new parent (its own parent ended). It looks once more right before it writes a wake notice, so a gone shell gets nothing written and nothing claimed. Three unreadable looks in a row count as gone. This holds only because the hook shell blocks for the whole wait: `session-wake.sh` runs the waiter inside `out=$(...)`, so the shell lives exactly as long as the waiter needs it. A hook that started the waiter with `&` and exited would end every waiter at its first poll. The tuple, not the pid alone, is the identity: a reused pid has another start time or command. A waiter started without the variable (by hand, an older plugin) keeps the old rules. `packages/cli/test/handoff-wake-process.test.ts` proves the stop paths with real signals: SIGKILL to the hook shell, SIGTERM to a fake `claude` (a link to the Node binary named `claude`), SIGTERM to the waiter, a wrapper shell that stays alive, and a real wake. The ancestor match needs `ps -o comm=` to end in `claude`; a binary with a versioned name means no wake, and the prompt hook still delivers.

## The hooks need `tidegap` on PATH

`session-wake.sh` and `session-notice.sh` run `command -v tidegap` and exit 0 with no output when it fails. So without the CLI on the `PATH` that Claude Code gives its hooks, wakes and prompt notices never run, and nothing says why. The Mac app keeps its runtime in `~/.tidegap/runtime` (`apps/macos/scripts/sync-runtime.sh`), and on a Mac where nothing linked the CLI into a `PATH` directory, every hook was silent. A small wrapper on `PATH` that runs the runtime CLI fixed it (2026-11-12). Check `command -v tidegap` in the shell that starts `claude` before you debug a missing wake. Product follow-up, not done yet: the SessionStart hook should say once that the CLI is missing, or fall back to the runtime path.

## Why This Matters

Each failure above is silent. The ledger says "notified", or the marker is gone, and the session never hears. A happy-path test finds none of them. A test must kill the hook's shell, fail one `ps`, age a marker past 12 h with a task pending, or change the session under the waiter.

## When to Apply

- A new background hook, or a new reason for the waiter to stop.
- A change to the wake marker's writers or removers, to `wakeSweep`, or to the ledger a wake may use.
- A hook change that only a real Claude Code session can prove: use the live check above.

## Related

- `session-notices-claim-once-per-finish.md`: the prompt-hook path and the print-first rule.
- `agent-hooks-for-scheduling-intents.md`: the hook script rules.
- `vetting-a-process-by-pid-before-signalling.md`: process identity by more than the pid.
- `../developer-experience/deterministic-process-kill-tests.md`: process tests without real sleeps.
