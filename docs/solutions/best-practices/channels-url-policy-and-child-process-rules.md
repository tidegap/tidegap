---
title: "Channels: URL policy, fixed-host allow-lists and the rules for Command and Shortcuts child processes"
date: 2026-10-20
category: best-practices
module: packages/cli/src/channels (url-policy.ts, http.ts, program.ts, drivers/), packages/core-ts/src/channels/kinds
problem_type: best_practice
component: tooling
severity: high
last_updated: 2026-10-27
applies_when:
  - "A feature sends HTTP requests to a URL the user typed"
  - "A feature runs a program the user named, from a daemon (launchd tick)"
  - "A kind accepts only the provider's own hosts"
  - "Running a job's shell command or handling its secrets and output (jobs command runner)"
tags: [channels, ssrf, dns-rebinding, allow-list, child-process, launchd, command, shortcuts, process-group, jobs, secrets, scrub, signals, sdk-timeout]
---

# Channels: URL policy and child-process rules

PRs #117 (policy, transport), #122 and #126 (kinds, Command and Shortcuts). The tick runs these as the user, with no prompt, so each input is treated as hostile.

## URL policy (user-typed URLs: webhook, ntfy server)

Rule: allow the user's own network, block a short list. LAN receivers (Home Assistant, self-hosted ntfy, n8n) are core use, so private and loopback hosts are allowed.

- Allowed: `http` and `https`, any host not on the block list.
- Blocked: other schemes, userinfo in the URL, link-local (169.254/16, fe80::/10; cloud metadata at 169.254.169.254), AWS and GCP IPv6 metadata, Alibaba 100.100.100.200, unspecified (0.0.0.0/8, `::`), and the `tidegap ui` loopback port (discovery file plus the default).
- Forms of the same address are listed explicitly: IPv4-mapped IPv6 (`BlockList` maps it), NAT64, 6to4 and IPv4-compatible forms of 169.254/16.
- Plain http to a non-private host passes with the warning `cleartext`.
- The check runs twice: on the literal host at connect, and again inside the socket's DNS lookup on every returned address (`checkAddress`). A name that rebinds to a blocked address is refused on the connection that would use it. SMTP resolves through the same check.
- Redirects are never followed. At most 4 KiB of the answer is read. Errors carry a code only, never the URL or body. EPROTO (failed TLS handshake) maps to `tls`, with no retry (the review's TLS test found it had been retried as `network`).
- 20 s cap per job, 3 attempts on network error, 5xx or 429; waits 1 s and 3 s or `Retry-After` when at most 10 s. All attempts carry one `X-Tidegap-Delivery`.

Known gap: `uiPortsFor(dirname(dbPath))` misses a non-default UI port with a legacy ledger or `--db`.

## Fixed-host allow-lists and the look-alike cases

Slack, Discord and Pushover talk to the provider only (plus loopback, for the fake receiver). The pattern is anchored with the path, so a host that merely starts with or contains the provider name fails.

| Input | Result |
|---|---|
| `https://hooks.slack.com/services/T0/B0/abc` | ok |
| `https://hooks.slack.com.evil.com/x` | refused (look-alike suffix) |
| `http://hooks.slack.com/services/...` | refused (scheme) |
| `https://hooks.slack.com/workflows/...` | refused (wrong path) |
| `discord.com`, `discordapp.com`, `canary.discord.com`, `ptb.discord.com` `/api/webhooks/<id>/<token>` and `/api/v10/webhooks/...` | ok |
| `https://discord.com.evil.com/api/webhooks/1/x` | refused |
| `https://discord.com/api/channels/1` | refused (not a webhook path) |
| `http://127.0.0.1:4100/...`, `localhost`, `[::1]` | ok (loopback test sink only) |

Pushover posts to the fixed `https://api.pushover.net/1/messages.json`. `TIDEGAP_PUSHOVER_API_BASE` is honoured for loopback only; another value is ignored with one log line. Write each new fixed-host kind with a look-alike case in its test before the happy path.

CodeQL flagged `js/polynomial-redos` on trimming slashes from the ntfy server URL (#122). Trim without a regex (`6637fc1`), as in `telegram-channel-security.md`.

## Child processes: Command and Shortcuts

Command runs a user-named program with the Tidegap JSON on stdin. Shortcuts runs `shortcuts run <name> --input-path <0600 temp file>`. Rules, all enforced in `program.ts` and `runChild`:

1. **Owner-owned, not writable by others.** `checkProgram` before every run (connect and each send): absolute path, executable regular file, owned by this user, no group or world write bit on the file or on its folder. For a symlink both ends are checked and the resolved path runs. Anything else could be swapped by another account and then run as this user from the tick. Error code `unsafe_path`.
2. **Root-owned programs are refused** (a root-owned file fails the owner check). Use a wrapper script in your own folder. Shortcuts runs the system `/usr/bin/shortcuts` unchecked; a `TIDEGAP_SHORTCUTS_BIN` override passes the same check or nothing runs (fails closed, never falls back to the real tool, so QA never runs a real Shortcut).
3. **No shell.** `spawn(file, argv, {shell: false})`, Command: one argv item per line, at most 10 items, no NUL. Shortcuts: a name starting with `-` or holding a control character is refused.
4. **Minimal env** (PATH, HOME, LANG, TMPDIR), working directory is the home folder. Secrets never enter the child env.
5. **Process-group kill.** `detached: true`; at 20 s `process.kill(-pid, "SIGKILL")` kills the group (a pending macOS prompt hangs a launchd child; see `running-claude-p-from-a-daemon.md`). Fallback to `child.kill`.
6. **Stderr cap.** Stdout is ignored. Stderr is kept up to 64 KiB for error mapping, the rest dropped without killing the child. It never reaches a notification, log line or API answer.
7. **The run ends at exit, not at pipe close.** A program that starts background work must not hold the send for 20 s. After exit, 250 ms of grace for the last stderr bytes, then the pipes are destroyed. (First version used `execFile`, which waits for the pipes.)
8. The temp file is removed on every path.

### launchd PATH caveat

Command and Shortcuts take PATH from the host process. A `#!/usr/bin/env node` script can pass Connect from a shell and fail with exit 127 under launchd, where PATH is minimal. Use an absolute interpreter in the shebang or a wrapper script that sets PATH. The Notifications docs page says so.

## Job commands: the two exceptions and what still holds (PR #150)

A command job runs `/bin/sh -c <command>` from the tick (`packages/cli/src/jobs/run-shell.ts`, `packages/cli/src/providers/command.ts`). It breaks two rules above on purpose and keeps the rest.

- **Exception 1, a shell.** The command string is written by the user on the page or in the CLI only, never by an agent (KD10). The Claude Code guard asks before an agent runs `tidegap jobs add --command` (`agent-hooks-for-scheduling-intents.md`).
- **Exception 2, secrets in the child env.** Only the secrets the job names enter the env, on top of an allowlist (`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_*`, `TMPDIR`, `TZ`). Provider keys from the env file never do (`childEnv`).
- **Secret values come from stdin only.** `tidegap jobs secrets set <NAME>` reads the value from stdin and echoes the name. No flag, no argv, no HTTP route takes a value; the page and the CLI list names only. Argv shows up in `ps` and shell history. Names match `^[A-Z][A-Z0-9_]{0,63}$` (`JOB_SECRET_NAME`). The file is `job-secrets.json` (0600, separate from channel secrets, atomic write, not read when another user owns it or the group or others can write it).
- **Kept:** own process group (SIGTERM to the group at the timeout, SIGKILL 5 s later), stdin closed, the run ends at the shell's exit plus 250 ms of pipe grace, stdout capped (`outputCapBytes`, 10 MiB by default) without stopping the command. Stderr has its own rolling 4 KiB tail, so a command that fills the stdout cap and then fails still reports why (PR #163).
- **Command groups stop with the tick (PR #163, `run-shell.ts`).** The runner tracks each live group. SIGTERM or SIGINT to the tick sends each group SIGTERM, then SIGKILL when its shell exits or the grace ends, whichever comes first; a second signal sends SIGKILL at once. The `exit` listener sends SIGKILL at once, because exit listeners run synchronously and cannot wait. The stop stays in force for the rest of the process: a run that starts after the signal is stopped at once. When the runner's handler is the only listener, it raises the signal again once no stopped group waits for its SIGKILL, so `tick --once` keeps its default signal exit; the daemon has its own listener and stops dispatching instead (PR #170). Not covered: a tick ended by SIGKILL or a crash runs no handler, and a child that calls `setsid` leaves the group. The jobs docs state both.
  - **Keep the stop as process state, not a snapshot.** The first version of #163 sent the grace-end SIGKILL to the groups that were live when the signal came. The scheduler kept dispatching during the grace, so a command that started then got no signal and outlived the tick (review P1, reproduced: tick exit 143, the second group alive). Now `trackGroup` stops a new group at once while a stop is in force, and the grace-end and exit kills cover every live and stopped group.
  - **Re-raise as soon as no stopped group waits, not after the grace.** The shell dies within milliseconds of SIGTERM. A runner that waited the full grace let the tick go on to its next due rows, return, and exit with its code (`process.exit(code)`, `packages/cli/src/index.ts:137`) before the grace ended: exit 1, and new work started after a stop. A kill test whose stub tick stays alive with `setInterval` cannot see this; the test "a tick that would go on after the stop" can.
  - **"Alone" is decided at the first signal** (`process.listenerCount(signal) === 1`). The daemon registers its own listener first, so the runner never re-raises there; the daemon stops on its `AbortController` instead (#170). The stop state is module-level and never reset, so a later `runShell` in the same process (or the same test worker) is stopped at once.
- **Scrub every string before it leaves, including at a cut.** `scrubValues` replaces each named secret value (longest first, literal match, values shorter than `SCRUB_MIN_LENGTH` are skipped). A byte cap or the 4 KiB stderr tail can cut a value in half, which a literal match misses. `scrubCutEdges` (`packages/core-ts/src/redact.ts`) removes the longest fragment of any value at each cut edge, drops a trailing token that starts with a vendor key prefix (`VENDOR_KEY_PREFIXES`, the prefixes `DEFAULT_REDACTION_PATTERNS` match) and a leading token of 16+ token characters, and the U+FFFD a cut leaves inside a UTF-8 sequence. At a cut start the removed length is the longer of the value fragment and the leading token. The first version checked the leading token only when no value fragment matched, so a key tail survived whenever its first character equalled the last character of any secret value (a 1-character fragment; #163 review, about 1 in 64 per value). A new pattern in `DEFAULT_REDACTION_PATTERNS` adds its prefix to `VENDOR_KEY_PREFIXES` and a sample key to `packages/core-ts/test/redact.test.ts`, which fails when a pattern has no sample. Call it after `scrubValues`, only for an edge that was cut. It uses a loop, not a `+$` regex, which is quadratic on a long U+FFFD run.
- **Never run the command twice by accident.** Every error from the adapter is a `NonRetryableError`; the summarize call is retried inside the adapter instead. The job's slot retry is skipped when the failure came after the command ran (`../logic-errors/floating-jobs-occurrence-sweep.md`).
- **Record which cap stopped the run** as `stopped_by` (`command_timeout`, `llm_timeout`, `budget`) in the event details, so the page and the history can say why.
- **Give an SDK client the same timeout as the cap.** The Anthropic and OpenAI SDKs abort a non-streaming request at their own default (10 minutes) with a plain "Request timed out." and no details. A job whose LLM time limit is longer was cut at 10 minutes with no `stopped_by`. `withLlmTimeout` (`packages/core-ts/src/providers/timeout.ts`) passes `{ signal, timeout }` with the clamped limit to the SDK call, so the adapter's own timer is the only clock that fires. A new SDK-based adapter passes both.

Related: `telegram-channel-security.md`, `safe-os-notifications-from-a-daemon.md`.
