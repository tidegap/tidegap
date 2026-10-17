import type { CSSProperties } from "react";
import { BRAND_HEADER, BRAND_PALETTE } from "@/lib/brand.generated";

type Box = { x: number; y: number; width: number; height: number };

/**
 * Horizontal Tidegap logo for the site header: heavy wave and outlined
 * wordmark from scripts/build-brand.mjs. Decorative; the enclosing link
 * carries the accessible name. The wave path slides one period inside
 * fixed clips (`tg-wave` in globals.css); the clips sit on the wrapping
 * groups so they do not move with the path. While it moves, a mask hides
 * and fades the window edges so the tip of an arm entering a window does
 * not show as a stray dot; the mask is off under reduced motion.
 */
export function Logo({ className }: { className?: string }) {
  const { viewBox, stroke, wave, wavePeriod, inkClip, tealClip, wordmark } = BRAND_HEADER;
  const period = { "--tg-wave-p": `${wavePeriod}px` } as CSSProperties;
  return (
    <svg viewBox={viewBox} className={className} style={period} aria-hidden="true" focusable="false">
      <defs>
        <clipPath id="tg-header-ink">
          <rect {...inkClip} />
        </clipPath>
        <clipPath id="tg-header-teal">
          <rect {...tealClip} />
        </clipPath>
        <EdgeFade id="tg-header-ink-fade" box={inkClip} hide={0.75 * stroke} ramp={1.25 * stroke} />
        <EdgeFade id="tg-header-teal-fade" box={tealClip} hide={0.25 * stroke} ramp={stroke} />
      </defs>
      <g clipPath="url(#tg-header-ink)" mask="url(#tg-header-ink-fade)" className="tg-wave-mask">
        <path className="tg-wave" d={wave} fill="none" stroke={BRAND_PALETTE.white} strokeWidth={stroke} />
      </g>
      <g clipPath="url(#tg-header-teal)" mask="url(#tg-header-teal-fade)" className="tg-wave-mask">
        <path className="tg-wave" d={wave} fill="none" stroke={BRAND_PALETTE.teal} strokeWidth={stroke} />
      </g>
      <path d={wordmark} fill={BRAND_PALETTE.white} />
    </svg>
  );
}

/**
 * Mask over `box`: clear for `hide` units at the left and right sides, then
 * ramping to opaque over the next `ramp` units. Sizes were tuned by rendering
 * the header at several animation phases.
 */
function EdgeFade({ id, box, hide, ramp }: { id: string; box: Box; hide: number; ramp: number }) {
  const clear = hide / box.width;
  const opaque = (hide + ramp) / box.width;
  return (
    <>
      <linearGradient id={`${id}-g`}>
        <stop offset={clear} stopColor="#000" />
        <stop offset={opaque} stopColor="#fff" />
        <stop offset={1 - opaque} stopColor="#fff" />
        <stop offset={1 - clear} stopColor="#000" />
      </linearGradient>
      <mask id={id} maskUnits="userSpaceOnUse" {...box}>
        <rect {...box} fill={`url(#${id}-g)`} />
      </mask>
    </>
  );
}
