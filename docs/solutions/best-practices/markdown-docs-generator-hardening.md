---
title: Hardening a hand-written markdown-to-HTML docs generator (escape, origins, backslashes, regen check)
date: 2026-10-17
category: best-practices
module: scripts/build-docs.mjs, scripts/build-docs.test.mjs, scripts/check-agent-files.mjs, apps/web/src/components/docs/docs-nav.tsx
problem_type: best_practice
component: tooling
severity: medium
applies_when:
  - "Generating site HTML or llms-full.txt from repo markdown"
  - "Changing the renderer, a link rule or a generated table"
tags: [markdown, codeql, xss, escaping, generated-files, ci, scroll-spy, agent-files]
---

# Markdown docs generator hardening

PR #78 (`pnpm gen:docs`). The site renders `/docs` and `/llms-full.txt` from repo markdown with its own small renderer (no dependency). CodeQL and review found these rules.

- **Escape, do not strip.** Stripping `<script>` or `on*=` is a blocklist and misses cases. Every literal `<`, `&`, `"` in source text becomes an entity in one function (`escapeHtml`); only the renderer emits tags. When a later step needs plain text, it drops the renderer's own tags and then decodes the four entities in one pass, and the caller escapes again before HTML or JSON.
- **Decode in one pass.** Chained `.replace` calls decode `&amp;lt;` twice. One regex with a lookup table does not.
- **Links: allow-list the scheme and compare the origin.** `SAFE_HREF` allows `http(s)`, `mailto` and scheme-less paths. A control character or `javascript:`/`data:` fails the build, not the page. "External" is `new URL(url).origin !== SITE`. A `startsWith("https://www.tidegap.com")` check passes `https://www.tidegap.com.evil.example`.
- **Emphasis never touches an href.** Finished links are parked behind placeholders before `*`/`_` rules run.
- **Backslashes first.** In table cells escape `\` before `|` (`mdCell`), so `\\` and `\|` round-trip. The reverse order turns a trailing backslash into an escaped pipe and breaks the row. Unescape on the way in: `\\([|*_\`\\[\]])`.
- **No regex with nested quantifiers on input** (CodeQL `js/polynomial-redos`, also the Telegram base URL). Trim with a loop.
- **Fail on duplicate heading ids** (`duplicate id "x": a and b`) instead of renaming silently: anchors are links other people saved.
- **Byte-identical regeneration is a CI gate.** `pnpm gen:docs:check` regenerates and runs `git diff --exit-code` on `docs.generated.ts` and `public/llms-full.txt`. Generated tables (MCP tools, energy rows) come from built `dist` of core, so build core first in CI. After merging a branch that changes `install.md` or a source doc, regenerate in the merge commit (U14 did).
- **Agent files are checked on a running site.** `scripts/check-agent-files.mjs --base <url> --only install,llms,head,crawl,docs` proves an agent can find and follow `/install.md`, `/llms.txt`, `Link` header, JSON-LD `installUrl`, sitemap and `/llms-full.txt`. It needs `next start`, not source greps. Host count has one source (`lib/hosts.ts` `HOST_COUNT`); the check compares claims row 18 to it.

## Docs nav scroll-spy without IntersectionObserver

The plan specified an IntersectionObserver. The shipped nav measures instead: on `scroll`/`resize` (one rAF) the current section is the last whose `getBoundingClientRect().top` is at or above its own `scroll-margin-top` + 8 px; at the page bottom it is the last section. Reason: an observer with margins disagrees with the anchor jump line at other breakpoints, and a short last section never reaches the observer band. Measuring against the section's own `scroll-margin-top` makes a deep link always highlight where it landed. A nav click sets the item at once and locks updates for 900 ms so a smooth scroll does not flicker the highlight. Links are plain anchors, so it works without JavaScript.

## Update 2026-10-19: numbers in prose are generated too (D7)

A count typed into the README, the about page and `claims.md` went stale four times (605, 1,115, 1,355, 1,423, 1,578). `scripts/build-test-count.mjs` now counts per package (`vitest list --json`, `node --test --test-reporter=tap`, `pytest --collect-only`) and writes `tests.generated.ts` plus README marker blocks (`<!-- tests:start -->`). Rules that made it work:

- The page reads the generated module; no literal stays in source. `docs-drift.mjs` K6 fails on any hand-typed count that differs from it.
- `--check` compares counts, not bytes, and `generatedAt` changes only when a count changes, so the gate is stable day to day.
- A package that cannot be counted (no pytest locally) keeps its committed value. CI counts it in the python job with `--only python`, which needs no built TypeScript.
- Count in a fresh `HOME`, so a developer's `~/.tidegap` never changes the number.
- Do not call the number "passing": it counts collected tests. CI runs them.
- Count on one Node version (22) in CI: core-ts collects 762 tests on Node 20 and 763 on 22, so a matrix-wide check fails.
