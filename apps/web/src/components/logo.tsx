import type { ReactNode } from "react";
import { BRAND_HEADER, BRAND_PALETTE } from "@/lib/brand.generated";

const { viewBox, stroke, wave, inkClip, tealClip, wordmark } = BRAND_HEADER;

// The white/teal split line, midway in the brand's half-unit overlap between
// the bottom of the ink box and the top of the teal box.
const SPLIT = (inkClip.y + inkClip.height + tealClip.y) / 2;
// Day: the white sinks SINK units down the trough's flanks, then the teal
// rises back to the brand split line, once every 12 s. Outside the trough no
// part of the mark lies below the split, so the outer arms stay white.
const SINK = 18;

/**
 * Horizontal Tidegap logo for the site header: heavy wave and outlined
 * wordmark from scripts/build-brand.mjs. Decorative; the enclosing link
 * carries the accessible name.
 *
 * The mark is the brand mark and never moves or changes shape: one wave path
 * clipped to the brand's ink and teal boxes, both static. The only motion is
 * its paint, white over teal, whose split line slides down the trough's
 * flanks and back, night into day and back. One path with one paint keeps the
 * split free of seams at every frame. At the start of the loop, and under
 * reduced motion (`tg-wave` in globals.css), the split is the brand line.
 */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox={viewBox} className={className} aria-hidden="true" focusable="false">
      <defs>
        <clipPath id="tg-header-mark">
          <rect {...inkClip} />
          <rect {...tealClip} />
        </clipPath>
        <Split id="tg-header-split" />
        <Split id="tg-header-tide">
          <animateTransform
            attributeName="gradientTransform"
            type="translate"
            values={`0 0;0 ${SINK};0 0`}
            dur="12s"
            repeatCount="indefinite"
            calcMode="spline"
            keyTimes="0;0.5;1"
            keySplines="0.42 0 0.58 1;0.42 0 0.58 1"
          />
        </Split>
      </defs>
      <path
        d={wave}
        fill="none"
        stroke="url(#tg-header-tide)"
        strokeWidth={stroke}
        clipPath="url(#tg-header-mark)"
        className="tg-wave"
      />
      <path d={wordmark} fill={BRAND_PALETTE.white} />
    </svg>
  );
}

/** White above the brand split line, teal below it, with a hard edge. */
function Split({ id, children }: { id: string; children?: ReactNode }) {
  return (
    <linearGradient id={id} gradientUnits="userSpaceOnUse" x1={0} x2={0} y1={SPLIT - 1} y2={SPLIT + 1}>
      <stop offset={0.5} stopColor={BRAND_PALETTE.white} />
      <stop offset={0.5} stopColor={BRAND_PALETTE.teal} />
      {children}
    </linearGradient>
  );
}
