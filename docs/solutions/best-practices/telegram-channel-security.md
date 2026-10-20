---
title: Telegram channel security: chat-id auth, offset before run, no token in errors, env-file token parity
date: 2026-10-17
category: best-practices
module: packages/cli/src/channels (serve.ts, pair.ts, listener.ts), packages/cli/src/commands/channels.ts, packages/core-ts/src/channels
problem_type: best_practice
component: tooling
severity: high
applies_when:
  - "Adding a bot or webhook that can run commands on the user's machine"
  - "Running a long-poll loop under launchd or systemd"
  - "Pairing a chat with a secret that lives in an env file"
tags: [telegram, bot, authentication, long-poll, offset, secrets, launchd, keepalive]
---

# Telegram channel security

PR #81 (U12-U15). The bot can cancel, postpone and run tasks, so a stranger who finds the bot must get nothing.

## Rules

- **Auth is the chat id, read from the ledger at the moment of the update.** An update runs only when its chat id belongs to an enabled `telegram` channel row. Anything else gets no reply and writes nothing (a reply confirms the bot exists). `channels remove` takes effect on the next update. The chat id comes from `message.chat.id`, else `callback_query.message.chat.id`, else `callback_query.from.id`.
- **Pairing is a one-time 6-digit code.** Only the private chat that sends `/pair <code>` or `/start <code>` pairs. A wrong code stops pairing. `getMe` checks the token first, and a bot with a webhook is refused: pairing needs a dedicated bot that nothing else polls (two pollers get 409 and steal updates).
- **Store the offset before the update runs.** `telegram_update_offset` in ledger meta is set to `update_id + 1` before the handler. A crash or restart in the middle of `/cancel` then never replays it. The price is that one update can be lost; for commands that change tasks, losing one is safer than running one twice. Pairing moves the offset past the `/pair` update for the same reason.
- **The token never appears in an error or a log line.** The client takes the token, base URL and `fetch` as arguments and builds errors from the method name and status only. Log lines carry `method + status`. A 401 logs and sleeps 10 minutes; 409 or a network error backs off 5 s doubling to 60 s.
- **`TIDEGAP_TELEGRAM_API_BASE` is honoured only on loopback http** (for tests). The trim is done without a regex after CodeQL flagged `js/polynomial-redos`.
- **Previews:** a done message shows 600 characters of the result, none for a task with `redactInReceipt`.

## Env-file token parity

The launchd or systemd listener unit (`com.tidegap.channels` with `KeepAlive`, `tidegap-channels.service`) reads the env file only, not the shell. A token exported in the shell would pair a chat that the listener can never answer. So `channels add telegram` refuses when the env file lacks the token or holds a different one, with the exact file path in the message. Escapes: `--no-load` and running `tidegap channels serve` by hand.

Why a separate unit and not the tick: the tick is a one-shot every few minutes; a long-poll needs a process that stays up. `KeepAlive` restarts it, and the offset rule makes restarts safe. Removing the last Telegram channel unloads the unit.

Related: `loopback-web-ui-hardening.md`, `client-tokens-and-extension-origins.md` (a client token gets 403 on `POST /api/tasks`, and an extension token on `/reply`: a stolen extension token can read and reschedule but cannot create work; a `macos` token can reply to a finished task).

## Settings → Integrations (PR #96)

Setup now lives in one shared module, `packages/cli/src/channels/telegram-setup.ts`, used by the CLI and by the `/api/integrations/telegram/*` routes (`packages/cli/src/ui/integrations.ts`). The rules above still hold; these were added:

- **Who may call the routes:** the page token or a `macos` client token, never an extension origin (403, whatever the token). Routes are rate-limited per server (429 with `retry_after_s`).
- **The token is never echoed.** A status shows `token_hint`, the last 4 characters only. Error bodies are one fixed sentence plus a code, never a token, path or exception text. The MCP server has no tool for these routes.
- **Env-file writer:** the token is saved to the env file with `setEnvFileKey`, so the listener unit (which reads only that file) sees it. `disconnect` with `forget_token` deletes the token lines.
- **A bot change resets the update offset** and drops the paired chat, because update ids are per bot (`telegram_bot_id` meta). The old bot's listener is stopped first so it cannot store its offset under the new bot id.
- Plan: `docs/plans/2026-10-19-integrations-settings.md`. Route table: `docs/spec/ui-client-api.md`.

## Other channel kinds (all-channels plan, KTD4 and KTD6)

Webhook, Slack, Discord, ntfy, Pushover, email and Shortcuts do not use the env file. Their secrets live in `~/.config/tidegap/channel-secrets.json` (0600, directory 0700), because `loadEnvFileIntoProcess` copies every env-file key into `process.env` and children other than `claude -p` inherit it. The setup module is `packages/cli/src/channels/channel-setup.ts`; answers carry hints only (last 4 characters, plus the host for a URL). The env file and the secrets file share one writer helper, `packages/cli/src/atomic-file.ts`: a `<file>.lock` held over the whole read-modify-write, then temp file, fsync, rename, so the CLI and `tidegap ui` writing at once cannot drop each other's change. A lock older than 3 s belongs to a crashed writer: the taker renames it to its own name before deleting it, so two takers cannot both get in, and a writer deletes the lock only while it is still its own (same inode). The rename is followed by a directory fsync. The Telegram token is the known exception that stays in the env file (plan Q2). Contract: `docs/plans/2026-10-19-channels-api-contract.md`.
