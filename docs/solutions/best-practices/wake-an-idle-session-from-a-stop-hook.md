---
title: "Wake an idle Claude Code session from a background Stop hook: keep the marker while a task is pending, claim only after the hook has the text, prove it in a real session"
date: 2026-11-01
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
- **The newest waiter wins.** Each Stop starts a waiter. The pid file is written under a temporary name and renamed into place, and an older waiter that reads another pid exits 0. A waiter whose pid file is gone writes it again only when no newer waiter refreshed the marker after its own start: the marker's mtime tells which waiter is newer.
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

Not proven yet: what Claude Code signals at the hook's timeout, at `/clear` and at exit (the hook's shell only, or its whole process group). A waiter whose hook shell is gone claims nothing, but it polls on until a newer waiter, its `claude` process or its 11 h 50 min limit ends it. The ancestor match needs `ps -o comm=` to end in `claude`; a binary with a versioned name means no wake, and the prompt hook still delivers.

## Why This Matters

Each failure above is silent. The ledger says "notified", or the marker is gone, and the session never hears. A happy-path test finds none of them. A test must kill the hook's shell, fail one `ps`, age a marker past 12 h with a task pending, or change the session under the waiter.

## When to Apply

- A new background hook, or a new reason for the waiter to stop.
- A change to the wake marker's writers or to `wakeSweep`.
- A hook change that only a real Claude Code session can prove: use the live check above.

## Related

- `session-notices-claim-once-per-finish.md`: the prompt-hook path and the print-first rule.
- `agent-hooks-for-scheduling-intents.md`: the hook script rules.
- `vetting-a-process-by-pid-before-signalling.md`: process identity by more than the pid.
- `../developer-experience/deterministic-process-kill-tests.md`: process tests without real sleeps.
