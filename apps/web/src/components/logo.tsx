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
// ripple), so the loop, which starts one ripple to the left, always covers it.
const WATERLINE =
  `M${tealClip.x} ${SPLIT}q${RIPPLE / 4} ${-TIDE} ${RIPPLE / 2} 0` +
  `t${RIPPLE / 2} 0`.repeat(5) +
  `V${BOTTOM}H${tealClip.x}Z`;
// The mask region: the trough window, raised TIDE units so the teal can rise above the split.
const tealBox = { ...tealClip, y: SPLIT - TIDE, height: tealClip.height + TIDE };

const rippleStyle = { "--tg-wave-p": `${RIPPLE}px` } as CSSProperties;

/**
 * Horizontal Tidegap logo for the site header, from scripts/build-brand.mjs.
 * The mark's outline is static. Only the waterline mask inside the trough
 * moves (`tg-wave` in globals.css), so the teal level ripples while the
 * logo itself stays put. Animate that inner path, never the svg or a group.
 */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox={viewBox} className={className} aria-hidden="true" focusable="false">
      <defs>
        <clipPath id="tg-header-mark">
          <rect {...inkClip} />
          <rect {...tealClip} />
        </clipPath>
        <mask id="tg-header-tide" maskUnits="userSpaceOnUse" {...tealBox}>
          <path className="tg-wave" style={rippleStyle} d={WATERLINE} fill="#fff" />
        </mask>
      </defs>
      <g clipPath="url(#tg-header-mark)">
        <path d={wave} fill="none" stroke={BRAND_PALETTE.white} strokeWidth={stroke} />
        <g mask="url(#tg-header-tide)">
          <path d={wave} fill="none" stroke={BRAND_PALETTE.teal} strokeWidth={stroke} />
        </g>
      </g>
      <path d={wordmark} fill={BRAND_PALETTE.white} />
    </svg>
  );
}
