---
title: "Channels: URL policy, fixed-host allow-lists and the rules for Command and Shortcuts child processes"
date: 2026-10-20
category: best-practices
module: packages/cli/src/channels (url-policy.ts, http.ts, program.ts, drivers/), packages/core-ts/src/channels/kinds
problem_type: best_practice
component: tooling
severity: high
applies_when:
  - "A feature sends HTTP requests to a URL the user typed"
  - "A feature runs a program the user named, from a daemon (launchd tick)"
  - "A kind accepts only the provider's own hosts"
tags: [channels, ssrf, dns-rebinding, allow-list, child-process, launchd, command, shortcuts, process-group]
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

Related: `telegram-channel-security.md`, `safe-os-notifications-from-a-daemon.md`.
