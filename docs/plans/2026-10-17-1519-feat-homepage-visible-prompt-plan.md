---
title: Homepage Visible Prompt - Plan
type: feat
date: 2026-10-17
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Homepage Visible Prompt - Plan

## Goal Capsule

- **Objective:** The first screen of www.tidegap.com shows the install prompt itself, so a visitor sees what they copy before they copy it. The page below reads as a short marketing page (scan in about 20 s, details one click away), the header logo's wave moves gently, and an agent that lands on the site finds a current install page.
- **Means:** One short prompt constant shown in a monospace card with a "Copy prompt" button under it; the "what it is" block removed from the homepage (its facts already live on `/about`); "How it works" moved up; an animated header wave; one tagline underline animation; small agent-path fixes to `install.md`, `llms.txt`, the sitemap, the head and the footer.
- **Authority:** Vitalii's feedback (Problem Frame), then this plan, then the current `apps/web` code. Naming: Tidegap only, never "Ebb" in new or changed visible copy. Where the plan and the repo disagree, stop and report.
- **Stop conditions:** the first screen cannot hold tagline, card, button and helper above the fold at 390×844; the prompt card needs more than 3 lines at 390 wide; `pnpm --filter @tidegap/web build` fails the same way twice; any step would merge, push to `main`, publish or cut a release.
- **Execution profile:** one worktree `.worktrees/feat/homepage-visible-prompt`, branch `feat/homepage-visible-prompt`, one PR (PR A). Units run in order U1 → U5, no fan-out (U2 imports U1's exports; U3 and U4 touch shared files). Git commands use `git -c core.editor=true -c sequence.editor=true`.
- **Who finishes:** the pipeline stops at an open PR with green gates, the browser QA report and one `ce-code-review` pass. Vitalii merges. A merge to `main` is a Vercel production deploy.

---

## Product Contract

### Summary

Replace the blind "Copy the prompt for your agent" button (PR #61) with a visible short prompt in a monospace card and a "Copy prompt" button under it. Trim the homepage to: first screen → How it works → Install → Live data and tools. Animate the header wave and draw in the tagline accent underline once. Bring the agent-readable pages up to date for 0.19.

### Problem Frame

Vitalii, 2026-10-17, on the first screen from PR #61: "Copy the prompt for your agent" is a blind button; people may think the prompt is unsafe. The first screen must show the prompt — short, good-looking — with the copy button under it.

Scope update the same day: the grey "what it is" block is not marketing and moves to `/about` (the homepage keeps at most one sentence of it); "How it works" moves up right after the first screen; the page must scan in 20 s; the header logo wave gets a subtle animation; the page gets one tasteful animation; an agent landing on the site must be able to install Tidegap by itself.

### Requirements

**First screen**

- R1. Order, centred: H1 tagline (unchanged text and accent span) → prompt card → "Copy prompt" button → status line → helper line with the trust cue → "Other ways to install ↓" link to `#install`.
- R2. The prompt card shows the exact `PROMPT` text (KTD1) in monospace, wraps (no horizontal scroll), is at most 3 lines at 390 wide and at most 2 lines at 1440 wide, and its text is selectable.
- R3. The button's visible label is "Copy prompt". Its accessible name starts with the visible label and says what it copies: "Copy prompt: install Tidegap from tidegap.com/install.md".
- R4. On a successful copy the status line reads "Copied. Paste it into your agent." for about 1.5 s and is announced (`role="status"`). On failure it reads "Copy blocked. Select the prompt above and copy it."
- R5. Helper line with the trust cue, no marketing words: "Paste it into Claude Code, Codex, Cursor or any MCP host. Your agent reads the public [install.md](/install.md) and installs the open-source (Apache-2.0) Tidegap package ([source on GitHub](https://github.com/tidegap/tidegap))."
- R6. The first screen still fills the viewport below the nav: at 1440×900 and 390×844 the button and helper line are inside the viewport and the top of the next section is at or below the fold.

**Below the first screen**

- R7. Homepage section order: first screen → How it works (`id="how"`) → Install (`id="install"`) → [apps-and-extensions slot comment] → Live data and tools (the live grid banner, then the four dashboard tiles). The `ValueRow` stats strip is cut from the homepage.
- R8. The "what it is" block (version badge, DOE/Batch paragraph, claims note, authorship line) leaves the homepage. `/about` already holds every one of those facts ("Why this exists", "Status", "Maintainer"); `/about` gains only the version badge pill above its H1. The homepage keeps one sentence, as the lead of the How it works section: "Tidegap is an open-source MCP scheduler: it holds an AI task that can wait and runs it at the cleanest grid hour before your deadline. [More about the project](/about)." This sentence makes no 50 % or carbon-amount claim, so it needs no claims note.
- R9. The install section keeps `id="install"`, the `AgentPrompt` card (same `PROMPT`) first, the host picker second with "MCP server (generic)" preselected.

**Motion**

- R10. Header logo: the wave moves slowly left to right in a seamless loop (about 6–8 s per period). Ink and teal clip windows stay fixed; only the wave path behind them moves. No layout shift; the SVG box size is unchanged. Under `prefers-reduced-motion: reduce` the wave is still.
- R11. One page animation: the accent "cleanest grid hour" in the H1 gets an underline that draws in once on load (left to right, about 0.9 s, after a 0.3 s delay). It does not loop. Under `prefers-reduced-motion: reduce` the underline is shown at full width with no animation. The underline does not change line height (no CLS).
- R12. All new CSS for R10 and R11 is under 2 KB unminified.

**Agent path (quick items only)**

- R13. `apps/web/public/install.md` is current for 0.19: it adds an "OpenAI Codex CLI" section (`~/.codex/config.toml`, `[mcp_servers.tidegap]` with `command = "npx"`, `args = ["-y", "@tidegap/mcp"]`), a "Libraries" section (`npm install @tidegap/core`, `pip install tidegap`, Python 3.11+), and an "Optional: connect the Mac app or the browser extension" section (`npx -y @tidegap/cli ui`, then `tidegap clients add --name browser --kind extension`; the Mac app pairs itself on first launch, per `apps/macos/README.md`). There is no pipx path: `packages/core-py` has no `[project.scripts]` entry, so the Python package is a library only; install.md says so in one line.
- R14. `apps/web/public/llms.txt` links `https://www.tidegap.com/install.md` first under a new "## For agents" heading, its "MCP tools (9)" heading says 10 (the list has 10), and every link in it resolves on the built site.
- R15. The root layout head carries `<link rel="alternate" type="text/markdown" href="/install.md">` (through `metadata.alternates.types`), and the footer has one line: "For agents: read [/install.md](/install.md)."
- R16. `sitemap.ts` lists `/install.md` and `/llms.txt`.
- R17. Existing pieces stay as they are and are only checked: SoftwareApplication JSON-LD in `layout.tsx`, `robots.ts` (allows `/` for all, disallows only `/api/`).

**Naming**

- R18. New or changed visible copy says "Tidegap". No "Ebb" anywhere in visible homepage text.

### Scope Boundaries

- Not changing page metadata text, Open Graph images or nav links.
- Not adding a light theme (the site is dark-only).
- Not renaming the internal `ebb-*` CSS class names in `how-it-works-viz.tsx`; they are not visible copy.
- Considered and not built: a test harness for `apps/web` (no test runner today; the QA script covers this layout and clipboard change).
- Considered and not built: a `/llms-full.txt`. It needs a generator to stay in sync with the docs; that belongs to the redesign plan's docs work.

### Out of scope → redesign plan

These belong to the separate redesign plan another agent is writing; this PR does not touch them:

- Presentation-grade redesign of the homepage for non-technical and eco audiences (new copy voice, new section set, visual system).
- `/docs` with a sticky left category nav.
- Hero illustrations, and a large animated wave as a hero accent behind the tagline.
- `/llms-full.txt` and any generated agent docs.
- Rework or replacement of the How it works animation, the dashboard tiles and the live grid banner beyond moving them.

### Deferred to Follow-Up Work

- `apps/web/public/architecture.html` links to `./index.html#install` (pre-existing, from the PR #61 plan).

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Short prompt, one source.** The `PROMPT` constant in `apps/web/src/components/agent-prompt.tsx` becomes:

  ```text
  Read https://www.tidegap.com/install.md, then install Tidegap for the host you're in and confirm it worked.
  ```

  107 characters, one line in source, no newlines. It keeps the three instructions of the old 221-character prompt: read the page, install for this host (install.md heading "Pick the install path for the host you're in") and confirm (heading "Confirm the install worked"). The words the old prompt spent on "open-source, Apache-2.0" move to the visible helper line (R5) and stay in install.md's own header. Both the first-screen card and the install-section `AgentPrompt` render this one constant, so the shown text and the copied text cannot drift. At 390 wide the content box is 342 px (main `px-6`); minus the 1 px borders and 16 px card padding the text box is 308 px. At 12 px monospace (about 7.2 px per glyph) a line holds about 42 glyphs, so the prompt wraps to 3 lines: "Read https://www.tidegap.com/install.md," (40) / "then install Tidegap for the host you're" (40) / "in and confirm it worked.". 13 px (about 39 glyphs) would push the URL line to 4 lines, so mobile uses 12 px. At `sm` and up, 15 px in a `max-w-2xl` card gives 2 lines.
- KTD2. **`HeroPrompt` replaces `CopyPromptButton`, in the same file.** `agent-prompt.tsx` exports `HeroPrompt` (card + button + status line) and `AgentPrompt` (install-section card, unchanged look). Both use the existing `useCopyPrompt` hook. `CopyPromptButton` is deleted, not kept beside it. The card is a `<pre id="hero-prompt">` with `whitespace-pre-wrap break-words`; the button carries `aria-label` per R3 and `aria-describedby="hero-prompt"`.
- KTD3. **Wave animation by translating the path inside fixed clips.** In `apps/web/src/components/logo.tsx`, each clipped wave is a `<g clipPath=…>` (clip stays fixed in user space) holding a `<path>` with a CSS class that animates `transform: translateX(-P)` → `0` linearly, infinite, where P is the wave period in viewBox units. The generated header path covers exactly 2 periods (x −31.85 to 416.6, P = 224.23) and the ink clip spans x −0.87 to 385.63, so at `translateX(-P)` the right part of the clip would be empty. Fix in `scripts/build-brand.mjs`: give `wave()` an optional `periods` parameter (default unchanged), pass `periods: 3` from `headerForm()` only, and export `wavePeriod` in `BRAND_HEADER`. The mark, icon and lockup call sites keep the default, so `assets/brand/` stays byte-identical. Do not render the path twice: overlapping copies double-paint antialiased edges. `pnpm gen:brand` regenerates `brand.generated.ts`; the static brand files under `assets/brand/` must not change (check with `git diff --stat assets/brand`). The two clip ids stay unique to the header. The keyframes and reduced-motion rule live in `globals.css`. Fallback if the translate join shows a seam: animate `stroke-dashoffset` on the teal path only; record which one shipped in the PR.
- KTD4. **Underline as an animated background.** The accent span gets a class with a `linear-gradient` background image, `background-position: 0 100%`, `background-repeat: no-repeat` and `box-decoration-break: clone`, and animates `background-size` from `0% 2px` to `100% 2px` once. A pseudo-element bar on an `inline-block` span was rejected: `inline-block` stops the phrase from wrapping on mobile. A background underline wraps across lines and changes no box size, so it causes no layout shift.
- KTD5. **Fold sizing stays as in PR #61** (`min-h-[calc(100svh-101px)]`, `sm:` 105 px). Rough budget at 390×844 (743 px available): H1 about 132, card about 95, button 48, status 20, helper about 60, link 16, gaps about 130 → about 500. If measured height exceeds the viewport, reduce the H1 one size step on mobile before touching anything else.
- KTD6. **`metadata.alternates.types` for the markdown alternate.** Next.js merges metadata shallowly per top-level key, and every page (`page.tsx`, about, docs, map, plan, forecast, queue, stats) sets its own `alternates: { canonical }`, which replaces the layout's. So add one exported constant `MARKDOWN_ALTERNATE = { "text/markdown": "/install.md" }` in `apps/web/src/lib/agent-links.ts` and spread it as `types` into the homepage's and `/docs`'s `alternates` (the two pages an installing agent lands on), and into the layout's for pages without their own. Next.js renders it as `<link rel="alternate" type="text/markdown">`. Static files under `public/` with an extension bypass the CSP proxy (`proxy.ts` matcher), so `/install.md` and `/llms.txt` are served as-is.

### Assumptions

- Codex CLI reads MCP servers from `~/.codex/config.toml` under `[mcp_servers.<name>]` with `command` and `args`. The implementer checks the current Codex docs once before writing R13's snippet; if the key differs, use the documented one.

---

## Implementation Units

### U1. Visible prompt component

- **Goal:** The short prompt, a visible card, and a "Copy prompt" button under it.
- **Requirements:** R2, R3, R4; KTD1, KTD2.
- **Dependencies:** none.
- **Files:** `apps/web/src/components/agent-prompt.tsx`.
- **Approach:**
  1. Replace `PROMPT` with the KTD1 text (single line).
  2. Replace `CopyPromptButton` with `HeroPrompt`: a `max-w-2xl w-full` card (`rounded-lg border border-rule bg-bg-elev`, `p-4`, left-aligned text, `font-mono text-[12px] sm:text-[15px] leading-relaxed`, `whitespace-pre-wrap break-words`, `select-text`), then the accent button "Copy prompt" (same accent style as today, `aria-label` and `aria-describedby` per KTD2), then the always-mounted `role="status"` line with reserved height and R4 texts.
  3. `AgentPrompt` keeps its markup and behaviour; it shows the new text automatically.
- **Patterns to follow:** the existing button and status-line markup in `CopyPromptButton`; card tokens from `AgentPrompt`.
- **Test scenarios:** browser QA (no test runner in `apps/web`): copied text equals the card's `textContent`; Tab + Enter copies; rejected clipboard shows the blocked line; the install-section "copy" copies the same text.
- **Verification:** lint, typecheck, build pass.

### U2. Homepage restructure and /about badge

- **Goal:** First screen with the visible prompt, and the R7 section order.
- **Requirements:** R1, R5, R6, R7, R8, R9, R18; KTD5.
- **Dependencies:** U1.
- **Files:** `apps/web/src/app/page.tsx`, `apps/web/src/components/how-it-works-viz.tsx` (lead sentence and `id="how"` only), `apps/web/src/app/about/page.tsx`.
- **Approach:**
  1. `FirstScreen`: H1 → `HeroPrompt` → helper line R5 as `<p id="hero-helper">` (links: `/install.md`, GitHub, `target="_blank" rel="noreferrer"` on GitHub only) → "Other ways to install" link. Remove the old helper copy.
  2. Delete `WhatItIs` and `ValueRow` from `page.tsx`, and the `VERSION` import if unused.
  3. `HowItWorksViz`: add `id="how"` and the R8 sentence as the first paragraph under the H2 (keep the existing description after it, or replace it if the section then reads too long at 390 wide; pick one and say which in the PR).
  4. New order in `HomePage`: `FirstScreen`, `HowItWorksViz`, `InstallBlock`, apps-slot comment, a "Live data and tools" section holding `GridGreeting` (inside its `Suspense`) and `TilesBlock`'s grid. Keep `TilesBlock`'s eyebrow ("dashboard") and H2 ("Live data + tools.") above both.
  5. `/about`: add the version pill (same markup as the removed homepage badge) above the H1.
- **Patterns to follow:** existing section shells and eyebrow labels in `page.tsx`.
- **Test scenarios:** browser QA: fold check at both viewports; order check; no "Ebb"; `/about` shows the badge.
- **Verification:** lint, typecheck, build pass.

### U3. Motion: wave logo and tagline underline

- **Goal:** R10, R11, R12.
- **Requirements:** R10, R11, R12; KTD3, KTD4.
- **Dependencies:** U2 (the H1 span lives in `page.tsx`).
- **Files:** `apps/web/src/components/logo.tsx`, `apps/web/src/app/globals.css`, `apps/web/src/app/page.tsx` (class on the accent span), `scripts/build-brand.mjs` and the regenerated `apps/web/src/lib/brand.generated.ts` (KTD3).
- **Approach:**
  1. Wave: per KTD3. Keyframes `tg-wave` with `will-change: transform`, about 7 s linear infinite.
  2. Underline: per KTD4, keyframes `tg-underline` on `background-size`, `forwards`, once.
  3. One `@media (prefers-reduced-motion: reduce)` block sets `animation: none` on both and shows the underline at full size.
  4. Measure the added CSS size with `wc -c` on the added lines; it must be under 2048 bytes.
- **Test scenarios:** browser QA: the wave path's computed `transform` changes between two reads 1 s apart; with reduced motion emulated it does not, and the underline is full width; CLS check per QA step 8.
- **Verification:** lint, typecheck, build pass; `git diff --stat assets/brand` empty.

### U4. Agent path

- **Goal:** R13–R17.
- **Requirements:** R13, R14, R15, R16, R17; KTD6.
- **Dependencies:** none; runs after U3 to keep one writer at a time.
- **Files:** `apps/web/public/install.md`, `apps/web/public/llms.txt`, `apps/web/src/app/layout.tsx`, `apps/web/src/app/page.tsx` (alternates only), `apps/web/src/app/docs/page.tsx` (alternates only), new `apps/web/src/lib/agent-links.ts`, `apps/web/src/app/sitemap.ts`.
- **Approach:**
  1. install.md: add the Codex section after OpenClaw; add "Libraries" and "Optional: connect the Mac app or the browser extension" sections before "Confirm the install worked"; add the one-line no-pipx note under Libraries. Keep the safety header as is.
  2. llms.txt: add "## For agents" with the install.md link at the top of the docs links; fix "MCP tools (9)" to 10; add `/install.md` to the Docs list.
  3. `alternates.types` per KTD6 in layout, homepage and docs; footer line "For agents: read /install.md" as a third footer paragraph, `font-mono text-fg-dim`.
  4. sitemap.ts: add `/install.md` (monthly, 0.7) and `/llms.txt` (monthly, 0.5).
  5. Do not change robots.ts or the JSON-LD; only check them in QA.
- **Test scenarios:** agent-path checks in the Verification Contract.
- **Verification:** build passes; agent-path checks pass.

### U5. CHANGELOG

- **Goal:** One `[Unreleased]` → `### Changed` entry.
- **Files:** `CHANGELOG.md`.
- **Approach:** Bold lead sentence: "**Homepage shows the install prompt.**" then one sentence each: the first screen shows the short prompt with a "Copy prompt" button; How it works moved up and the "what it is" block moved to `/about`; the header wave and the tagline underline animate (still under reduced motion); install.md covers Codex, the libraries and connecting the Mac app and the extension. No version bump, no date on the heading.

### U-seo. SEO fixes (added 2026-10-17 by the orchestrator)

- **Goal:** Consistent, verifiable metadata and a complete crawl surface.
- **Dependencies:** U4 (same files).
- **Files:** new `apps/web/src/lib/site-meta.ts` (one `SITE_DESCRIPTION`, and `MARKDOWN_ALTERNATE` from KTD6 in place of `agent-links.ts`), `apps/web/src/app/layout.tsx`, `apps/web/src/app/page.tsx`, `apps/web/public/architecture.html`, `apps/web/src/app/sitemap.ts`, `apps/web/src/app/robots.ts`, `apps/web/public/llms.txt`.
- **Approach:**
  1. (a) One description for meta description, `og:description` and `twitter:description`; no unverifiable number (drop "1,423 tests").
  2. (b) `/architecture`: add a meta description and a canonical; add `/architecture` and `/install.md` to the sitemap.
  3. (c) robots: remove the invalid `Host:` line (`host` key in `robots.ts`). This overrides R17 for robots.
  4. (d) llms.txt: tool count 10; drop "faster first-token times" and "doubled off-peak limits"; name 0.19.0, the Mac app, the extensions and Codex.
  5. (e) JSON-LD: `alternateName: "ebb-ai"`, `sameAs` (GitHub, npm), `downloadUrl` (npm).
- **Not built (follow-ups, need new pages):** `/apps`, `/privacy`, `/llms-full.txt`.
- **Verification:** build passes; agent-path checks 5 and 6 (sitemap, robots) pass.

---

## Verification Contract

Run from the worktree root. `apps/web` needs `@tidegap/core` built first (`docs/solutions/developer-experience/worktree-environment-setup.md`). `apps/web` has no test suite and is not in `ci.yml`.

| Step | Command | Pass |
|---|---|---|
| Install | `pnpm install --frozen-lockfile` | exit 0 |
| Build core | `pnpm --filter @tidegap/core build` | exit 0 |
| Lint | `pnpm --filter @tidegap/web lint` | exit 0, no new warnings in changed files |
| Typecheck | `pnpm --filter @tidegap/web typecheck` | exit 0 |
| Build | `pnpm --filter @tidegap/web build` | exit 0 |
| Naming | `git diff origin/main -- apps/web CHANGELOG.md \| grep -in '^+.*ebb' \| grep -v 'ebb-'` | no output |
| Brand files | `git diff --stat origin/main -- assets/brand` | no output |
| Motion CSS size | added lines for `tg-wave` / `tg-underline` and their reduced-motion rule, `wc -c` | < 2048 |

### Agent-path checks (local `next start`)

Start: `pnpm --filter @tidegap/web start -p 3100` (after build). Then:

1. `curl -s http://localhost:3100/install.md | grep -cE '^## |^### '` — counts the headings; expect the Codex, Libraries and "connect the Mac app" headings present (`grep -n` each).
2. `curl -sI http://localhost:3100/install.md | grep -i content-type` — a text type, status 200.
3. Every `https://www.tidegap.com/...` link in `llms.txt`, rewritten to `http://localhost:3100/...`, returns 200 (`grep -oE 'https://www\.tidegap\.com[^) ]*' apps/web/public/llms.txt | sort -u`, then `curl -s -o /dev/null -w '%{http_code}'` each; anchors stripped).
4. `curl -s http://localhost:3100/ | grep -oE '<link[^>]*text/markdown[^>]*>'` — one match with `/install.md`; same for `/docs`.
5. `curl -s http://localhost:3100/sitemap.xml | grep -c 'install.md\|llms.txt'` — 2.
6. `curl -s http://localhost:3100/robots.txt` — `Allow: /` for `*`, only `/api/` disallowed.
7. `curl -s http://localhost:3100/ | grep -c '"@type":"SoftwareApplication"'` — 1.

### QA Script (browser agent, local `next start`)

Target `http://localhost:3100` (the Vercel preview is behind login). One tab; close it at the end. Screenshots to the session scratchpad.

1. **1440×900**, open `/`. Expect: nav with the logo, centred H1, the prompt card with the KTD1 text on at most 2 lines, the "Copy prompt" button under it, the helper line with `install.md` and GitHub links, "Other ways to install". Screenshot.
2. Evaluate: `document.querySelector('#how').getBoundingClientRect().top >= innerHeight - 1`; the button's and the helper line's (`#hero-helper`) `getBoundingClientRect().bottom <= innerHeight`; `document.documentElement.scrollWidth <= innerWidth`. Expect all true.
3. Read the button's accessible name (`getAttribute('aria-label')`). Expect it starts with "Copy prompt" and names install.md.
4. Grant clipboard permissions, click "Copy prompt", read `navigator.clipboard.readText()`. Expect it equals `document.querySelector('#hero-prompt').textContent.trim()` and equals the KTD1 text exactly. The status line shows "Copied. Paste it into your agent." and clears within about 2 s.
5. Select the card text with a triple click; `getSelection().toString()` contains the URL. (Selectable.)
6. Reload; stub `navigator.clipboard.writeText = () => Promise.reject(new Error("blocked"))`; click. Expect "Copy blocked. Select the prompt above and copy it." Reload.
7. Scroll top to footer. Expect order: first screen, How it works (with the one-sentence lead and the "More about the project" link), Install (prompt card with the same text, host picker with "MCP server (generic)"), "Live data + tools." (grid banner, four tiles). No version badge, no DOE paragraph, no value-row strip. Footer shows "For agents: read /install.md". Screenshot.
8. Motion and CLS: run a `PerformanceObserver` for `layout-shift` (buffered) after load plus 3 s; expect the CLS sum < 0.01. Read the header wave path's computed `transform` twice, 1 s apart; expect different values. The H1 underline is at full width after 2 s.
9. Emulate `prefers-reduced-motion: reduce`, reload. Expect the wave transform identical across two reads 1 s apart, and the underline at full width immediately. Screenshot.
10. Click "Other ways to install". Expect the install heading visible below the sticky nav. Click the install card's "copy"; the clipboard equals the KTD1 text.
11. Page text search for "Ebb", case-insensitive. Expect no match.
12. **390×844**: repeat steps 1, 2, 4 and 7. Expect the card at most 3 lines: `(pre.clientHeight - 32) / parseFloat(getComputedStyle(pre).lineHeight) <= 3` (at 1440 the same formula gives ≤ 2; check it in step 1 too), no horizontal scroll, the fold check true. Screenshot.
13. Open `/about`. Expect the version pill above the H1.
14. Console on `/` and `/about`: no errors (CSP violations included).

Report: pass or fail per step, screenshot paths, the first wrong value on a fail.

---

## Definition of Done

- U1–U5 are in one PR from `feat/homepage-visible-prompt`; changed files are limited to those the units name and this plan.
- Every Verification Contract command, agent-path check and QA step passes.
- No dead code from removed sections (`WhatItIs`, `ValueRow`, `CopyPromptButton`) remains.
- One `ce-code-review` pass is done and its blockers are fixed. Nobody merges except Vitalii.
