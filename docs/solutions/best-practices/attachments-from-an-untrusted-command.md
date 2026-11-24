---
title: "Files from an untrusted command: one handle per file, type from the bytes, names the daemon makes, a download that runs nothing, and a photo that falls back to a document once"
date: 2026-11-22
category: best-practices
module: packages/cli/src/jobs/attachments.ts (intakeAttachments, readRegular, sweepAttachments), packages/cli/src/providers/command.ts (dispatch, storeAttachments), packages/cli/src/ui/server.ts (sendAttachment), packages/cli/src/channels/emit.ts (sendTelegramFile), packages/core-ts/src/channels/telegram.ts (sendFile), packages/core-ts/src/history.ts (ATTACHMENT_TYPES, attachmentDisplayName)
problem_type: best_practice
component: tooling
severity: high
applies_when:
  - "Reading files that a user's command, a script or a model wrote, to store, show or send them"
  - "Serving a stored file from the local page or another loopback route"
  - "Uploading a file to a channel (Telegram sendPhoto or sendDocument, or a new kind)"
  - "Sweeping a folder the daemon made, by age"
tags: [attachments, tidegap-attach-dir, o-nofollow, fstat, hard-link, content-type, nosniff, csp-sandbox, telegram, sendphoto, senddocument, sweep, secrets]
---

# Files from an untrusted command

## Context

Since #280 a command job can hand files to its notice: it writes them into `TIDEGAP_ATTACH_DIR`, and Tidegap stores them with the run, sends them on Telegram and offers them on the page. The command is the user's, but its output is not trusted. It can be any script, it can run a model, and it can swap a file between a check and a read. The intake runs as the user, beside the ledger, the secrets file and the channel tokens. The plan held the main rules (KTD13 to KTD16), and the review of #280 added most of the edge cases below.

## Guidance

**Intake** (`packages/cli/src/jobs/attachments.ts`):

- **A private folder per attempt.** `makeIncomingDir` makes `<root>/.incoming/<24 hex>/` with mode 0700. The variable is set after the job's secrets, so a secret with the same name cannot replace it. The folder is removed on every path (`finally` in `dispatch`, `packages/cli/src/providers/command.ts`). When the folder cannot be made, the run fails before the command starts. It does not run without the folder.
- **Open once, check the handle, read the handle.** `readRegular` opens with `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` (no link at the last name, no wait on a FIFO), then calls `fstat` on that handle: a regular file only, `nlink` 1 only, size within the cap. Every byte comes through the same handle, so a swap after the check reads nothing new.
- **A bounded buffer: `min(size, cap) + 1` bytes.** The extra byte catches a file that grew after the `fstat`. Nothing is read past it.
- **Type from the content, never from the name.** PNG, JPEG, GIF, WebP and PDF come from their magic bytes. `csv`, `txt`, `json` and `svg` come from the name, and only when the bytes are valid UTF-8 with no NUL. Anything else is `unknown type`, and its bytes past the first 12 are never read.
- **The daemon makes the stored name.** A kept file is `<task folder>/<n>.<ext>`, where the extension comes from the detected type (mode 0600, `flag: "wx"`). The name the command chose is only a display name: redacted, path marks replaced, secret values replaced, one line, no bidirectional or zero-width characters, at most 80 characters (`displayName`, `attachmentDisplayName`).
- **Text is scrubbed, binary with a secret is dropped.** Text files go through `scrubValues` and `redactPrompt`, like the output, and the scrubbed bytes are stored. The values are the job's secrets plus the host's channel secrets (`channelScrubValues` in `packages/cli/src/channels/secrets.ts`: every value in the channel secrets file, header values and the credential after their auth scheme (`Bearer <token>`), the token part of a Slack or Discord webhook URL, the Telegram bot token; 8 characters or more), read at the start of each run. A binary file that contains one is skipped with "contains a secret", because it cannot be scrubbed.
- **Caps:** 4 files in name order, 10 MB each, 20 MB per run, 50 entries looked at, 10 skipped names listed (`ATTACH_MAX_FILES`, `ATTACH_MAX_FILE_BYTES`, `ATTACH_MAX_RUN_BYTES`, `ENTRIES_MAX`, `SKIPPED_LIST_MAX`). The rest is one line: "N more files, not read: too many files".

**Serving** (`sendAttachment` in `packages/cli/src/ui/server.ts`): the route takes the page token or a `macos` client token only, never an extension token. The index must be a number of 1 to 3 digits, and the file is found by that index in the task's stored list, never by a path. Every answer carries `nosniff` and `content-security-policy: sandbox; default-src 'none'`. Only PNG, JPEG, GIF and WebP keep their type (`inline` in `ATTACHMENT_TYPES`). SVG, PDF and text go as `application/octet-stream` with `Content-Disposition: attachment` and an RFC 5987 file name, so a stored file opened on its own runs no script.

**Sending** (`sendTelegramFile` in `packages/cli/src/channels/emit.ts`): the text goes first, then each file. PNG, JPEG and WebP use `sendPhoto`, and GIF and the rest use `sendDocument` (`photo` in `ATTACHMENT_TYPES`). A `sendPhoto` refused with 400 is sent once more with `sendDocument`. Any other failure, or a second failure, is logged as `attachment <n> not sent: <why>`, and the notice still counts as delivered. A redacted task sends no file (`sendableAttachments`).

**Fixed in the #280 review, one line each:**

- An incoming folder that the command replaced by a link is not read: `lstat` first, and the skipped line says "the folder was replaced".
- Hard links are skipped (`nlink > 1`). A second name of the ledger would otherwise pass every other check.
- The intake keeps at most 1,000 entries of a listing (`LIST_MAX`) and only counts the rest, up to 100,000, so a folder of very many names does not fill memory.
- The sweep never follows a link, removes only task folders that hold nothing but `<n>.<ext>` files, and removes only `.incoming` folders with a 24-hex name (`sweepAttachments`).
- A secret value inside a file name is replaced before the name is shown.
- Text with NUL bytes is `unknown type`. UTF-16 text would slip past the scrub.
- The task folder is made without `recursive`, so a link planted at its name fails the store and is not written through.
- Zero-width characters are removed from display names.
- The download route finds a file by its index in the stored list.
- The 📎 line is capped at 300 characters (`ATTACHMENT_LINE_CHARS`).
- Telegram uploads have their own 120 s limit (`TELEGRAM_UPLOAD_TIMEOUT_MS`), not the 30 s of a message call (`TELEGRAM_CALL_TIMEOUT_MS`).

## Why This Matters

Each rule closes a way for a run's output to read, overwrite or publish a file that it does not own. Examples: a link to the secrets file, a FIFO that hangs the tick, a hard link to the ledger, an SVG with script opened from the page, a name such as `../../x`. The intake runs in the tick, so a slow read or a hang stops every other job too.

## When to Apply

- A new producer of files (a `claude-code` run, an MCP tool) uses the same intake, with no copy of it.
- A new channel kind that uploads files reads the stored list through `sendableAttachments` and keeps the "text first, files after, a failed file never fails the notice" order.
- A new route that serves stored bytes copies the `nosniff`, `sandbox` CSP and octet-stream rules.

## Examples

```ts
// Wrong: check and read by name; a swap between the two reads the swapped file
if (lstatSync(p).isFile()) bytes = readFileSync(p);

// Right: one handle; fstat and read through it (readRegular)
const fd = openSync(p, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
const st = fstatSync(fd); // isFile(), nlink === 1, size <= cap
const buf = Buffer.alloc(Math.min(st.size, cap) + 1);
```

## Deferred and rejected review findings (#280)

Start the next PR on attachments from this list.

- Rejected: run the command when its incoming folder cannot be made. The run fails, so no run completes with its files silently missing.
- P3, deferred: a secret that a text file holds JSON-escaped or CSV-doubled is not scrubbed. The scrub in `intakeAttachments` matches the literal value only.
- P3, by design: on the page a failed image fetch is cached until the drawer opens again (`blobUrl` in `packages/cli/ui/detail.js`).
- P3, deferred: no test covers the tick calling `sweepAttachments` (`packages/cli/src/commands/tick.ts`).
- P3, deferred: the sweep goes by folder age only. It does not ask the ledger whether the task is still pending.

## Related

- `channels-url-policy-and-child-process-rules.md` (the job command runner and the scrub rules)
- `telegram-channel-security.md` (the Telegram client and previews)
- `files-at-agent-chosen-paths.md` (the other direction: the daemon writes a file at a path an agent chose)
- `loopback-web-ui-hardening.md` (tokens, CSP, `nosniff` on the page)
