---
title: "Floating recurring jobs: one live occurrence per job, materialized and settled by one sweep"
date: 2026-10-26
last_updated: 2026-10-27
category: logic-errors
module: packages/core-ts/src (jobs.ts, job-cadence.ts, zone-time.ts, scheduler.ts, storage/sqlite.ts), packages/cli/src/channels/emit.ts, packages/cli/ui (jobs.js, app.js)
problem_type: logic_error
component: tooling
severity: high
symptoms:
  - "The page showed \"retry planned\" from the failure counter, which stays unchanged during a retry (#158 review)"
  - "The Jobs list kept \"running now\" and Run now stale when an occurrence started or got its hour (#158 review)"
  - "Without a rule, a crash between the task insert and the job write leaves a second live occurrence"
  - "After an edit cancelled a crash orphan, the job tracked the cancelled row until the next tick (#164 review)"
root_cause: concurrency
resolution_type: code_fix
applies_when:
  - "Changing how a job's next run is computed, retried, skipped or paused"
  - "Adding a writer to the jobs table or to job occurrence rows"
  - "Reading job state in a client (page, Mac app, extension, Telegram)"
  - "Touching calendar windows or time zones in job-cadence.ts"
tags: [jobs, sweep, materialization, occurrence, insertIfAbsent, compare-and-set, retry, auto-pause, dst, job-id, stale-revision, hold-unserved, import-cycle]
---

# Floating recurring jobs: the occurrence sweep

Program: plan `docs/plans/2026-10-23-0925-feat-floating-recurring-jobs-plan.md`, PRs #148 (core) to #159 (docs). Follow-ups: plan `docs/plans/2026-10-27-1747-fix-jobs-follow-ups-plan.md`, PRs #163 to #172 (core rules in #164). A job ("at least once a day, check my mail") is a rule. Each run is an ordinary task row, so the carbon pick, receipts, channels and the daily summary need no job code.

## Terms

- **Occurrence**: one run of a job, an ordinary task row that carries `job_id`.
- **Calendar-anchored vs run-anchored**: a cadence with a window, weekdays or weekly is calendar-anchored and runs once per slot; daily or every N hours without a window is run-anchored and counts the next run from the start of the last one (`isCalendarAnchored`, `job-cadence.ts:177`).
- **Slot**: the local-time window on an allowed day in which a calendar-anchored job runs once; with no window, the whole local day.
- **Skip**: an occurrence cancelled by the user, not by a job action (rule 3 below).
- **Command job / prompt job**: a run that starts with a user-written shell command, or a run that is a model prompt with a tool set. Agents create prompt jobs only.
- **Guarantee sentence**: the one-line schedule promise from `guaranteeText` ("runs once every Mon and Thu, any time of day"); every surface prints it, and docs-drift K15 checks the quoted ones.
- **Orphan**: a live occurrence the job row does not track (a crash between the two writes). The sweep adopts it, or cancels it as `edited` when an edit replaced its template (rule 1).
- **Held row**: a due row a ticker leaves `scheduled`, with no claim and no failure, because it has no adapter for it; another ticker runs it (rule 10).
- **Stale revision**: an edit made against an older `revision` of the job than the stored one; refused with reason `stale_revision` (rule 9).
- **"repeat" is overloaded**: in `schedule_task` it holds both the older repeat-series values (`quota_reset`) and the job cadences. A task with a job cadence becomes a job, not a series.

## The model

- **Jobs do not reuse repeat series.** An occurrence is a task with `job_id` set, `repeat = none` and no `series_id`, so `rollSeries` ignores it (KTD1). Series roll from the previous deadline, copy a body that is redacted at the end, and have no pause, window or failure state. Bending them would have changed shipped behaviour. Series rules stay in `repeat-series-and-replies.md`.
- **`tasks.job_id` is a nullable, insert-only column** added by `ensureColumns` with an index (`packages/core-ts/src/storage/sqlite.ts:291-292`). Keep it out of `upsert`, the transition columns and `updateIfPending`, like `series_id`.
- **One live occurrence per job.** Ids are derived: `<job_id>~<seq>`, and the slot's one retry is `<job_id>~<seq>r` (`jobs.ts:5-7`). The insert is `insertIfAbsent`; the job row then advances by compare-and-set on `revision` (`pending_task_id`, `next_seq + 1`).
- **One sweep owns every daemon transition** (`sweepJobs` in `jobs.ts`). It runs in `prepareTick` (`quota.ts:385`), so every ticker gets it, and again after the tick in `packages/cli/src/commands/tick.ts:641`, so a run that finished gets its successor in the same tick. It never throws: a failure is a message, and the job is tried again on the next pass.

## Rules that review or QA had to add

1. **Two tables, no transaction: adopt the orphan, unless an edit replaced its template.** A crash between the task insert and the job write leaves a live row that the job does not track. The next sweep adopts the newest one instead of inserting a second, and cancels other pending ones as `duplicate`. An adopted id that ends in `r` sets `retryUsed`. A pending orphan whose run fields differ from the current template (`runsCurrentTemplate`) would run the old prompt or command, so it is cancelled as `edited` and a fresh row is made (#164).
   - **The fresh row never reuses a cancelled id.** The cancelled row keeps its id, so the fresh one takes the next free sequence: `freeSeq = max(nextSeq, seq of each edited row + 1)`, and an adopt also moves `nextSeq` past them. The first version took `nextSeq`, which can equal the orphan's own sequence (the crash came before the job write that bumps it). `insertIfAbsent` then found the cancelled row, inserted nothing, and the job tracked a cancelled row until the next tick (#164 review).
   - When the cancelled orphan is the slot's retry (`~<n>r`), the successor is a regular occurrence of the new template and the failure is not counted.
2. **Stop-flag-first, and every job cancel is pending-only.** Pause, edit and remove write the job row first, then cancel the tracked occurrence. `cancelOccurrence` passes `expectedStatus` (the pending states) to `Scheduler.cancelTask`, so a row a tick claimed meanwhile runs to its end; `cancelTask` returns any other row unchanged. A sweep whose job write misses retries up to three times; when all three miss, it cancels its own insert if the job is no longer active (end of `sweepJob`). Task-level cancels (the page's task API, MCP and OpenClaw `cancel_task`) are not pending-only and still cancel a running occurrence.
3. **Outcome policy lives in the sweep** (KTD9, the outcome block of `sweepJob`):
   - completed: `last_outcome = ok`, failure count reset;
   - failed: one retry per slot, only if at least 30 min remain before the deadline and the failure was not in the summarize step after the command ran (`failedAfterCommand`: a retry would run the command again). Otherwise the count goes up; at 3 (`JOB_AUTO_PAUSE_FAILURES`) the job pauses with `pause_reason = "auto: <first error line>"`;
   - cancelled with a job-action reason (`paused`, `edited`, `removed`, `duplicate`): nothing is recorded. Any other cancel is a **skip**: count unchanged, and the successor is anchored on the skipped deadline.
4. **A calendar slot is used once, run or not.** A run that failed before dispatch still moves the job to the next slot. Run now clears `notBefore`, so the slot mark falls back to one minute before the deadline (`firstOccurrence` in `jobs.ts`). Resume counts from now only for a run-anchored job; a calendar job keeps its last run, so it does not run a slot twice.
5. **Interrupted runs fail by compare-and-set from `running`.** The limit is `commandTimeoutMs + llmTimeoutMs + 5 min` of **awake** time since the last `dispatched` event; time the machine slept does not count (`interrupted` in `jobs.ts`, and `sleep-gap-is-not-a-dead-daemon.md`). A Batch row and a row with no `dispatched` event count from the deadline. Only the daemon sweep does this; a page or CLI action never fails a run.
   - **A host with no sleep reading waits longer (#164).** The OpenClaw loop passes no `sleepNow` to `prepareTick`. When the run's `dispatched` event carries a reading but this host has none, the run may have slept, and the wall clock cannot tell. The host waits until `max(deadline, dispatch) + limit`, so a host that reads the counter decides first, and a dead CLI tick still frees the job at the latest then. For a weekly or wide-window job that can be days. A run with no stored reading keeps the wall rule.
6. **The cap that stopped a run is stored on the task.** The command adapter puts `steps` and `stopped_by` (`command_timeout`, `llm_timeout`, `budget`) in the run details, and the scheduler copies only its known keys (`steps`, `stopped_by`, `truncated`) onto the `failed` or `completed` event (`runDetails`, `scheduler.ts:3006`). The retry rule above reads `steps` from that event.
7. **The auto-pause notice replaces the run's failure alert.** `jobPauseEvents` claims each notice with a compare-and-set on `pause_notified_at`, sends it whatever the job's notify level, and removes the plain `task_failed` event of the same task (`jobPauseEvents` and its caller in `packages/cli/src/channels/emit.ts`). Quiet hours or backoff leave it unclaimed for a later run; with no subscriber it is marked sent with no event.
8. **Create is all or nothing (#164).** `createJob` inserts the job row, then runs the first sweep. When the sweep throws, `abandonJob` marks the job `removed`, cancels its pending rows (reason `removed`) and the error is rethrown, so a caller that retries makes one job, not two. Returning the job and leaving the daemon to materialize was rejected: an agent job's first deadline would be lost, and the caller would see success with no run. `abandonJob` is best effort: when both of its writes fail, an active job can stay.
9. **An edit names the revision it read (#164, #169).** `updateJob(..., { expectedRevision })` compares inside the compare-and-set retry and throws `JobActionError` with `code: "conflict"` and `reason: "stale_revision"`. The plan asked for a new `code`; the `code` union is the key type of `STATUS_OF` (`Record<JobActionError["code"], number>`) in `packages/cli/src/ui/jobs-api.ts`, a file another PR of the batch owned, and a new member breaks that file's typecheck. A finer `reason` leaves the existing mapping intact; the host forwards it as the 409 body `code`. Because the check runs inside the retry, a sweep that bumps the revision between the read and the write also reads as stale; Reload resolves it. The page route answers the visible case before it parses the patch: `../best-practices/dependency-free-task-ui-patterns.md`.
10. **A host holds rows it cannot serve (#164).** `Scheduler.tick(adapters, { holdUnserved })` leaves a due row `scheduled`, with no claim and no failure, when no adapter serves its provider or a routing candidate. The CLI tick sets it only with zero LLM adapters (a host with only command jobs); with some keys it keeps failing a row for a missing provider, as its warning says. The Python ticker holds a different set: every pending job run, whatever its provider and the adapters, and every `command` or `claude-code` row it has no adapter for (`_held_for_node` in `packages/core-py/src/tidegap/scheduler.py`, #190); its claims refuse a job run too. The jobs docs page states the difference, and K18 checks the page's provider list against `_TS_ONLY_PROVIDERS`; keep both when either side changes.

## DST in `job-cadence.ts`

- A local time that does not exist (spring forward) moves to the first valid minute after the gap. A repeated local time (fall back) uses its first instant (`localToUtcMs`, `packages/core-ts/src/zone-time.ts:60-61`).
- A window that the gap swallows (02:00-03:00 on a spring-forward day) keeps its nominal length from the moved start (`job-cadence.ts:212-214`).
- The cases are vectors in `packages/core-ts/test/fixtures/job-cadence-vectors.json` ("spring forward ... keeps one hour", "fall back ... uses the first 02:00", AE2 across the DST end; #164 added New York spring and fall, a window start inside the gap and in the repeated hour, and `Pacific/Kiritimati` at UTC+14). Add a vector, not a one-off test. General time-zone rules: `time-of-day-bugs-and-fake-time-sweeps.md`.
- **The zone helpers stay import-free.** `quota.ts` imports `jobs.ts` (the sweep runs in `prepareTick`), and `jobs.ts` and `job-cadence.ts` need the zone helpers. With the helpers in `quota.ts` the modules formed a cycle; #164 moved them to `zone-time.ts`, which imports nothing. Add a zone helper there, never back in `quota.ts`. No check guards the cycle.

## Rules for clients

- **Read retry state from the id, not the counter.** During the retry the failure count is unchanged until the retry fails too. The page shows "retry planned" when the last outcome is `failed` and `next_run.task_id` ends in `r` (`packages/cli/ui/jobs.js:122-124`). The first version keyed on `consecutive_failures` and was wrong (#158 review). Test fixtures follow a real core sequence: retry `~4r` with count 0, then after the retry fails, count 1 and a regular `~5`.
- **A change to an occurrence is a change to its job.** The change stream names task ids, not job ids. The page matches `/^(.+)~\d+r?$/` (`app.js:62`) and refetches the Jobs list and the open History when the prefix is a known job (`app.js:676`). Without this, "running now" and the hidden Run now went stale when a run started or got its hour. Repeat series use `<series>~<n>` too, so the job lookup is the check, not the pattern.

## Prevention

- A new job writer goes through `updateJobIf` with the read `revision`, and cancels occurrences only after its job write (stop-flag-first), through `cancelOccurrence` (pending-only).
- A new id the sweep inserts never reuses the sequence of a row it cancelled in the same pass.
- A new client state that depends on the outcome policy reads the occurrence id shape or a server field. Do not rebuild the policy from counters.
- Tests: `packages/core-ts/test/jobs-sweep.test.ts` (outcomes, adoption, the two crash-orphan edit cases, interrupt), `jobs-store.test.ts`, the cadence vectors (run under several `TZ` values), `packages/cli/test/ui-jobs-actions.test.ts`.

Related: `compare-and-set-task-transitions.md`, `repeat-series-and-replies.md`, `run-now-clears-not-before-without-audit.md`, `../best-practices/channels-url-policy-and-child-process-rules.md` (the job command runner).
