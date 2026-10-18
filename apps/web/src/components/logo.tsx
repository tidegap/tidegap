import type { CSSProperties } from "react";
import { BRAND_HEADER, BRAND_PALETTE } from "@/lib/brand.generated";

const { viewBox, stroke, wave, inkClip, tealClip, wordmark } = BRAND_HEADER;

// The waterline inside the trough: two ripples per trough width, rising and
// falling TIDE units around the brand's ink/teal split line.
const RIPPLE = tealClip.width / 2;
const TIDE = 22;
const SPLIT = tealClip.y;
const BOTTOM = tealClip.y + tealClip.height;
// Drawn from the trough's left edge over three ripples (trough width plus one
// ripple), so a shift of one ripple to either side still covers the trough.
const WATERLINE =
  `M${tealClip.x} ${SPLIT}q${RIPPLE / 4} ${-TIDE} ${RIPPLE / 2} 0` +
  `t${RIPPLE / 2} 0`.repeat(5) +
  `V${BOTTOM}H${tealClip.x}Z`;
// The teal layer may rise TIDE units above the split line.
const tealBox = { ...tealClip, y: SPLIT - TIDE, height: tealClip.height + TIDE };

const ripple = { "--tg-wave-p": `${RIPPLE}px` } as CSSProperties;

/**
 * Horizontal Tidegap logo for the site header: heavy wave and outlined
 * wordmark from scripts/build-brand.mjs. Decorative; the enclosing link
 * carries the accessible name. The mark is static: the white wave is clipped
 * to the brand's ink and teal windows, so its outline never moves. Only the
 * waterline inside the trough moves (`tg-wave` in globals.css): it slides one
 * ripple in a loop, and the teal fills the mark below it. Reduced motion
 * keeps the waterline still.
 */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox={viewBox} className={className} aria-hidden="true" focusable="false">
      <defs>
        <clipPath id="tg-header-mark">
          <rect {...inkClip} />
          <rect {...tealClip} />
        </clipPath>
        <clipPath id="tg-header-trough">
          <rect {...tealBox} />
        </clipPath>
        <mask id="tg-header-tide" maskUnits="userSpaceOnUse" {...tealBox}>
          <path className="tg-wave" style={ripple} d={WATERLINE} fill="#fff" />
        </mask>
      </defs>
      <g clipPath="url(#tg-header-mark)">
        <path d={wave} fill="none" stroke={BRAND_PALETTE.white} strokeWidth={stroke} />
        <g clipPath="url(#tg-header-trough)" mask="url(#tg-header-tide)">
          <path d={wave} fill="none" stroke={BRAND_PALETTE.teal} strokeWidth={stroke} />
        </g>
      </g>
      <path d={wordmark} fill={BRAND_PALETTE.white} />
    </svg>
  );
}
