---
title: "A session notice is claimed once per finish, printed before the claim, and claimed only inside a deadline counted from the process start"
date: 2026-11-01
last_updated: 2026-11-01
category: best-practices
module: packages/core-ts/src/storage/sqlite.ts (listSessionNotices, claimNotice), packages/cli/src/commands/queue-watch.ts (runQueueNotices, runQueueWait), packages/claude-code-plugin/hooks/session-notice.sh
problem_type: best_practice
component: tooling
severity: medium
applies_when:
  - "Changing how a Claude Code session hears that its queued task finished (prompt hook, queue wait, a wake)"
  - "Recording that some reader saw a task outcome, when the same task id can finish more than once"
  - "A hook command does work after it prints, under the hook's timeout"
tags: [session-notices, claude-code, hooks, userpromptsubmit, at-least-once, insert-if-absent, deadline, retry, queue-wait]
---

# Session notices: claim once per finish, print first, claim inside the deadline

## Context

Batch 29 PR A (#209) tells a Claude Code session, on its next prompt, which tasks it queued have finished. A `notified` event records the delivery, so a later prompt does not repeat it. Three review findings changed the plan's design (KTD2). Each one lost a notice with no error.

## Guidance

- **Key the claim on the finish, not on the task.** `retry_task` keeps the task id. With one `notified` event per task, a retried task that finished again never reached its session. The claim is an insert-if-absent whose details carry the task's `completed_at`. The notice query and the claim both match on it (`json_extract(n.details, '$.completed_at') IS t.completed_at`, `packages/core-ts/src/storage/sqlite.ts`). A claim of an unknown task writes nothing. Test: `packages/core-ts/test/session-notices.test.ts`, "a retried task that finishes again is a new notice, claimed once".
- **Print first, then claim.** A crash between the two steps repeats one line on the next prompt. The other order loses the notice. Delivery is at least once; the docs page (`apps/web/content/docs/12-handoff.md`, "A notice can repeat") says so. `queue wait` still claims before it prints (a #209 residual): a process killed between the two steps loses one notice.
- **Count the hook deadline from the process start, and check it before each claim.** Claude Code drops the output of a hook that runs past its `timeout` (10 s here). `queue notices --hook` stops at 5 s (`NOTICE_HOOK_DEADLINE_MS`). The first version counted from the start of the function, so Node's own start-up time was not counted, and it checked the deadline only before the print. Claims could then commit after the hook was killed, so the session never saw the text that the ledger said it saw. Now the CLI passes `performance.timeOrigin` as `startedAt`, and the claim loop checks the deadline before each claim. Past the deadline before the print, it prints nothing. After the print, it claims no more and keeps the marker, so the next prompt delivers the rest. Tests: `packages/cli/test/handoff-notices.test.ts`, the three "notices --hook ... deadline" cases.
- **Send the CLI only what it needs.** The hook script reads `session_id` from the hook input and pipes `{"session_id":"<checked id>"}` to the CLI. A prompt over the 256 KiB read cap otherwise reached the CLI as cut-off JSON, and that prompt got no notice (#209 review, P3).
- **A notice that lists more than fits claims only what it listed.** The block stays under 9,000 characters (the hook limit is 10,000) and counts the rest ("- and N more: ...", `packages/cli/src/handoff/notices.ts`). Only the listed tasks are claimed (#210).

## Why This Matters

Each mistake fails in silence: the ledger says "notified" and the session never saw the text. No test of the happy path finds it. A test must retry a task, run the hook past its deadline, or send an oversized input.

## When to Apply

- Any new delivery path for a notice. The Stop-hook waiter of #211 applies the same order: it claims only after its stderr write reached the hook's pipe (`wake-an-idle-session-from-a-stop-hook.md`).
- Any "seen" or "sent" event on a row whose id can finish again (a retry, a series occurrence).
- Any hook command that writes the ledger after it prints.

## Examples

```sql
-- One notified event per finish; a retry with a new completed_at is a new notice.
INSERT INTO task_events (task_id, at, kind, actor, details)
SELECT t.task_id, ?, 'notified', ?, json_set(?, '$.completed_at', t.completed_at)
  FROM tasks t
 WHERE t.task_id = ?
   AND NOT EXISTS (SELECT 1 FROM task_events n
                    WHERE n.task_id = t.task_id AND n.kind = 'notified'
                      AND json_extract(n.details, '$.completed_at') IS t.completed_at)
```

## Related

- `agent-hooks-for-scheduling-intents.md`: the hook script rules (POSIX `sh`, exit 0, input cap).
- `wake-an-idle-session-from-a-stop-hook.md`: the opt-in wake of an idle session (#211), the delivery path that does not wait for a prompt.
- `../logic-errors/compare-and-set-task-transitions.md`: insert-if-absent for derived rows.
- `../logic-errors/process-exit-cuts-piped-stdout.md`: the `queue wait` output cut that also lost a notice.
