import { BRAND_HEADER, BRAND_PALETTE } from "@/lib/brand.generated";

/**
 * Horizontal Tidegap logo for the site header: heavy wave and outlined
 * wordmark from scripts/build-brand.mjs. Decorative; the enclosing link
 * carries the accessible name. The mark is a brand asset and never moves or
 * changes shape: the svg, the wave paths and their clips are static. The only
 * motion is the paint inside the stroke: a soft band of the other brand colour
 * (teal over the white crest, white over the teal trough) travels along the
 * wave, like day turning into night. The band is a gradient on a copy of the
 * stroke, and only the gradient moves. Under reduced motion the copies are
 * hidden (`tg-daynight` in globals.css) and the logo is the plain brand mark.
 */
export function Logo({ className }: { className?: string }) {
  const { viewBox, stroke, wave, wavePeriod, inkClip, tealClip, wordmark } = BRAND_HEADER;
  // One day-night cycle spans two wave periods, so the band visits each crest in turn.
  const cycle = 2 * wavePeriod;
  return (
    <svg viewBox={viewBox} className={className} aria-hidden="true" focusable="false">
      <defs>
        <clipPath id="tg-header-ink">
          <rect {...inkClip} />
        </clipPath>
        <clipPath id="tg-header-teal">
          <rect {...tealClip} />
        </clipPath>
        <Band id="tg-header-dusk" color={BRAND_PALETTE.teal} cycle={cycle} />
        <Band id="tg-header-dawn" color={BRAND_PALETTE.white} cycle={cycle} />
      </defs>
      <g clipPath="url(#tg-header-ink)" fill="none" strokeWidth={stroke}>
        <path d={wave} stroke={BRAND_PALETTE.white} />
        <path d={wave} stroke="url(#tg-header-dusk)" className="tg-daynight" />
      </g>
      <g clipPath="url(#tg-header-teal)" fill="none" strokeWidth={stroke}>
        <path d={wave} stroke={BRAND_PALETTE.teal} />
        <path d={wave} stroke="url(#tg-header-dawn)" className="tg-daynight" />
      </g>
      <path d={wordmark} fill={BRAND_PALETTE.white} />
    </svg>
  );
}

/**
 * A soft band of `color`, transparent elsewhere, repeating every `cycle`
 * units and sliding one cycle left to right every 10 s.
 */
function Band({ id, color, cycle }: { id: string; color: string; cycle: number }) {
  return (
    <linearGradient id={id} gradientUnits="userSpaceOnUse" x1={0} x2={cycle} spreadMethod="repeat">
      <stop offset={0.2} stopColor={color} stopOpacity={0} />
      <stop offset={0.5} stopColor={color} stopOpacity={0.9} />
      <stop offset={0.8} stopColor={color} stopOpacity={0} />
      <animateTransform
        attributeName="gradientTransform"
        type="translate"
        from={`${-cycle} 0`}
        to="0 0"
        dur="10s"
        repeatCount="indefinite"
      />
    </linearGradient>
  );
}
