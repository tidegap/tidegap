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

PRs #61 and #74; the logo motion was reworked in PR #88 and restored to the pre-#74 mark in PR #92. Plans: `docs/plans/2026-10-17-0641-feat-homepage-first-screen-plan.md`, `docs/plans/2026-10-17-1519-feat-homepage-visible-prompt-plan.md`.

## Show what the button copies

People distrust a "Copy" button that hides its payload: it may be a command. The first screen shows the short agent prompt in a monospace card, the "Copy prompt" button under it, and a trust line (public `install.md`, Apache-2.0, source link). One `PROMPT` constant feeds the card, the button and the install section, so what is shown is what is copied.

## Logo wave animation

- **The reference is the pre-#74 render.** The chosen logo is the header mark as it rendered at `dd5d2e9` (the first parent of PR #74's merge): the heavy wave stroke clipped white to the ink box (both crests, outer arms cut flat) and teal to the trough box, a flat split line, no gradient, no fade. Render that commit's `logo.tsx` with `react-dom/server` at the header size and compare against it at 3x, not against memory or an older screenshot.
- **Never change the silhouette; animate paint only.** PR #74 slid the path inside fixed clips (the mark travelled and changed shape). PR #88 tried a redrawn waterline, then soft colour bands over both colours; the owner rejected each because it was no longer the chosen logo. A paused frame must show the same outline and the same two colours in the same places.
- **What ships (PR #92, `apps/web/src/components/logo.tsx`).** One wave path in one static clip (the ink and teal boxes as two rects of one `clipPath`). Its stroke paint is a `<pattern>` in the svg's user space (`viewBox` on the pattern equal to the svg's, or the content lands offset by the tile origin): a white rect, and a teal rect over the trough box whose top starts at the brand split line. A SMIL `<animate attributeName="y">` on the teal rect slides that top 18 units down the trough's flanks and back every 12 s, ease-in-out. `scripts/build-brand.mjs` and `brand.generated.ts` are back to their pre-#74 output (two periods, no `wavePeriod`).
- **One path, one paint: no seams.** Keeping the brand's two clipped paths and moving white into the teal path drew a grey line at the brand split (two antialiased clip edges meeting; white over white shows the gap that white over teal hides). Animated clip geometry (SMIL on a clip rect or path) changed edge antialiasing on every frame. A static clip with a moving paint has neither.
- **Pattern, not a vertical gradient.** A hard-stop `linearGradient` split is sampled at pixel centres, so the antialiased bottom row of the outer arms (cut at the same line) turned teal at some sizes: up to 52/255 at 2x, 22 px. The pattern keeps the teal between the crest centres, so the outer arms stay white at every scale.
- **Reduced motion shows the still split.** SMIL ignores the media query, so CSS swaps the paint: `.tg-wave { stroke: url(#tg-header-split) }`, a second pattern with no animation.
- **Animate `transform`, attributes or `background-size` only.** The tagline underline draws with `background-size`. CLS stays 0.
- **Prove it with measurements, not by eye.** Pause SMIL (`svg.pauseAnimations(); svg.setCurrentTime(t)`) and screenshot the logo at 3x for several `t`. The bounding rect must match across frames. Render a silhouette copy (all paint forced white with CSS): it must be pixel-identical across frames, and differ from the reference only by antialiasing. Measured on PR #92: rest frame 0.40% of pixels differ from the reference (all on the split row, where the reference's two clips left a faint seam); the silhouette is identical in every frame.

## Agent and SEO path (same PR)

One site description feeds meta, `og:` and `twitter:` (no test count that goes stale). Sitemap lists `/architecture`, `/install.md`, `/llms.txt`. `robots.txt` has no `Host:` line (not valid). Check with curl: `text/markdown` alternates, every `llms.txt` link returns 200.
