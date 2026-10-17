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
