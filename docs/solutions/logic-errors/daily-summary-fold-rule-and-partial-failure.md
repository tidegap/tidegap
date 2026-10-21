---
title: "Daily summary (digest): the fold rule, window marks and the partial-failure case"
date: 2026-10-20
category: logic-errors
module: packages/core-ts/src/channels (digest.ts, plan.ts), packages/cli/src/channels/emit.ts, packages/cli/src/commands/tick.ts
problem_type: logic_error
component: tooling
severity: medium
symptoms:
  - "An alert held overnight arrives at 09:00 and again inside the morning summary"
  - "A summary fails on one channel and the alerts folded into it are lost for that channel"
  - "A summary sent in quiet hours repeats at 09:00"
root_cause: logic_error
resolution_type: code_fix
tags: [channels, digest, fold, quiet-hours, ledger-meta, partial-failure]
---

# Daily summary: fold rule and partial failure

PR #128 (U15). The S2 review (#117) raised it first: a quiet-held alert is re-sent after 09:00 and may duplicate the morning summary entry.

## Rules

- **One summary per local day**, at `digest_at` (default 09:00, the end of quiet hours; `tidegap channels digest --at HH:MM`). Moving `--at` later on the same day sends no second summary. The due check runs in the tick.
- **State in ledger meta:** `notified:digest` is the end of the last summary window (an empty day moves it); `digest_sent` is the last real send (the API field `last` and "Last sent" read it); `digest_at` is the time. An empty day moves only the window mark.
- **Window:** from the previous mark, at most 48 h. A machine asleep for days sends one summary. DST is tested (Berlin end, New York start gap, Tokyo).
- **Empty day sends nothing:** nothing done, failed or postponed, and no open problem. Queued work alone does not make a summary.
- **Fold rule:** on a channel that gets the summary, an alert that the summary lists is not sent separately. "Lists" means: a task in the window, an open readiness problem, or the named clean window. An alert held by quiet hours arrives once, inside the summary. An alert the summary does not list still goes out after quiet hours.
- `covers.taskIds` lists only the printed titles (10 per section, then "and N more"). The 11th task keeps its own alert, because the summary does not name it.
- **Quiet hours do not hold an alert that the same channel's summary lists.** Otherwise a 07:00 summary sent in quiet hours repeats the alert at 09:00.

## Partial failure

| Case | Behaviour |
|---|---|
| Every send fails | `notified:digest` and the folded alerts are restored. The next tick retries. |
| Fails on channel A, reaches channel B | A gets its folded alerts on their own in the same run. B keeps the fold. |
| A summary error (build or plan) | Logged; the summary is skipped; alerts are not folded. |

The first version restored folded alerts only when all sends failed, so channel A silently lost them. The fix is per channel: the fold is a per-channel decision made after the send results are known.

## How to test it

QA does not fake the process clock (no test-only env in the tick). It writes `digest_at = 00:00` and a last send 30 h ago into the ledger. Unit cases: 08:59, 09:01, 09:30, no subscriber (no ledger write), all sends fail, quiet-hours fold, held `not_ready` fold with a non-digest channel still alerted, asleep two days, two channels with one failing, 11 tasks.
