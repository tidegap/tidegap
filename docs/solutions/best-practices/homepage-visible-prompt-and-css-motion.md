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
tags: [homepage, copy-button, css-animation, cls, reduced-motion, seo, svg-gradient, logo]
---

# Visible prompt and CSS-only motion

PRs #61 and #74; the logo motion was reworked in PR #88. Plans: `docs/plans/2026-10-17-0641-feat-homepage-first-screen-plan.md`, `docs/plans/2026-10-17-1519-feat-homepage-visible-prompt-plan.md`.

## Show what the button copies

People distrust a "Copy" button that hides its payload: it may be a command. The first screen shows the short agent prompt in a monospace card, the "Copy prompt" button under it, and a trust line (public `install.md`, Apache-2.0, source link). One `PROMPT` constant feeds the card, the button and the install section, so what is shown is what is copied.

## Logo wave animation

- **The mark is a brand asset: never change its shape to make it animate; animate the paint inside it.** PR #74 slid the wave path one period inside fixed clip windows. Only the inner path moved, but the clips cut a different piece of the wave out every frame, so the mark travelled right and changed shape. A first rework in PR #88 kept an outline still but redrew the mark (no edge fades, a new waterline); the owner rejected it because it was no longer the chosen logo.
- **What ships (PR #88, `apps/web/src/components/logo.tsx`).** The brand paths and clips are drawn exactly as `scripts/build-brand.mjs` exports them, with no transform. On top of each coloured stroke sits a copy of the same path, stroked with a repeating `linearGradient` (`gradientUnits="userSpaceOnUse"`, `spreadMethod="repeat"`, one cycle = two wave periods): a soft band of the other brand colour, transparent elsewhere. An `<animateTransform attributeName="gradientTransform">` slides the gradient one cycle every 10 s. Only the gradient moves, so the paint changes and the stroke geometry does not.
- **Do not move a masked rect to fake it.** A gradient rect translated with CSS inside a stroke `<mask>` left a one-pixel vertical hairline at the clip edge in Chromium on some frames. Animating the gradient on a stroke copy has no extra layer and no hairline.
- **Reduced motion shows the plain mark.** `.tg-daynight { display: none }` under `prefers-reduced-motion: reduce` hides the copies (SMIL ignores the media query, so hide the element, do not just stop a CSS animation).
- **Animate `transform`, attributes or `background-size` only.** The tagline underline draws with `background-size`. CLS stays 0.
- **Prove it with measurements, not by eye.** In a Playwright script, read `getBoundingClientRect()` of the header svg twice, about 1 s apart, and screenshot both frames. The rects must match exactly. Every pixel that differs between the frames must be a pixel of the still (reduced-motion) mark; anything outside it means the mark moved or a seam appeared.

## Agent and SEO path (same PR)

One site description feeds meta, `og:` and `twitter:` (no test count that goes stale). Sitemap lists `/architecture`, `/install.md`, `/llms.txt`. `robots.txt` has no `Host:` line (not valid). Check with curl: `text/markdown` alternates, every `llms.txt` link returns 200.
