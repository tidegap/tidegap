---
title: Homepage first screen shows the install prompt; CSS-only motion with zero layout shift
date: 2026-10-17
category: best-practices
module: apps/web (homepage), scripts/build-brand.mjs
problem_type: best_practice
component: frontend_stimulus
severity: low
applies_when:
  - "Asking visitors to copy text into an agent or terminal"
  - "Adding a looping decorative animation to a landing page"
tags: [homepage, copy-button, css-animation, cls, reduced-motion, seo]
---

# Visible prompt and CSS-only motion

PRs #61 and #74. Plans: `docs/plans/2026-10-17-0641-feat-homepage-first-screen-plan.md`, `docs/plans/2026-10-17-1519-feat-homepage-visible-prompt-plan.md`.

## Show what the button copies

People distrust a "Copy" button that hides its payload: it may be a command. The first screen shows the short agent prompt in a monospace card, the "Copy prompt" button under it, and a trust line (public `install.md`, Apache-2.0, source link). One `PROMPT` constant feeds the card, the button and the install section, so what is shown is what is copied.

## Wave animation

- **Animate `transform` or `background-size` only.** The header wave slides one period with `translateX` inside fixed-size clips (7 s loop); the tagline underline draws with `background-size`. Neither changes layout, so CLS stays 0. A `stroke-dashoffset` fallback was planned and not needed.
- **Mask the edges of every clip window.** A sliding wave shows a hard cut where it enters and leaves the clip. Fade both edges with a `mask-image` gradient.
- **The wave must tile.** `wave()` in `build-brand.mjs` takes `periods`; the header passes 3 and exports `wavePeriod`, which is the distance the CSS translates. A translate of one period gives a seamless loop.
- **Stop under `prefers-reduced-motion`.** Both animations are off there.
- Cost: 754 bytes of CSS.

## Agent and SEO path (same PR)

One site description feeds meta, `og:` and `twitter:` (no test count that goes stale). Sitemap lists `/architecture`, `/install.md`, `/llms.txt`. `robots.txt` has no `Host:` line (not valid). Check with curl: `text/markdown` alternates, every `llms.txt` link returns 200.
