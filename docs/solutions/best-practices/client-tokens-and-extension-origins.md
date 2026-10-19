---
title: Client tokens, not extension-ID allowlists, for native clients of a local web UI
date: 2026-10-17
category: best-practices
module: packages/cli/src/ui (server.ts, clients.ts), docs/spec/ui-client-api.md
problem_type: best_practice
component: tooling
severity: high
applies_when:
  - "A browser extension or native app must call a loopback HTTP server"
  - "Matching URL paths for an access rule in a hand-written router"
tags: [loopback, client-tokens, extension-origin, path-normalisation, auth-bypass]
---

# Client tokens and extension origins

PR #63 gave the extension (#64) and the Mac app (#65, #66) a way into `tidegap ui`. The full rules are in `loopback-web-ui-hardening.md`; this doc keeps the reasons and the bug review found.

## Decision: a revocable client token, not an origin allowlist

- The page token is random per run and lives in a URL fragment. A client needs a token that survives restarts.
- `tidegap clients add` mints a `tgc_` token, shown once. The registry keeps only its SHA-256 (file mode 0600, atomic write). The server re-reads the file on change, so `revoke` applies on the next request.
- **Why not allow only known extension IDs:** the ID is not stable. Firefox and Safari give each install a random UUID; Chrome's ID changes between an unpacked and a store build. An ID is also not a secret: any local process can send any `Origin`.
- So the origin only keeps **web pages** out (extension origins are accepted on `/api/*` and never on static files or with the page token). The token is the authentication.

## The bypass found in review

Rule: `/api/clients*` accepts the page token only; a client token must never mint or revoke clients. The check compared the raw request path with `startsWith("/api/clients")`. The router drops empty segments, so `/api//clients` reached the same handler and skipped the check. A client token could then mint a new client.

Fix (`server.ts`): compare **normalised segments** (empty segments dropped), the same way the router does. Test double slashes everywhere a path rule exists: `/api//clients`, `/api/clients//`, `/api///clients`, `/api//clients/<id>/revoke` (`ui-server.test.ts`).

General rule: an access check and the router that dispatches must share one path normalisation. If they parse separately, one of them can be fooled.

## Update 2026-10-17 (PR #81)

A client token gets 403 on `POST /api/tasks` and `/reply`; creating work needs the page token. A leaked client token can then read and reschedule but not queue new prompts. The Mac app and extension lost Quick add for this reason. Telegram side: `telegram-channel-security.md`.

## Update 2026-10-19 (PR #96)

A third rule class: `/api/integrations*` accepts the page token or a client token of kind `macos`, and never an extension origin. The check looks at the origin, so a `macos` token used from an extension still gets 403; an `extension` client token gets 403 there too. Same normalised-segment split as the other path rules. Details: `telegram-channel-security.md`, `docs/spec/ui-client-api.md`.

## Update 2026-10-19 (owner decision D1)

`POST /api/tasks/<id>/reply` moved from page-only to the page-and-Mac-app class, next to `/api/integrations*`: the page token or a `macos` client token, never an extension origin. `POST /api/tasks` stays page-only.

Why: a reply continues a task an agent already created; it does not queue new work from nothing. The Mac app is the user's own desktop surface, and QA (K1, S2.15/S3.9) showed the reply form failing with "forbidden" there. The extension keeps the narrower rule because its token sits in a browser profile. Accepted cost: a stolen `macos` token can now queue a follow-up prompt on any finished task and, with run-now (open to client tokens since R22), have the daemon run it soon. The reply keeps the parent's origin (`keepOrigin`), so it runs in the parent's origin session with that session's tools. There is no rate limit on reply for any token. It still cannot create a task from nothing.

Verdict (review of #109): no mitigation now. The token sits in a 0600 file in a 0700 directory and the server binds loopback only, so whoever can read the token already runs code as this user; reply adds no capability across a trust boundary. Revisit if a `macos` token can ever leave the machine or the server binds beyond loopback: then drop `keepOrigin` for client-token actors, or refuse run-now on a reply a client token created.

Two lessons:

- A permission rule that hides an action must also reach the action flags. `actions` was computed without the caller, so every client saw `reply: true` and got a 403 on Send. The server now passes `canReply` into the API context, and `actions.reply` is `false` for a caller that cannot reply.
- The reply check uses the same normalised-segment split as the router; `/api/tasks/<id>//reply` and `/api//tasks/<id>/reply` are tested for the extension token.
