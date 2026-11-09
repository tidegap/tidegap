---
title: TODO Residuals Sweep (Batch 35) - Plan
type: fix
date: 2026-11-09
topic: todo-residuals-sweep
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# TODO Residuals Sweep (Batch 35) - Plan

## Goal Capsule

- **Objective:** The residuals that review left open on `main` stop reaching the user. In the Mac app, a menu item that opens a page view always opens it. The plugin's agent text fits its size cap and states only true facts, and a drift rule fails when it stops doing so. A failure notice always names its cause. A weekly limit whose reset text carries a date defers to that date. `tidegap install` says when the daemon would run from a folder that macOS guards. A provider answer of 408 or 425 gets the task's retry. The stop-signal test of the daemon stops failing under load.
- **Means:** four PRs of at most three units, with no shared source file (Sequencing). PR A, the Mac app page window (KTD2-KTD4). PR B, the plugin texts and their drift rules (KTD5-KTD7). PR C, CLI and notice texts (KTD8-KTD10). PR D, the retry class, the test flake and one untested branch (KTD1, KTD11, KTD12).
- **Authority:** the Product Contract decides what; the Planning Contract decides how. Binding repo rules:
  - `CLAUDE.md` (the gate, generated files, hard rules, git conventions).
  - `docs/solutions/best-practices/agent-facing-text-is-a-contract.md` and `docs/solutions/best-practices/skill-file-acceptance-by-a-cheap-model.md` (PR B).
  - `docs/solutions/best-practices/client-tokens-and-extension-origins.md` (a view request is an event, not state; PR A).
  - `docs/solutions/developer-experience/deterministic-process-kill-tests.md` and `docs/solutions/logic-errors/time-of-day-bugs-and-fake-time-sweeps.md` (PR D).
  - `docs/solutions/best-practices/generated-docs-embed-and-drift-rule-with-vacuous-pass-guards.md` (new drift rules, PR B).
  - `docs/solutions/workflow-issues/public-repo-hygiene.md`, `docs/solutions/workflow-issues/generated-test-counts-merge-conflict.md`, `docs/solutions/developer-experience/folding-review-fixes-into-commits.md`, `docs/solutions/developer-experience/worktree-environment-setup.md`.
- **Owner decisions already taken (do not reopen):** reliability over features; no silent partial paths; jobs run on the Node daemon only; an interrupted run is failed; notifications go out on the final outcome only; default retries 1; `none` switches a limit off; no Rust or Go rewrite; the UI, the Mac app and the extension show and postpone or retry tasks, with no quick add; a feature PR never bumps versions; the plugin explains itself, with no memory or `CLAUDE.md` notes for users.
- **Execution profile:** one Opus `ce-work` agent per PR in `.worktrees/<branch>`, units in order. Simplify runs inside each PR on its code and scripts; it skips PR B's markdown (U6). One `ce-code-review` per PR at the end, Sonnet reviewers by risk: 1 for PR A, PR B and PR C, 2 for PR D (both cores). No `pnpm qa ui` in this batch: no PR changes the page. PR B runs `pnpm qa docs` once; PR C runs `pnpm qa cli` once.
- **Who ships:** each PR ends green, with its review done and the diff reviewed. The agent does not merge. No version bump, release or publish.
- **Stop conditions:** stop and report in these cases.
  - A change needs a file outside its unit lists, apart from `CHANGELOG.md` and the generated files.
  - A test or QA step needs the real `HOME`, `~/.tidegap`, `~/.claude` or `~/.config/tidegap`.
  - PR A: U1 must first show each #235 residual as a failing `PageRouting` test that models the reported order of events (R1: a view request between a fresh-link load without a view and WebKit marking the view as loading; R3: a fresh link that finishes on a server error page). A residual that no such test shows is not fixed: the PR keeps the tests, says "not reproduced" for that requirement in its body, and U2 drops that part. This is a planned fallback, not a stop.
  - PR B: the trimmed skill fails the cheap-model acceptance check of `skill-file-acceptance-by-a-cheap-model.md`, or a K22 fact moves out of its section.
  - PR D: a 408 or 425 vector fails in one core and passes in the other.
  - A gate fails the same way twice.
  - Evidence shows that a Key Technical Decision cannot work.

---

## Product Contract

### Summary

PR A moves the decisions of the Mac app's page window into `TidegapKit`, where unit tests pin their order, and fixes the two ways a view request or a restored view goes wrong. It also clears three small Mac items: a deprecated call, an unused API method and a wrong test fixture path.

PR B puts the plugin drift rules (S7.3, S7.4, K22) into a module with tests, fixes how K22 splits sentences and which section it reads, and adds two rules: no example output path under a protected folder, and the skill's 260-line cap. The skill and `defer.md` then pass them.

PR C makes the failure notice skip a line that holds only control characters, reads a reset time that carries a date, and warns at `tidegap install` when the daemon would run from a folder macOS guards.

PR D classes HTTP 408 and 425 as transient in both cores, makes the daemon stop-signal tests independent of machine load, and tests OpenClaw's `retry_task` branch that queues a task for the next tick.

### Problem Frame

Each item was checked on `main` at `8ed525c1`. An internal triage of 284 residual rows from earlier reviews found 190 fixed or obsolete, 23 that need the owner, and 72 still true. This plan takes 21 of the 72, the named review residuals and the ones a user sees. The other 51 are listed under "Not in this batch".

- **The page window can lose a view request (#235 review).** The window loads a fresh link without a view when it replaces a reload or answers `expired` (`apps/macos/Tidegap/WebPageWindow.swift:202`, `:225`). That link differs from the loaded page only in its fragment, and the page answers a `#token=` hash with `location.reload()` (`packages/cli/ui/app.js:692-704`). A request that arrives before WebKit marks the view as loading goes to `setHash`, which adds a `DOMContentLoaded` listener to the old document (`WebPageWindow.swift:146-155`) and reports the request as applied. The reloaded page then opens the Agenda. A new link that carries the view (`WebPageWindow.swift:18`, `&view=`) is not affected: the page reads `&view=` on every load (`packages/cli/ui/api.js:190-203`). The race is reported by review, not yet reproduced.
- **`restore` and an error page (#235 review).** A non-cancel failure already clears `restore` (`WebPageWindow.swift:177-181`). A fresh link that lands on a server error page still gets `didFinish`, which sets the restored view on the error page (`:130`, `:162-170`). The coordinator logic is in the app target, which has no tests, so the order of `restore`, `pending` and `loadFailed` is not pinned.
- **The skill is over its cap.** `packages/claude-code-plugin/skills/tidegap/SKILL.md` has 279 lines; #224 set a cap of 260 (`skill-file-acceptance-by-a-cheap-model.md:40`). No check enforces it.
- **K22 can blame the wrong cause.** It splits sentences after every `.`, `;`, `!` or `?` followed by a space (`scripts/qa/docs-drift.mjs:487`), so "e.g." and ";" end a sentence. It looks for the notice line and the wake, wait and events commands anywhere in "How the result comes back", not in the Claude Code sub-section that must hold them (`docs-drift.mjs:516-527`; `SKILL.md:97-148`).
- **No rule reads example paths in the plugin.** `agent-facing-text-is-a-contract.md:33`, `:66` records that `--output ~/.tidegap/inbox/<id>.json` shipped as an example after #210 made `~/.tidegap` a refused folder. K20 reads only the docs pages. `main` has no such hit today; the only concrete example path is `/tmp/tidegap-log-triage.json` (`packages/claude-code-plugin/commands/defer.md:198`).
- **A runnable example has a past deadline.** `defer.md:197` passes `--by 2026-05-15T08:00:00Z`; an agent that copies it gets a past-deadline refusal.
- **S7.3 and S7.4 have no tests (#236 review).** Their exemptions (a tool parameter such as `retry_delay`, a field suffix) are inline in `docs-drift.mjs:187-243` with no harness.
- **`defer.md` ties the session to the plugin alone.** It says a direct `schedule_task` call finds the session "when the Tidegap plugin runs in this Claude Code session" (`defer.md:204-207`). The server takes, in order, a valid `origin_session_id`, the plugin's capture file, then `CLAUDE_CODE_SESSION_ID` (`packages/mcp-server/src/origin.ts:1-15`). The last is observed, not documented.
- **A notice can say "unknown error" when the error has a cause.** `firstErrorLine` picks the first line that `trim()` keeps, then strips control characters; a line of only control characters becomes empty and the notice falls back to "unknown error" (`packages/core-ts/src/notify.ts:129-132`, `:157`). A second copy has the same flaw and does not fold inner whitespace (`packages/core-ts/src/channels/format.ts:162-165`).
- **A reset text with a date is not read.** `resetFromText` needs a digit right after `resets` (`packages/cli/src/providers/claude-code.ts:351`). For "resets Oct 20, 9am" the deferral falls back to the usage reading or to a fixed wait (`claude-code.ts:781-786`), so a weekly limit can be retried before it resets.
- **`tidegap install` does not warn about a guarded folder.** `resolveLauncher` warns only about missing paths and the old `@ebb-ai` package (`packages/cli/src/commands/install.ts:136-187`). A daemon whose `node` or entry script sits in `~/Documents`, `~/Desktop`, `~/Downloads` or iCloud Drive can hang on a macOS privacy prompt for hours.
- **408 and 425 are permanent (#236 review).** `classifyFailure` makes every 4xx but 429 permanent (`packages/core-ts/src/run-limits.ts:622`; `packages/core-py/src/tidegap/run_limits.py:494`), and so do the adapters' HTTP helpers (`packages/core-ts/src/providers/base.ts:222-224`; `packages/core-py/src/tidegap/errors.py:126-132`). 
- **The daemon stop-signal tests fail under load.** `exited()` races the daemon's exit against a 5 s wall-clock timer (`packages/cli/test/jobs-tick.test.ts:275-280`), and `within5s` polls for 5 s (`:252-260`). The test failed three times on CI (node 22, `TZ=Asia/Kolkata`) with "expected 'still running' to be +0".
- **One `retry_task` branch has no test (#236 review).** OpenClaw returns `status: "scheduled"` for a task it cannot run now (`packages/openclaw-plugin/src/index.ts:1336-1339`); `plugin.test.ts:437-468` covers only the dispatch path. The MCP branch (`packages/mcp-server/src/server.ts:1493-1501`) is already tested for a `claude-code` task (`packages/mcp-server/test/server.origin.test.ts:283-296`), and the core tests the no-key trigger (`packages/core-ts/test/retries.test.ts:264`).

### Requirements

**PR A: the Mac app page window**

- R1. A view request (a menu item such as "Integrations…" or a job) that arrives while the page window shows a loaded page opens that view, also when the app loads a fresh link at that moment.
- R2. A request is reported as applied only after its view is set, or after its load failed for good.
- R3. A restored view is used by the load it was set for, at most once, and never by a later unrelated load.
- R4. The order rules of R1-R3 run as unit tests in `TidegapKit`.
- R5. The app makes no deprecated activation call and keeps no unused API method; the connection test fixtures use the runtime path that `sync-runtime.sh` creates.

**PR B: the plugin texts and their drift rules**

- R6. The tidegap skill has at most 260 lines, and a drift rule fails when it has more.
- R7. Every concrete example output path (`--output`, `--result-path`, `output_path`, `result_path`; a placeholder such as `<abs-path>` is not one) in the plugin files and the package READMEs is outside the protected home folders; a drift rule fails otherwise.
- R8. K22 fails only for a missing fact, and its message names that fact: abbreviations and semicolons do not end a sentence, and the notice line and the wake, wait and events commands are looked for in the Claude Code sub-section.
- R9. S7.3, S7.4 and K22 have tests for their pass and failure paths, including each exemption.
- R10. `defer.md` says how a direct `schedule_task` call gets its session without promising an undocumented source, and its runnable examples use no past date.

**PR C: CLI and notice texts**

- R11. A failure notice and a channel message show the first error line that has visible text; "unknown error" only when no line has any.
- R12. A limit text whose reset names a month, a day and a time defers the task to that time.
- R13. On macOS, `tidegap install` warns when the daemon's `node` or entry script is in `~/Documents`, `~/Desktop`, `~/Downloads` or iCloud Drive, and says what to do. The install still completes.

**PR D: retries and tests**

- R14. A task whose provider answered 408 or 425 is retried by its retry policy, in both cores. Every other 4xx except 429 stays permanent.
- R15. The configuration page and the agent-facing texts state the R14 rule wherever they state the permanent 4xx rule.
- R16. The daemon stop-signal tests pass or fail on the daemon's behaviour, not on machine load.
- R17. A test covers OpenClaw's `retry_task` for a task it queues for the next tick.

### Key Decisions

- KD1. **408 and 425 are transient.** Both mean the server did not process the request: 408 ends a request the server stopped waiting for (RFC 9110, 15.5.9), and 425 asks the client to send it again (RFC 8470, 5.2). With the default of one retry 30 minutes later, a wrong "transient" costs one more attempt; a wrong "permanent" loses the task. Governs R14, R15.

### Acceptance Examples

- AE1. Covers R1, R2. Given the page window shows `#/jobs` and the window has just loaded a fresh link without a view, when the user picks "Integrations…" (view `settings`), then the reloaded page shows `#/settings` and the request is reported once.
- AE2. Covers R3. Given a reload set the restored view `task/t-1` and the fresh link finishes on a server error page, then the error page gets no hash and the next successful load shows the Agenda, not `task/t-1`.
- AE3. Covers R11. Given an error `"\u0007\u0007\nclaude-code: limit reached"`, the notice line is `claude-code: limit reached`.
- AE4. Covers R12. Given now is 2026-10-17 10:00 in `Europe/Kyiv` and the text `weekly limit reached ∙ resets Oct 20, 9am (Europe/Kyiv)`, the reset is 2026-10-20 06:00 UTC. Given now is 2026-12-30 and the text `resets Jan 2, 9am`, the reset is on 2027-01-02. Given the text names a date more than 8 days ahead, or one in the past in both years, there is no reset from the text.
- AE5. Covers R14. A run that failed with status 408 is class `transient`; with 409 it is `permanent`; with 425 `transient`; with 429 `transient`.

### Scope Boundaries

#### Not in this batch

Each line is a row the triage found still true. They are cut for value or because they need a browser run or a schema change.

- OpenClaw `disableOsNotifications` applies from the first tool call (`packages/openclaw-plugin/src/index.ts:617-618`).
- No `/tidegap:reply` slash command; MCP `reply_task` serves agents.
- Three site lint warnings (`apps/web/src/app/plan/page.tsx:57`, `apps/web/src/components/best-window.tsx:30`, `apps/web/src/components/deadline-field.tsx:35`).
- A Codex adapter: a feature, not a residual.
- `tidegap ui` builds the grid feed from the env file once (`packages/cli/src/commands/ui.ts:104-109`).
- The hidden page window keeps its web view; closing it already dismantles the view.
- The URL policy reads the UI port from the ledger folder only (`packages/cli/src/channels/emit.ts:212`).
- `withFileLock` can block the UI server up to 5 s (`packages/cli/src/atomic-file.ts:32`).
- A URL secret's hint shows its host (`packages/cli/src/channels/channel-setup.ts:179`).
- S2.21 has no step for the Change-token confirm (`scripts/qa/ui-flows.mjs:379`).
- A second rate limiter in `packages/cli/src/ui/settings.ts`; the name `isIntegrationsRoute` also covers `/api/settings`.
- The 31-zone count in two tests.
- No browser test for the site video's preload and the 390 px layout.
- Two app instances can replace each other's server; no test bounds kill and start across polls.
- `WEBHOOK_PATH_HOSTS` lacks four shared hosts (`packages/core-ts/src/channels/kinds/webhook.ts:102-113`); the keep rule lives in the core and the card.
- Untested: an invalid ntfy server URL, Slack 5xx and padded bodies, an empty K13 code list, a duplicate docs page.
- The tick and the listener can both send "running again".
- Command jobs: background children, `setsid`, one output cap for stdout and stderr, the group kill in three places, the soft 1 USD cap (documented on the jobs page).
- Job pause, resume and run-now routes have no rate limit; the redacted preview logic has three copies.
- Test-tool minors: Ctrl-C in `build-test-count`, `ui-seed --serve` cleanup order, the `*.lock` guard, the `macos.yml` paths filter.
- Command jobs: a stop-signalled command fails its occurrence for good; the process-group id reuse window.
- `run-shell` keeps its stop state for the worker's lifetime.
- `jobs-runner.test.ts:348` failed once on the `TZ=Pacific/Kiritimati` leg; a second failure gets a fix brief.
- TS and Python order models with ids outside the Basic Multilingual Plane differently.
- No drift rule for the receipts page `{#receipt-models}` facts.
- `energySource` can say "measured" when a typical count was billed (needs a new signed field).
- Adapters still compute `total = input + output`; TS and Python differ when both counts arrive without a total; the unreported-count marker text has three copies.
- The CLI and the page word ages differently under 90 minutes (`packages/cli/src/commands/usage.ts:54-57`, `packages/cli/ui/dom.js:135-140`).
- The usage popover and the header room are measured in Chromium only, not in the Mac app's web view.
- The notice query has no index (no schema change in a sweep).
- `tick --db <other>` with the real `HOME` removes the default ledger's markers.
- The 400-character notice line can cut a long `result_path`.
- `queue wait` claims a notice just before it prints it.
- The MCP "outside every allowed folder" refusal is tested only in the core.
- `ServerLauncher` asks the login shell again every 60 s when a command override is set.
- The OpenClaw plugin tests see the plugin as `any`.
- The session waiter: it polls on after its hook shell is gone, a millisecond marker race with `queue add --wake`, synchronous progress writes, no test with a real signal.
- `check-hygiene` knows only the values it lists.
- Page routes read and write settings synchronously; a link into a guarded folder can stall the UI server.
- The usage `fillSetup` dialog has no unit test.
- Fractional widths between 719 and 720 px (zoom) match no header tier.
- At 720 px the Agenda row badges overlap the provider text; it needs a browser reproduction first.
- Python `cancelled` events carry provider and model; Node's do not.
- The statusLine guard has no bound on a hanging Tidegap or on stdin.
- K20 and K21 do not check order.
- "Updated … your own command is kept." also prints for a hook with no user command (`packages/cli/src/commands/statusline-setup.ts:432`).
- The local `v0.8.2` tag differs from origin; origin is canonical (a local `git fetch --tags --force`, no repo change).

Owner-only rows (23) need the owner's accounts, devices or decisions; they are not repo work.

#### Considered and not built

- A quick in-call resend of 408 and 425 (`isRetryable`, `packages/core-ts/src/scheduler.ts:4101-4116`). The task retry covers them; a resend inside the call would add a third retry layer for two rare codes.

### Sources / Research

- `apps/macos/Tidegap/WebPageWindow.swift:51-230`, `apps/macos/TidegapKit/Sources/TidegapKit/PageReload.swift`, `PageLoad.swift`, and their tests in `apps/macos/TidegapKit/Tests/TidegapKitTests/`.
- `scripts/qa/docs-drift-jobs.mjs` and `scripts/qa/docs-drift-jobs.test.mjs`: the pattern for a drift rule as a pure function with `node --test` cases.
- `packages/core-ts/test/fixtures/run-limits-vectors.json` (`classify` vectors, read by both cores).
- `packages/cli/src/providers/macos-privacy.ts:17-21` (`PROTECTED_DIRS`, the folders macOS guards).

---

## Planning Contract

### Key Technical Decisions

- KTD1. **One status rule per core (KD1).** A helper `isPermanentStatus(status)` (TS, `run-limits.ts`) and `is_permanent_status` (Python, `run_limits.py`) returns true for 400-499 except 408, 425 and 429. `classifyFailure`, `httpError` (`providers/base.ts`) and their Python twins (`classify_failure`, `http_error` in `errors.py`) call it. The in-call resend stays as it is (Considered and not built).
- KTD2. **The page window's decisions move into `TidegapKit`.** A value type `PageRouting` holds `applied`, `pending` and `restore`. A request is `(id: Int, view: String)`, because `PageView` and `PageViewRequest` are app-target types (`apps/macos/Tidegap/AppModel.swift:306-320`). It takes these events and returns the actions the coordinator runs (load a link, set a hash, report a request id):
  - `request(id:view:isLoading:)`: a view request from `updateNSView`.
  - `serverChanged(link:)`: a new page link (a port change or the first load).
  - `freshLink(restoring:)`: a replaced reload or an `expired` answer, with the view to restore or nil.
  - `finished(isErrorPage:)`: `didFinish`; `isErrorPage` comes from the main-frame response status (400 or more), read in `decidePolicyFor navigationResponse`.
  - `failed(cancelled:)`: a failed load; `cancelled` is `PageLoad.isCancelled`.
  - `hashResult(id:result:)`: the `setHash` result (KTD3).
  `WebPageWindow.swift` keeps only the WebKit calls. This follows `PageReload` and `PageLoad`, which already moved out for tests.
- KTD3. **`setHash` returns what it did.** The script returns `"set"` when it set the hash, `"later"` when it set it from a `DOMContentLoaded` listener of a document still loading, and `"reload"` when the document is complete and its hash is a `#token=` link (the page reloads itself). `"set"` and `"later"` report the request as applied: today's behaviour for a document still loading. On `"reload"` the request stays pending and the next `finished` applies it. A failed script call counts as `"set"`.
- KTD4. **`restore` belongs to one load.** `PageRouting` keeps the restored view for the fresh link it was set for and drops it at the first end of that load: a finish (set on a good page, dropped on an error page), a failure, or a cancel that no newer load follows.
- KTD5. **One drift module for the plugin texts.** `scripts/qa/docs-drift-plugin.mjs` exports pure functions for S7.3, S7.4, K22 and the two new rules. `docs-drift.mjs` passes them the file texts, the built core, its `commands` map and its `unknownFlags` function (`docs-drift.mjs:159-197`), as it does for `docs-drift-jobs.mjs`. The module has its own section reader for `###` headings, which ends at the next `#`, `##` or `###` heading; `headingSection` (`docs-drift.mjs:410-421`) ends only at `#` or `##`. The test file joins the `node --test` lists in `.github/workflows/ci.yml:60` and the `preflight` script of `package.json`.
- KTD6. **K22 sentences.** A sentence ends at `.`, `!` or `?` followed by a space and a capital letter or a backtick, except after `e.g.`, `i.e.`, `etc.` and `vs.`. A `;` does not end a sentence. The notice and command checks read only `### Claude Code with the Tidegap plugin`, through the module's `###` reader, so a fact under `### OpenClaw` or `### Another host` does not count.
- KTD7. **Two new rules.** K24: every concrete path after `--output`, `--result-path`, `output_path` or `result_path` in `packages/claude-code-plugin/**` and `packages/*/README.md` fails when it starts with `~/`, `$HOME/`, `/Users/<name>/` or `/home/<name>/` followed by a `PROTECTED_HOME_DIRS` entry (from the built core). A path in `<...>` is a placeholder and is skipped. Its vacuous-pass guard fails when the rule reads no concrete path; today that is the one in `defer.md:198`. K25: the skill has at most 260 lines.
- KTD8. **One `firstErrorLine`.** The exported helper in `notify.ts` takes an optional `max` (default today's) and returns the first line whose cleaned text (redacted, control characters stripped, spaces folded) is not empty. `channels/format.ts` drops its copy and calls it with its own `max` and fallback; its messages then fold tabs and inner spaces too, which the CHANGELOG states. `packages/cli/src/ui/summary.ts:146` keeps its call unchanged.
- KTD9. **Dated reset texts.** `resetFromText` also reads `resets <Mon> <D>[,] [at] <h>[:<mm>]am|pm [(<zone>)]` with English month names (short or long). The zone is the one in parentheses, else this machine's (as for the time-only form today). The year is the current year in that zone, or the next year when the current one gives a past instant. A result more than 8 days ahead (a weekly limit resets within 7), or past in both years, gives no reset from the text, and the fallback order stays.
- KTD10. **The install warning.** On `darwin`, `resolveLauncher` pushes one warning when the real path of `node`, of the entry script, or of `TIDEGAP_BINARY` (its branch returns early today, `install.ts:143-150`) is under `~/Documents`, `~/Desktop`, `~/Downloads` or `~/Library/Mobile Documents`. The list is a new constant: `PROTECTED_DIRS` in `macos-privacy.ts:20` is a regex over command text and lacks iCloud Drive. `resolveLauncher` gets optional `platform` and `home` arguments; its other callers pass none. The text names the folder, the hang and the fix: install the CLI from npm or keep the runtime outside these folders, with a link to the jobs page section `{#jobs-macos}`.
- KTD11. **The stop-signal tests wait on events, not on the clock.** `exited()` waits for the daemon's exit promise alone, and `within5s` becomes a poll bounded by the test's own timeout. The test timeouts (15 s, 25 s for the nested block) bound them, and the `afterEach` gets an explicit timeout above vitest's 10 s hook default. The "at once, not after the interval" claim holds because the interval is 3,600 s.
- KTD12. **The OpenClaw branch uses the existing harness.** `packages/openclaw-plugin/test/plugin.test.ts` with a failed `command` task, which no gateway adapter runs. The MCP branch is already tested (Problem Frame) and gets no new test.

### Sequencing

The four PRs share no source file. They share `CHANGELOG.md` and the generated test-count files (README markers, `apps/web/src/lib/tests.generated.ts`); PR C and PR D also share the generated docs (`apps/web/src/lib/docs.generated.ts`, `apps/web/public/llms-full.txt`). On a conflict there, take `main`'s version, run the generator and commit (`generated-test-counts-merge-conflict.md`).

| Order | PR | Branch | Units | Value | Waits on |
|---|---|---|---|---|---|
| 1 | PR A | `fix/macos-page-routing` | U1-U3 | Mac app menu and page window | none |
| 2 | PR B | `fix/plugin-texts-and-drift` | U4-U6 | Plugin texts agents read in every session | none |
| 3 | PR C | `fix/cli-notice-residuals` | U7-U9 | Notices, limit deferral, install | none |
| 4 | PR D | `fix/retry-class-and-test-gaps` | U10-U12 | Retries, CI stability, tests | none |

PR A goes first: the Mac app's menu is a daily surface. PR B follows: the skill and the commands load in every agent session. PR C changes what a user reads in a notice or at install. PR D is reliability and tests. No PR waits on another: PR A, PR B and PR C start together (at most three agents, at most two heavy builds), PR D starts when one of them finishes. Merge in the order above.

### Risks

- **The fragment navigation is hard to reproduce by hand.** U1 pins it in `PageRouting` tests; the real WebKit path is checked once by the owner after merge (Verification Contract).
- **The skill trim can drop a fact an agent needs.** K22 and S7.4 keep the pinned facts; the trim removes repetition, and the cheap-model acceptance check of `skill-file-acceptance-by-a-cheap-model.md` runs once.
- **Python and TS drift on R14.** The shared `classify` vectors and one new `http_error` test per core catch it.

---

## Implementation Units

### PR A: `fix/macos-page-routing`

Waits on: none.

### U1. `PageRouting` in TidegapKit with order tests

- **Goal:** the page window's state and order rules live in a tested value type.
- **Requirements:** R3, R4; KTD2, KTD4.
- **Files:** `apps/macos/TidegapKit/Sources/TidegapKit/PageRouting.swift` (new), `apps/macos/TidegapKit/Tests/TidegapKitTests/PageRoutingTests.swift` (new).
- **Approach:** model today's coordinator behaviour first (`WebPageWindow.swift:119-230`). Then write the two #235 cases (Goal Capsule stop conditions) as failing tests, and change `PageRouting` only where one fails.
- **Test scenarios:** a request on a loaded page sets the hash and reports once; a request during a load waits for `didFinish`; a port change keeps a pending request; a cancelled load keeps it, a failed one reports it; a restored view is used once and dropped at its load's end (AE2); a pending request wins over a restored view.
- **Verification:** `cd apps/macos/TidegapKit && swift test` passes (`Test run with N tests ... passed`).

### U2. The page window uses `PageRouting`

- **Goal:** a view request survives a fragment navigation, and `restore` never outlives its load.
- **Requirements:** R1, R2, R3; KTD3, KTD4.
- **Dependencies:** U1.
- **Files:** `apps/macos/Tidegap/WebPageWindow.swift`, `apps/macos/TidegapKit/Sources/TidegapKit/PageRouting.swift`, `apps/macos/TidegapKit/Tests/TidegapKitTests/PageRoutingTests.swift`.
- **Approach:** the coordinator forwards each WebKit event to `PageRouting` and runs the returned actions; `setHash` returns `"set"`, `"later"` or `"reload"` through the completion handler (KTD3).
- **Test scenarios:** a `"reload"` result keeps the request pending and the next finish applies it (AE1); a script error counts as `"set"`; an error page gets no restored hash (AE2).
- **Verification:** `swift test` passes; `apps/macos/scripts/build.sh` builds the app.

### U3. Mac app cleanups and CHANGELOG

- **Goal:** no deprecated activation call, no unused API method, a correct test fixture path.
- **Requirements:** R5.
- **Files:** `apps/macos/Tidegap/StatusItemController.swift` (`:192`, `:214`, `:318`), `apps/macos/TidegapKit/Sources/TidegapKit/APIClient.swift` (`activeTasks`, `:51`), `apps/macos/TidegapKit/Tests/TidegapKitTests/ConnectionTests.swift:278`, `CHANGELOG.md`.
- **Approach:** `NSApp.activate()` (macOS 14, the deployment target); fixture path `runtime/cli/dist/index.js`. CHANGELOG `[Unreleased]` `### Fixed`: the view request after a fresh link.
- **Verification:** `swift test` and `build.sh` pass with no deprecation warning from these lines.

### PR B: `fix/plugin-texts-and-drift`

Waits on: none.

### U4. S7.3 and S7.4 in a module with tests

- **Goal:** the plugin name checks have tests for their pass and failure paths.
- **Requirements:** R9; KTD5.
- **Files:** `scripts/qa/docs-drift-plugin.mjs` (new), `scripts/qa/docs-drift-plugin.test.mjs` (new), `scripts/qa/docs-drift.mjs`, `.github/workflows/ci.yml`, `package.json`.
- **Approach:** move the bodies of S7.3 and S7.4 into pure functions with no change in behaviour; `docs-drift.mjs` passes the inputs KTD5 names.
- **Test scenarios:** an unknown tool and an unknown argument fail; a tool parameter (`retry_delay`) and a field suffix (`task_id`, `result_path`) pass; an unknown slash command and an unknown `tidegap` command fail; a skill that names no tool fails.
- **Verification:** `node --test scripts/qa/docs-drift-plugin.test.mjs` passes; `node scripts/qa/docs-drift.mjs` prints `PASS` before and after.

### U5. K22 fixes and the rules K24 and K25

- **Goal:** K22 blames the right cause, and two new rules guard example paths and the skill's length.
- **Requirements:** R6, R7, R8, R9; KTD6, KTD7.
- **Dependencies:** U4.
- **Files:** `scripts/qa/docs-drift-plugin.mjs`, `scripts/qa/docs-drift-plugin.test.mjs`, `scripts/qa/docs-drift.mjs` (header comment and the K22 block).
- **Approach:** K22 moves into the module with the KTD6 splitter; K24 and K25 follow KTD7.
- **Test scenarios:** "e.g. `x`; then" stays one sentence; a notice line outside the Claude Code sub-section fails K22 with a message that names the sub-section; `--output ~/.tidegap/inbox/x.json` fails K24, `/tmp/tidegap-x.json` passes, no example at all fails; 261 lines fail K25.
- **Verification:** the test file passes. `docs-drift.mjs` fails K25 on today's skill until U6 lands; this is the one verification that U6, not U5, completes.

### U6. The skill under 260 lines and the `defer.md` session sentence

- **Goal:** the agent texts pass K22, K24, K25, S7.3 and S7.4, state the session rule truthfully, and use no past date in an example.
- **Requirements:** R6, R10.
- **Dependencies:** U5.
- **Files:** `packages/claude-code-plugin/skills/tidegap/SKILL.md`, `packages/claude-code-plugin/commands/defer.md`, `CHANGELOG.md`; a package `README.md` only if K24 finds a hit.
- **Approach:** cut repetition first (the slash command and MCP tool lists against the commands' own descriptions, `SKILL.md:203-248`); every kept sentence is checked against its defining code line (`agent-facing-text-is-a-contract.md`). `defer.md:204-207`: the server finds the session itself from the plugin's session capture, and a host without the plugin passes `origin_session_id`; it does not name `CLAUDE_CODE_SESSION_ID`. `defer.md:197`: a relative deadline (`--by 24h`). K24 has no hit on `main`, so no README changes; a hit found there is fixed in this unit.
- **Verification:** `node scripts/qa/docs-drift.mjs` prints `PASS`; `pnpm qa docs` passes once; the cheap-model acceptance check runs once and its result goes in the PR body.

### PR C: `fix/cli-notice-residuals`

Waits on: none.

### U7. The first error line with visible text

- **Goal:** notices and channel messages never show "unknown error" for an error with text.
- **Requirements:** R11; KTD8.
- **Files:** `packages/core-ts/src/notify.ts`, `packages/core-ts/src/channels/format.ts`, `packages/core-ts/test/notify.test.ts`, `packages/core-ts/test/channels-format.test.ts`.
- **Test scenarios:** AE3; a whole error of control characters gives "unknown error"; the 300- and 200-character cuts of the channel messages stay; a tab inside a channel line becomes one space.
- **Verification:** `pnpm --filter @tidegap/core test` passes.

### U8. Reset texts with a date

- **Goal:** a weekly limit defers to the date its text names.
- **Requirements:** R12; KTD9.
- **Files:** `packages/cli/src/providers/claude-code.ts` (`resetFromText`), `packages/cli/test/claude-code-adapter.test.ts`.
- **Test scenarios:** AE4, the December case included; "resets October 20 at 9:30pm"; no zone in the text uses this machine's zone; a month name with no day gives none; the existing time-only cases (`claude-code-adapter.test.ts:275-284`) are unchanged.
- **Verification:** `pnpm --filter @tidegap/cli test` passes.

### U9. The install warning and CHANGELOG

- **Goal:** `tidegap install` names the guarded-folder risk before the daemon hangs.
- **Requirements:** R13; KTD10.
- **Files:** `packages/cli/src/commands/install.ts`, `packages/cli/test/install.test.ts`, `apps/web/content/docs/10-jobs.md` (`{#jobs-macos}`: one sentence on the warning), `CHANGELOG.md`.
- **Approach:** the platform and the home folder are parameters (KTD10), so the test runs on every OS with a temp home. Without an override the entry comes from `process.execPath` and `process.argv[1]`, as `install.test.ts:192-207` sets them.
- **Test scenarios:** an entry under `<home>/Documents/...` warns once on `darwin`; a `TIDEGAP_BINARY` under `<home>/Desktop` warns; a symlink from outside into `Documents` warns (real path); `linux` does not warn; a path elsewhere does not warn.
- **Verification:** `pnpm --filter @tidegap/cli test` passes; `pnpm gen:docs` and `pnpm gen:tests` committed; `pnpm qa cli` passes once.

### PR D: `fix/retry-class-and-test-gaps`

Waits on: none.

### U10. 408 and 425 are transient in both cores

- **Goal:** a 408 or 425 answer gets the task's retry.
- **Requirements:** R14, R15; KTD1.
- **Files:** `packages/core-ts/src/run-limits.ts`, `packages/core-ts/src/providers/base.ts`, `packages/core-ts/test/fixtures/run-limits-vectors.json`, `packages/core-ts/test/run-limits.test.ts` (the vectors and a first `httpError` test), `packages/core-py/src/tidegap/run_limits.py`, `packages/core-py/src/tidegap/errors.py`, `packages/core-py/tests/test_run_limits.py`, `packages/core-py/tests/test_retries.py` (`:232-236` pins the `http_error` statuses), `apps/web/content/docs/09-config.md` (`:125`), `CHANGELOG.md`.
- **Approach:** KTD1. On `09-config.md:125` add 408 and 425 as their own clause ("by the task retry only"), not inside "a 429 or 5xx after the call's own quick resends": they get no quick resend. No other text states the 4xx rule (`tool-surface.ts` and the skill say "a rejected request", which stays true).
- **Test scenarios:** AE5 as `classify` vectors; `httpError(…, 408)` and `http_error(…, 425)` are not permanent, 404 is.
- **Verification:** `pnpm --filter @tidegap/core test`; `cd packages/core-py && .venv/bin/python -m pytest` and `.venv/bin/ruff check .`; `pnpm gen:docs` committed.

### U11. The stop-signal tests wait on the exit

- **Goal:** the daemon stop-signal tests do not depend on machine load.
- **Requirements:** R16; KTD11.
- **Files:** `packages/cli/test/jobs-tick.test.ts`.
- **Approach:** KTD11 for `exited()` (`:275-280`), `within5s` (`:252-260`) and the `afterEach` (`:287-291`); keep the `afterEach` stop.
- **Test scenarios:** the four tests of the `describe` block (`:293`, `:302` and the nested block) pass; with the stop call removed from one test, that test fails by its timeout, not by a "still running" value (checked once by hand, not committed).
- **Verification:** `pnpm --filter @tidegap/cli test` passes; the file passes 5 runs in a row with `TZ=Asia/Kolkata`.

### U12. OpenClaw `retry_task` test for a task queued for the next tick

- **Goal:** the untested OpenClaw `retry_task` branch has a test.
- **Requirements:** R17; KTD12.
- **Files:** `packages/openclaw-plugin/test/plugin.test.ts`, `CHANGELOG.md` (one PR D test line, if the PR lists tests).
- **Test scenarios:** OpenClaw returns `{ status: "scheduled", note: "runs on the next tick" }`, the row is due now, and nothing dispatches.
- **Verification:** `pnpm --filter @vitalini/tidegap test` passes; `pnpm gen:tests` committed.

---

## Verification Contract

| Check | PR A | PR B | PR C | PR D |
|---|---|---|---|---|
| `pnpm build && pnpm typecheck && pnpm gen:tests:check && pnpm gen:docs:check && node scripts/qa/docs-drift.mjs` | yes | yes | yes | yes |
| `cd apps/macos/TidegapKit && swift test`; `apps/macos/scripts/build.sh` | yes | - | - | - |
| `node --test scripts/qa/docs-drift-plugin.test.mjs` | - | yes | - | - |
| Cheap-model acceptance check of the skill (`skill-file-acceptance-by-a-cheap-model.md`), once | - | yes | - | - |
| `jobs-tick.test.ts` 5 runs in a row with `TZ=Asia/Kolkata` | - | - | - | yes |
| `pnpm --filter <package> test` for each package touched | - | - | yes | yes |
| Python: `.venv/bin/python -m pytest`, `.venv/bin/ruff check .` | - | - | - | yes |
| `pnpm qa docs` / `pnpm qa cli` (once, nothing else running) | - | docs | cli | - |
| `pnpm check:hygiene` | yes | yes | yes | yes |

### Owner check after merge

- PR A: with the page window open on Jobs, pick "Integrations…" from the menu three times in a row; each time the page shows Settings with Integrations. Then quit the `tidegap ui` server, reload the window, start it again: the window does not jump to an old view.

---

## Definition of Done

- Every unit's verification passed at the end of its PR (U5's K25 failure ends with U6), with the command output quoted in the PR body.
- Each PR has a CHANGELOG entry under `[Unreleased]` and its generated files regenerated.
- No version bump, release, publish or merge by the agent.
- No dead-end or experimental code from abandoned approaches is left in the diff.
- Each PR's `ce-code-review` has no open P0 or P1.
- PR B: the plugin texts pass K22, K24, K25, S7.3 and S7.4; the skill has at most 260 lines.
