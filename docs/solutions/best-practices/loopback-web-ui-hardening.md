---
title: Hardening a loopback web UI in a CLI (ebb ui) — DNS rebinding, token in the fragment, no CORS, fixed static map
date: 2026-10-15
category: best-practices
module: packages/cli/src/ui (server.ts, events.ts, api.ts, clients.ts, discovery.ts)
problem_type: best_practice
component: tooling
severity: high
applies_when:
  - "A CLI starts a local HTTP server that shows or changes user data"
  - "Adding a live-update stream (SSE) or a provider-backed endpoint to such a server"
  - "Letting a browser extension or a native app call such a server"
tags: [loopback, dns-rebinding, csrf, sse, bearer-token, csp, ebb-ui]
---

# Hardening a loopback web UI in a CLI

Binding to 127.0.0.1 is not enough. Any web page in the user's browser can reach a loopback server.
`ebb ui` (`packages/cli/src/ui/server.ts`) layers these defenses. Keep all of them when you change it.

## Rules

- **Bind 127.0.0.1 only.** No host option exists.
- **Host allow-list against DNS rebinding.** Accept `127.0.0.1`, `localhost`, `[::1]`, with no port or this server's port. Anything else gets 403. A rebinding page sends its own hostname in `Host`.
- **Origin allow-list.** When `Origin` is sent, it must name the same loopback host, or be a browser extension origin (below). Any other origin, `null` included, gets 403.
- **Bearer token, random per run.** The token travels in the URL fragment (`#token=...`), which browsers never send to a server. The page reads it and keeps it in memory only. It checks `Authorization: Bearer` on every `/api/*` request, SSE included. Compare in constant time: hash both sides, then `timingSafeEqual` (equal length by construction).
- **Client tokens, a second scope (native clients).** The browser extension and the Mac app need a token that outlives one run. `tidegap clients add` (or the page's "Connect an app") mints a `tgc_` token and shows it once. The registry `ui-clients.json` (0600, atomic write) keeps only its SHA-256. The server hashes the bearer once and compares it with every stored hash in constant time, without stopping at the first match. It re-reads the registry when the file changes, so a revoke applies on the next request. A malformed registry means "no clients"; the server stays up. A client token never reaches `/api/clients*`: only the page token mints or revokes.
- **Extension origins: `/api/*` only, client token only.** `chrome-extension://`, `moz-extension://` and `safari-web-extension://` plus an id are accepted. With the page token they get 403, so a leaked page link cannot be replayed from an extension; static files get 403 too. The origin is not authentication (any local process can send any `Origin`); it only keeps web pages out. The token stays the authentication. An origin allowlist keyed to the extension id does not work: Firefox and Safari use a random per-install UUID. The full matrix is in `docs/spec/ui-client-api.md`.
- **Discovery file without a secret.** `ui.json` (0600) names the pid and port for the Mac app and holds no token. It is removed on close only when it names this pid.
- **Accepted risk: port squatting on the fixed port 47821.** While `tidegap ui` is down, a process that binds the port first receives the extension's bearer token. Accepted for a single-user Mac on 2026-10-17; revoke the client if you suspect it. Signed requests would remove it and were not built.
- **No CORS headers.** Other origins cannot read responses.
- **CSP plus `nosniff`, `no-referrer`, `no-store`.** `frame-ancestors 'none'`, `base-uri 'none'`, `form-action 'none'`.
- **Fixed static file map** (`/`, `/app.js`, `/app.css`). No request path reaches the disk, so there is no traversal surface. New front-end modules are added to the map one by one; the rule still holds.
- **State changes only by POST.** A GET on a mutating route returns 405. A link or image tag cannot change state.
- **Writes need a JSON content type and a size cap (ui v2).** Routes that read a body (quick add, cancel, reschedule, reply, clients) accept only `Content-Type: application/json` (415 otherwise) and at most 64 KiB (413). A cross-site HTML form cannot send that type without a CORS preflight, and the server answers no preflight. Bodies are strict JSON objects; an unknown field is 400. Body-less routes (read, unread, run-now, dispatcher/start, clients revoke) refuse a non-empty body, which keeps the v1 page's bare mark-read POST working.
- **Bearer header, never a cookie.** Every POST carries `Authorization: Bearer`. A cookie would ride along on cross-site requests; the header cannot.
- **Write, never dispatch.** The server's `Scheduler` has no provider adapters, so an action can only change the ledger. A refused action returns 409 with the core's one-line rule. "Start dispatcher" spawns the same `ebb` binary as a separate detached process.
- **Generic error bodies.** Never return exception text. Refusals are 409 with the core's rule; anything else is 500 with a fixed body (see `../logic-errors/compare-and-set-task-transitions.md`).

## Live updates (SSE)

- The server polls the store (`data_version` poll, `pollMs`) and keeps a per-task fingerprint map (`events.ts`). It emits an event only for tasks whose fingerprint changed or vanished. There are no DB triggers or file watchers.
- The browser re-renders on `tasks` events. It also re-renders on the `hello` event after a **reconnect**, because changes made while the stream was down emit nothing.
- Guard the poll callback so one thrown error does not kill the stream.

## Provider quota

The forecast endpoint calls a provider. The page asks on every change event, and each client polls `/api/summary` every minute. Cache each answer for a short time per request key (`forecastCache` in `api.ts`, WeakMap keyed by context); `/api/forecast` and `/api/summary` share it. Without it, a busy ledger burns the user's quota. A feed failure in the summary is a field (`forecast_ok: false`), not a 5xx.

## Why it matters

Review of PR #45 found missing Host/Origin checks, error text in bodies, an unguarded poll and an uncached forecast. Each looked safe on a "local only" assumption.

## Related

- `client-tokens-and-extension-origins.md`: why client tokens, and the `/api//clients` normalisation bypass.

## Front end

Browser-side rules (text-only rendering, token in memory, optimistic writes, SSE reconnect) are in
`dependency-free-task-ui-patterns.md`.
