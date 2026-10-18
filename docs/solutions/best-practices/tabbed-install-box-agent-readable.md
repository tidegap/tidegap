---
title: A tabbed install box that agents and crawlers can still read in full
date: 2026-10-18
category: best-practices
module: apps/web (homepage install box), scripts/check-agent-files.mjs
problem_type: best_practice
component: frontend_stimulus
severity: medium
applies_when:
  - "Hiding install commands or other agent-facing text behind tabs, accordions or a select"
  - "Adding a live HTML check for strings that a Next.js App Router page renders"
  - "Adding a host or install path to apps/web/src/lib/hosts.ts"
tags: [homepage, install, tabs, progressive-disclosure, agent-readability, rsc-payload, check-agent-files, cls]
---

# A tabbed install box that agents and crawlers can still read in full

PR #90. Plan: `docs/plans/2026-10-18-homepage-simplify.md`. Builds on `docs/solutions/best-practices/homepage-visible-prompt-and-css-motion.md` (one prompt constant, CLS 0).

## Context

The homepage had the install paths twice: a prompt in the hero and an "install" section with a host select further down. The owner wanted one compact box: the prompt by default, every other install path one click away. The risk is that progressive disclosure hides text from the readers this site is built for: agents that fetch `/` and crawlers. A client component that renders only the active tab ships one command in the HTML and the rest in a JS bundle.

## Guidance

- **Render every tab panel on the server; hide inactive ones with the `hidden` attribute.** `InstallBox` is `"use client"`, but Next renders it on the server with the default state, so all six `role="tabpanel"` sections are in the initial HTML (`apps/web/src/components/install-box.tsx:188`, `hidden={t.id !== active}`). No `next/dynamic`, no `Suspense`, no conditional rendering of panels. The MCP host `<select>` follows the same rule: every host block is rendered, inactive ones `hidden`.
- **Key the tabs on the install document's headings, not on a second list.** `TABS` maps each tab to an `installHeading` (`install-box.tsx:9`), the same field `scripts/check-agent-files.mjs` already proves has a heading in `apps/web/public/install.md`. Panels come from `HOSTS.filter((h) => h.installHeading === …)` (`install-box.tsx:18`). A new host under an existing heading appears in its tab with no UI change; a host under a new heading has no tab, and the vitest case "every host command in the markup" fails.
- **Prove it twice, at two layers.** `apps/web/src/components/install-box.test.tsx` renders `<InstallBox/>` with `renderToStaticMarkup` and asserts the prompt, every `HOSTS[].command`, six panels with one visible, and every `aria-controls` target. `check-agent-files.mjs --base <next start URL>` asserts the same against the live page.
- **Scope live HTML checks to the element, never the whole body.** An App Router page repeats strings in the RSC flight payload inside `<script>` tags. The check slices from `<section id="install"` to `id="how"` before matching (`scripts/check-agent-files.mjs:219-221`).
- **Match the full string, not a prefix.** The first version of the check matched only the first line of each command. Seven hosts use a JSON config whose first line is `{`, so the check passed for them on any brace in the page. The review caught it (adversarial and correctness reviewers, independently). `readHosts` now returns the whole command, with `\n` and `\"` escapes resolved for double-quoted strings and template literals taken as is (`check-agent-files.mjs:109`); `scripts/check-agent-files.test.mjs` pins that parsing.
- **Top-align a first screen whose box changes height.** Tabs differ in height (the prompt panel is short, the MCP panel holds a select, a description and a nine-line JSON block). With `justify-center`, switching tabs moved the H1 up and down. The first screen is now top-aligned with a `clamp()` top padding (`apps/web/src/app/page.tsx:32`), so a taller tab only grows the page downward. Shifts right after a click do not count toward CLS, but a moving heading still looks broken.

## Why This Matters

The homepage, `llms.txt` and `install.md` are the agent install surface. A tab UI that drops commands from the HTML, or a check that passes on `{`, would break agent installs for most MCP hosts with every gate green.

## When to Apply

- Any disclosure widget (tabs, accordion, select, "show more") over text an agent or crawler should read.
- Any `curl`-style or string check against a rendered Next.js page.
- Any edit to `HOSTS` or `install.md` headings.

## Examples

Live check, before and after:

```js
// Before: first line only, whole body. Passes for JSON hosts on "{".
const command = (cmd[1] ?? cmd[2]).split(/\n|\\n/)[0];
if (!unescapeHtml(body).includes(command)) fail(…);

// After: full command, install box only.
const box = body.slice(body.indexOf('<section id="install"'), body.indexOf('id="how"'));
if (!unescapeHtml(box).includes(host.command)) fail(…);
```

QA numbers for PR #90 (Playwright, `PerformanceObserver` over 3 s): CLS 0 at 1280×800 and 390×844, `document.body.scrollWidth` 1280 and 390, H1 position unchanged across all six tabs, ArrowRight/End/Home move focus and selection with wrap.
