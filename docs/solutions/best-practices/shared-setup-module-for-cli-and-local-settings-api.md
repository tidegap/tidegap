---
title: "Shared setup module for a CLI and a local settings API: a secret in an env file, a third auth route class, and per-bot state"
date: 2026-10-19
category: best-practices
module: packages/cli/src/channels/telegram-setup.ts, packages/cli/src/ui (server.ts, integrations.ts), packages/cli/ui/integrations.js, packages/cli/src/commands/env-file.ts
problem_type: best_practice
component: tooling
severity: high
applies_when:
  - "A CLI flow (pairing, setup, secrets) gets a second front end in the local web page or a native app"
  - "A long-running local server reads a secret that the user can change while it runs"
  - "A route must be open to the page and the Mac app but closed to browser extensions"
  - "State in the ledger belongs to one external identity (a bot, an account) that the user can swap"
  - "An async start() guards a singleton session, or a page polls while the user acts"
tags: [telegram, settings, env-file, secrets, client-tokens, extension-origin, offset, heartbeat, race, polling]
---

# Shared setup module for a CLI and a local settings API

## Context

PR #96 (open at the time of writing) moves Telegram setup from the CLI (`tidegap channels add telegram`) into Settings → Integrations in the `tidegap ui` page and the Mac app. The CLI had grown its rules one bug at a time (env-file token parity, one poller, a webhook check, no token in errors). A second front end that re-implemented them would drift. Moving the flow into a long-running server also exposed state that a one-shot CLI never had to handle: a token that changes while the process runs, a pairing that outlives one request, and the identity of the bot behind stored state.

## Guidance

**1. One setup module, two thin front ends.** `TelegramSetup` (`packages/cli/src/channels/telegram-setup.ts`) owns status, save token, pairing, test message, start listener and disconnect. The CLI keeps its own output by passing callbacks (`pairTelegram` gained `onCode`, an abort signal and a failure `reason`; the CLI's `onCode` prints the same three lines). The API routes (`packages/cli/src/ui/integrations.ts`) only parse, rate-limit and map `TelegramSetupError.code` to a status. Error text is a fixed sentence per code (`SETUP_TEXT`), never exception text.

**2. The secret lives in one file and is read on every use.** The token is written only to `~/.config/tidegap/env` by `setEnvFileKey` (`packages/cli/src/commands/env-file.ts`): resolve a symlink, keep every other line byte for byte, write a 0600 temp file, fsync, rename. Readers call `envFileTelegramToken()` per request or per tick, never `process.env`: `loadEnvFileIntoProcess` never overwrites a key, so a long-running `tidegap ui`, or a `tick --daemon` the page started, would keep the old token (`packages/cli/src/commands/tick.ts:197`). The API returns the last 4 characters only.

**3. A third route class, decided by origin and token kind.** The loopback server had page-only and agent-facing routes. `/api/integrations*` is a third class: the page token, or a client token whose registry entry has `kind: "macos"`, and never an extension origin whatever the token (`packages/cli/src/ui/server.ts:334`). The Mac web view carries the `macos` client token, not the page token, so page-only would lock the app out. Checking the origin, not only the kind, means a `macos` token pasted into an extension still gets 403. The match uses the router's segment split (`isApiRoute`, `server.ts:176`), so `/api//integrations` cannot pass, the same lesson as `client-tokens-and-extension-origins.md`.

**4. State tied to an external identity carries that identity.** Telegram update ids are per bot. A stored `telegram_update_offset` from bot A, higher than bot B's ids, makes `getUpdates` confirm and drop every update of B. The ledger now stores `telegram_bot_id`; `syncBotId` (`packages/cli/src/channels/serve.ts:84`) clears the offset when `getMe().id` differs. Clearing is always safe, because Telegram forgets confirmed updates. For ledgers written before the key existed, the previous token's numeric prefix is the bot id (`telegram-setup.ts:367`). Stop the old bot's listener before resetting the offset (`telegram-setup.ts:370-372`), or its last poll can store its offset under the new id.

**5. Health from a heartbeat, not a process probe.** The listener writes `telegram_listener` meta at start-up and after poll cycles, only on a state change or once a minute. `conflict_at` survives later `ok` writes, because two pollers take turns and the latest state alone flickers (`serve.ts:184`). The status reads ages: `unauthorized` under 11 minutes (the listener sleeps 10), conflict under 3, any beat under 3 is running. This also catches a loaded unit that cannot poll, which `launchctl print` would call healthy.

**6. Write units with the installed launcher, not this process's argv.** `resolveLauncher` reads the calling process's argv. Inside `tidegap ui` started by the Mac app with a command override, that is a transient repo build. The listener unit takes the words before `tick` from the installed tick unit's `ProgramArguments` or `ExecStart` (`installedTickLauncher`, `telegram-setup.ts:72-90`, used at `:116`).

**7. Claim a singleton before the first await.** `startPairing` checked `this.session` but set it after `getMe`, `getWebhookInfo` and the unload. Two Connects (page plus Mac app) started two pollers, which then 409 each other, and the first could no longer be cancelled. Now `this.starting` is set synchronously; a second caller awaits it, and abort also stops a pairing that is still starting (`telegram-setup.ts:386-414`, `:437`).

**8. A polling page needs a generation counter.** `repoll()` cleared a timer that had already fired, so an in-flight poll scheduled its own timeout next to the new chain, and its older answer overwrote the action's newer state. Each poll captures `m.gen`, drops a stale answer and does not reschedule; every action calls `stopPolls()` first (`packages/cli/ui/integrations.js:164`, `:188`). A card rebuild keeps a half-typed password field and its focus (`integrations.js:222`).

## Why This Matters

Items 4, 7 and 8 passed every planned test and the first browser QA; review found them by reasoning about upgrade paths and interleavings. Item 4 is silent: the card says "paired" while Telegram drops every message. Item 2's stale token and item 6's wrong launcher would show only on a user's Mac, under launchd, after the session that set things up is gone.

## When to Apply

- Adding a page or app screen for anything the CLI already sets up (other channels, provider keys).
- Any server-held session started by a request (pairing, OAuth device flow, an import).
- Any ledger value whose meaning depends on an external account, bot or key the user can replace.

## Examples

Tests that pin these rules: `packages/cli/test/telegram-setup.test.ts` (other bot and same bot token change, legacy chat without `telegram_bot_id`, two Connects at once, disconnect during start, launcher from the tick unit), `packages/cli/test/ui-server.test.ts` (integrations auth matrix with double-slash paths), `packages/cli/test/tick-channels.test.ts` (token saved after the first tick is used by the second), `packages/cli/test/channels-serve.test.ts` (heartbeat states). The fake Telegram server gained `setToken(token, {id})` to model a token change (`packages/core-ts/test/fixtures/fake-telegram.ts`).

Related: `telegram-channel-security.md` (chat-id auth, offset before run, env-file parity), `client-tokens-and-extension-origins.md` (path normalisation, client tokens), `loopback-web-ui-hardening.md` (POST-only body rules), `dependency-free-task-ui-patterns.md` (text-only rendering, token in memory).
