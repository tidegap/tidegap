---
title: Homepage first screen shows the install prompt; CSS-only motion with zero layout shift
date: 2026-10-17
category: best-practices
module: apps/web (homepage), scripts/build-brand.mjs
problem_type: best_practice
component: frontend_stimulus
severity: low
last_updated: 2026-10-18
applies_when:
  - "Asking visitors to copy text into an agent or terminal"
  - "Adding a looping decorative animation to a landing page"
tags: [homepage, copy-button, css-animation, cls, reduced-motion, seo, svg-mask, logo]
---

# Visible prompt and CSS-only motion

PRs #61 and #74; the logo motion was reworked in PR #88. Plans: `docs/plans/2026-10-17-0641-feat-homepage-first-screen-plan.md`, `docs/plans/2026-10-17-1519-feat-homepage-visible-prompt-plan.md`.

## Show what the button copies

People distrust a "Copy" button that hides its payload: it may be a command. The first screen shows the short agent prompt in a monospace card, the "Copy prompt" button under it, and a trust line (public `install.md`, Apache-2.0, source link). One `PROMPT` constant feeds the card, the button and the install section, so what is shown is what is copied.

## Logo wave animation

- **Animate `transform` or `background-size` only.** Neither changes layout, so CLS stays 0. The tagline underline draws with `background-size`.
- **Do not slide the mark itself through a window.** The first version (PR #74) slid the brand wave path one period inside fixed clip rectangles. Only the inner path moved, but the clips cut the mark out of the moving wave, so the visible mark travelled right and changed shape every frame. The owner read it as "the whole logo moves". An edge-fade mask on the windows hid the cut ends but not the travel.
- **Keep the silhouette static; move something inside it.** Since PR #88 (`apps/web/src/components/logo.tsx`) the white wave is drawn still, clipped to the brand ink and teal windows. The only animated element is a waterline path inside a `<mask>` over the trough: a ripple wave drawn over the trough width plus one ripple, translated one ripple per loop (`tg-wave` in `globals.css`, `will-change: transform`). The teal shows below the waterline, so the teal level ripples inside a still outline. Put the animation class on that inner path, never on the `<svg>` or a group that holds the outline.
- **Stop under `prefers-reduced-motion`.** The waterline and the underline are off there.
- **Prove it with two measurements, not by eye.** In a Playwright script, read `getBoundingClientRect()` of the header svg twice, about 1 s apart, and screenshot both frames. The rects must match exactly, and a pixel diff of the two frames must stay inside the trough. Before PR #88 the diff covered the whole mark.

## Agent and SEO path (same PR)

One site description feeds meta, `og:` and `twitter:` (no test count that goes stale). Sitemap lists `/architecture`, `/install.md`, `/llms.txt`. `robots.txt` has no `Host:` line (not valid). Check with curl: `text/markdown` alternates, every `llms.txt` link returns 200.
