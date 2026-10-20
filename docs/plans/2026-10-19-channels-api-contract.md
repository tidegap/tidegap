---
title: Channels API contract (S3a ↔ S3b)
date: 2026-10-20
plan: docs/plans/2026-10-19-integrations-all-channels.md (KTD6, KTD7, U3)
---

# Channels API contract

The routes the shared channel card (S3b, `packages/cli/ui/`) calls. S3a implements them in `packages/cli/src/channels/channel-setup.ts` and `packages/cli/src/ui/integrations.ts`. This file is the source of truth for both streams; a change here is a change to both.

## Access and body rules

- Same as every `/api/integrations*` route: the page token, or a `macos` client token without an extension origin. Any other caller gets 403 (R16).
- `POST` only for actions. A route marked "JSON" needs `Content-Type: application/json` and a JSON object (64 KiB max). A route marked "none" takes no body (400 if one is sent).
- One channel per kind: a channel id equals its kind (`webhook`, `slack`, …). Telegram rows keep their ids (`telegram-<chat id>`).

## Types

```ts
/** A kind descriptor without its functions (core-ts `KindDescriptorData`). */
type KindDescriptorData = {
  kind: string; label: string; description: string; platforms?: string[]; ready: boolean;
  fields: { name; label; input: "text"|"password"|"url"|"select"|"number"|"textarea"; required?; secret?;
            default?; placeholder?; pattern?; options?: {value, label}[]; help?; advanced?; min?; max?;
            maxLength?; maxLines?; invalid?: string; keepWith?: string }[];
  presets?: { id; label; values: Record<string, string|number>; note? }[];
  steps: { text: string; link?: string }[];   // at most 4
  defaultEvents: EventKind[]; docsAnchor: string; worksWith?: string;
};

type EventKind = "task_done" | "task_failed" | "clean_window" | "not_ready" | "digest";

type ChannelStatus = {
  id: string;                       // = kind; Telegram: "telegram-<chat id>"
  kind: string;
  state: "connected" | "disconnected" | "error";
                                    // connected: enabled, last delivery ok or none
                                    // error: enabled, last delivery failed
                                    // disconnected: settings kept, sends nothing
  target: string;                   // one line, no secret: "hooks.slack.com …abcd", "you@example.com"
  fields: Record<string, string | number>;   // non-secret values only
  secrets: Record<string, string>;  // field name → hint, never the value:
                                    //   URL fields: "<host> …<last 4>"; others: "…<last 4>";
                                    //   values shorter than 12 characters: "stored"
  events: EventKind[];
  quiet: "night" | "off";
  last?: { at: string; ok: boolean; code?: string };   // last delivery (ledger meta channel_last:<id>)
  error?: string;                   // state "error": the sentence for last.code
  warning?: "cleartext";            // a URL field is plain http to a host outside the user's network
};

/** Every error body. */
type ApiError = {
  error: string;                    // one sentence that says what to do; show it as is
  code: string;                     // see "Error codes"
  field?: string;                   // the field the error is about: show the sentence under it
  delivery?: string;                // the mapped delivery code (http_404, auth, timeout…), for logs and tests
  retry_after_s?: number;           // 429 only
};
```

## Routes

| Route | Body | Success | Errors |
|---|---|---|---|
| `GET /api/integrations` | — | 200 `{telegram, kinds: KindDescriptorData[], channels: ChannelStatus[]}` | — |
| `POST /api/integrations/channels/connect` | JSON `{kind, fields?, events?, quiet?, clear?}` | 200 `{channel: ChannelStatus}` | 400 `invalid`, 404 `unknown_kind`, 409 `test_failed`, 502 `unreachable`, 429, 500 |
| `POST /api/integrations/channels/<id>/test` | none | 200 `{sent: true, channel}` | 404 `not_found`, 409 `not_connected`, 409 `test_failed`, 502 `unreachable`, 409 `telegram`, 429, 500 |
| `POST /api/integrations/channels/<id>/disconnect` | none | 200 `{channel}` | 404, 409 `telegram`, 500 |
| `POST /api/integrations/channels/<id>/remove` | none | 200 `{removed: true}` | 404, 409 `telegram`, 500 |
| `POST /api/integrations/channels/<id>/settings` | JSON `{events?, quiet?}` (at least one) | 200 `{channel}` | 400 `invalid` (`field`: `events` or `quiet`), 404, 429, 500 |

- `kinds` lists the kinds that are `ready` and run on this platform, in card order, Telegram included (the Telegram card keeps its own `/api/integrations/telegram/*` routes).
- `channels` lists every set-up channel of a listed kind, Telegram rows included (so the Telegram card can show events and quiet). A kind with no entry is "not set up".
- `connect`, `test`, `disconnect` and `remove` on a Telegram id answer 409 `telegram`: use the Telegram routes. `settings` accepts Telegram ids.

## Connect: one step

`POST /api/integrations/channels/connect` is the card's only primary action: first setup, Edit, and Connect on a disconnected card.

1. Merge: every field that is omitted, `null` or an empty string takes the stored value (secrets from `channel-secrets.json`, non-secret fields from the row). So `{kind: "slack", fields: {}}` reconnects a disconnected Slack card, and Edit with an empty secret field keeps the stored secret (R7, R8). Exception: a secret field with `keepWith` (the ntfy token with `server`, the webhook signing secret and headers with `url`) takes its stored value only while that field's origin is unchanged; with a new host the empty secret stays empty and is removed on success. Second exception: a field named in `clear` never takes its stored value; empty, it stays empty and its secret is removed on success.
2. Validate the merged values against the descriptor. Failure: 400 `invalid` with `field`.
3. URL policy on every URL field (scheme, userinfo, link-local, the Tidegap page's own port). Failure: 400 `invalid` with `field`.
4. Send one test message with the candidate values.
5. Only when the test succeeds: write the secrets, insert or replace the row with `enabled: true`, record the last delivery as ok. Answer 200 `{channel}`.

On any failure nothing is written: no row, no secret, no last-delivery record. An existing channel keeps sending with its old values. Two connects for the same kind at once share one test send and one answer.

- `events` (optional): replaces the stored events. Absent: the stored events, else the descriptor's `defaultEvents`.
- `quiet` (optional): `"night"` or `"off"`. Absent: the stored value, else `"off"`.
- `clear` (optional): an array of the kind's optional secret field names (the ntfy token, the webhook signing secret and headers, the SMTP password when the server needs no login). This is the only way to remove an optional secret: an empty field means "keep". A value typed for the same name in `fields` still applies. A required secret: 400 `invalid` with `field` = that name. A name that is not a secret field of the kind, or a value that is not an array of strings: 400 `invalid` with `field: "clear"`.
- Unknown keys in `fields` are ignored. Unknown top-level keys are a 400.

## Test, disconnect, remove, settings

- `test` sends one test message with the stored values to an enabled channel and records the result as the last delivery (ok or failed), so a failed test turns the card to `error`.
- `disconnect` sets `enabled: false`; settings and secrets stay.
- `remove` deletes the row, its secrets and its last-delivery record. The kind is then "not set up".
- `settings` changes `events` and/or `quiet` at once (no test send). `events` is an array of `EventKind`, duplicates dropped, stored in `EventKind` order; an empty array is allowed (the channel sends nothing).

## Error codes

| HTTP | `code` | When |
|---|---|---|
| 400 | `invalid` | Bad body shape, a field value (`field` = the field), a URL refused by the policy (`field` = the URL field), bad `events` or `quiet` |
| 404 | `unknown_kind` | `connect` with a kind that does not exist, is not ready, or does not run on this platform |
| 404 | `not_found` | No channel with this id |
| 409 | `test_failed` | The receiver answered and refused the test (4xx, redirect, auth, TLS, blocked address). `field` when one field is at fault |
| 409 | `not_connected` | `test` on a disconnected channel |
| 409 | `telegram` | A Telegram id on `connect`/`test`/`disconnect`/`remove` |
| 502 | `unreachable` | No answer: network error, timeout, 5xx, or the receiver's rate limit |
| 429 | `rate_limited` | Over this server's limit; wait `retry_after_s` |
| 500 | `internal` | The ledger or the secrets file could not be written. Fixed sentence, no exception text |

Rate limits (per server process): connect 10 per minute, test 1 per 10 s per channel id, settings 30 per minute.

## Secrets

- A secret value never appears in any answer, log line or error. `GET` and every `{channel}` show hints only.
- The card sends a secret field only when the user typed a value; an empty secret field keeps the stored one.
- The card says "Stored …" only while the server keeps the value: an optional stored secret has a Clear control (it then says "Not kept" and its name goes in `clear`), and a `keepWith` secret says "Not kept" as soon as its owner field holds a new origin (for a secret owner such as the webhook URL, the page compares the host in the hint).

## Example

```http
POST /api/integrations/channels/connect
{"kind": "webhook", "fields": {"url": "https://example.com/hooks/tidegap"}}

200 {"channel": {"id": "webhook", "kind": "webhook", "state": "connected",
  "target": "example.com …egap", "fields": {}, "secrets": {"url": "example.com …egap"},
  "events": ["task_done", "task_failed", "clean_window", "not_ready"], "quiet": "off",
  "last": {"at": "2026-10-20T10:42:00.000Z", "ok": true}}}

409 {"error": "The receiver does not know this address. Copy the URL again.",
     "code": "test_failed", "field": "url", "delivery": "http_404"}
```
