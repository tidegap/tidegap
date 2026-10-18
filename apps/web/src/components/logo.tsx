import type { ReactNode } from "react";
import { BRAND_HEADER, BRAND_PALETTE } from "@/lib/brand.generated";

const { viewBox, stroke, wave, inkClip, tealClip, wordmark } = BRAND_HEADER;

// The white/teal split line, midway in the brand's half-unit overlap between
// the bottom of the ink box and the top of the teal box.
const SPLIT = (inkClip.y + inkClip.height + tealClip.y) / 2;
const TROUGH_BOTTOM = tealClip.y + tealClip.height;
// Day: the white sinks SINK units down the trough's flanks, then the teal
// rises back to the brand split line, once every 12 s.
const SINK = 18;
const [vbX, vbY, vbW, vbH] = viewBox.split(" ").map(Number);

/**
 * Horizontal Tidegap logo for the site header: heavy wave and outlined
 * wordmark from scripts/build-brand.mjs. Decorative; the enclosing link
 * carries the accessible name.
 *
 * The mark is the brand mark and never moves or changes shape: one wave path
 * clipped to the brand's ink and teal boxes, both static. The only motion is
 * inside its paint (`Split`): the top of the teal box slides down the
 * trough's flanks and back, night into day and back. One path with one paint
 * keeps the split free of seams at every frame. At the start of the loop, and
 * under reduced motion (`tg-wave` in globals.css), the split is the brand line.
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
          <animate
            attributeName="y"
            values={`${SPLIT};${SPLIT + SINK};${SPLIT}`}
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

/**
 * The brand paint: white everywhere, teal in the trough box below the split
 * line. A pattern, not a gradient, so the teal stays between the crest
 * centres: a gradient is sampled at pixel centres, and on some screens it
 * tinted the antialiased bottom row of the outer arms teal.
 */
function Split({ id, children }: { id: string; children?: ReactNode }) {
  return (
    <pattern id={id} patternUnits="userSpaceOnUse" x={vbX} y={vbY} width={vbW} height={vbH} viewBox={viewBox}>
      <rect x={vbX} y={vbY} width={vbW} height={vbH} fill={BRAND_PALETTE.white} />
      <rect x={tealClip.x} y={SPLIT} width={tealClip.width} height={TROUGH_BOTTOM - SPLIT} fill={BRAND_PALETTE.teal}>
        {children}
      </rect>
    </pattern>
  );
}
