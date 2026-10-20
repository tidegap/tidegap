---
title: "Channels: one-step Connect, a secrets file outside process.env, and one atomic writer with a lock"
date: 2026-10-20
category: best-practices
module: packages/cli/src/channels (channel-setup.ts, secrets.ts), packages/cli/src/atomic-file.ts, packages/core-ts/src/channels (registry.ts, kinds/)
problem_type: best_practice
component: tooling
severity: high
applies_when:
  - "Adding a notification channel kind or any card that stores a credential"
  - "Two processes (the CLI and tidegap ui) write the same file"
  - "A stored secret must follow, or not follow, a field the user can edit"
tags: [channels, connect, secrets, file-lock, atomic-write, keepWith, clear, registry]
---

# Channels: one-step Connect, secrets file, atomic lock

PRs #115 (registry), #117 (transport), #119 (setup module and API), #120 (card), #122 and #126 (kinds). Plan: `docs/plans/2026-10-19-integrations-all-channels.md`; wire contract: `docs/plans/2026-10-19-channels-api-contract.md`.

## One-step Connect (owner rule R1)

The owner rule: a card is one step. The user fills the fields and presses Connect (Enter submits). There is no separate Save or Test click before it.

`ChannelSetup.connect(kind, fields, {events?, quiet?, clear?})` does, in this order:

1. Merge: an omitted, `null` or empty field takes the stored value.
2. Validate against the kind descriptor (`validateFields`, `KindField.pattern` and `invalid`, `KindDescriptor.validate`).
3. URL policy check (see `channels-url-policy-and-child-process-rules.md`).
4. Send a real test message with the typed values (`event: "test"`).
5. Only then write secrets, the ledger row and `channel_last:<id>`.

A failure at 1-4 writes nothing. A second Connect for the same id shares the first test send. Why: a "Saved" card that cannot deliver is worse than an error at the moment the user still has the provider page open. Errors are placed by the route's `code` (`invalid`, `test_failed` plus `field`), never by HTTP status.

Order of side effects matters (#119 review):

- Connect rollback: a failed ledger write must not strand written secrets; a failed last-delivery write must not revert secrets under a saved row.
- `remove()` deletes the secrets before the row. A failed secrets write then leaves a visible row, not orphaned secrets.
- While a request is in flight, every control on the card waits (one `pending` flag per card, #120). A second Connect would get the first result.

## Secrets file, not the env file

Secrets of every kind except Telegram live in `~/.config/tidegap/channel-secrets.json` (0600, directory 0700). `loadEnvFileIntoProcess` copies each env-file key into `process.env`, and children other than `claude -p` inherit it. The secrets file is read on every send and never enters `process.env`. A malformed file reads as empty and is kept as `.bak` on the next write. Answers carry hints only: last 4 characters, plus the host for a URL (`host …abcd`, with `http://` in front when not https, so the card can read the origin back; `stored` for a very short value).

A hint that shows the host is itself a secret for capability-URL hosts (Pipedream); this is a known open item.

## One writer, one lock

`setEnvFileKey` and `writeSecrets` share `packages/cli/src/atomic-file.ts`. The CLI and `tidegap ui` can write at once, so a read-modify-write needs a lock held over the whole cycle, not just an atomic rename.

- Lock file `<file>.lock`, created exclusively, held over read, modify and write.
- Write path: 0600 temp file in the same directory, fsync, rename, directory fsync.
- Stale lock: older than 3 s (shorter than the 5 s wait, so a waiter can take over). The taker first renames it to a name only it knows, then deletes it. Two takers that both saw it stale cannot both move it. If the moved file turns out fresh, it is put back.
- A writer deletes the lock only while the inode is still its own.
- `withFileLock` blocks the UI event loop up to 5 s while a CLI writer holds the lock (accepted, listed as a follow-up).

The first version (#119 before review) used a 10 s stale age and plain delete. The review found the double-takeover race.

## keepWith and clear[]

`KindField.keepWith: "<owner field>"` (#122): an empty secret input reuses the stored secret only while the owner field's origin is unchanged. ntfy token follows `server`; webhook secret and headers follow `url`; SMTP password follows `host`. A new host drops the stored secret, so a secret never follows an address the user retyped. Origins are compared, not paths: multi-tenant hosts (`*.logic.azure.com`, `hooks.zapier.com`) keep the secret across a new path (known limit). The card compares origins by the same rule as the server, using the hint (#126 fix: http to https shows "Not kept").

Empty means keep, so a user could not remove an optional secret. `clear: string[]` (#126) fixes it: names of the kind's optional secret fields; their stored values are dropped on success. A required secret or a non-secret name is 400 `invalid`. A value typed for the same name wins over `clear`. The card says "Stored" only while the server keeps the value; optional stored secrets get Clear/Keep.

## Review lessons

- Test fixtures never hold a real-looking key. The SMTP test certificate is generated with `openssl` at test time (#126).
- A new kind needs: descriptor, driver, a fake receiver case under `scripts/qa/channels/<kind>.mjs`, and the secrets-log check ("fixture secret values: 0 hits in test output and the QA log").
- Related: `shared-setup-module-for-cli-and-local-settings-api.md`, `telegram-channel-security.md`.
