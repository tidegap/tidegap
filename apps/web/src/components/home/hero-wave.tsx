import type { CSSProperties } from "react";
import { BRAND_HEADER, BRAND_PALETTE } from "@/lib/brand.generated";

const { wave, wavePeriod } = BRAND_HEADER;
// Lighter than the header stroke: at hero size the brand weight would read as a band.
const stroke = BRAND_HEADER.stroke * 0.4;

// The brand wave path spans three periods and ends at the height it started,
// so a copy shifted right by three periods continues it seamlessly.
const SPAN = 3 * wavePeriod;
// Crest and trough centrelines of the brand wave, padded by half the stroke.
const TOP = -94.93 - stroke / 2;
const BOTTOM = -5.07 + stroke / 2;
// The brand splits ink and teal at this line: teal only in the troughs.
const TROUGH_LINE = -50.5;

const tide = { "--tide-p": `${wavePeriod}px` } as CSSProperties;

/**
 * The large brand wave behind the hero (M3, M4). Built from the header
 * geometry in brand.generated.ts, scaled up along the bottom of the first
 * screen: a faint white crest and teal troughs, split at the same line as the
 * logo. The path drifts one period
 * per `--dur-tide`; reduced motion keeps it still. Decorative only.
 */
export function HeroWave() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 [mask-image:linear-gradient(to_right,transparent,black_15%,black_85%,transparent)]"
    >
      <svg
        viewBox={`0 ${TOP} ${SPAN} ${BOTTOM - TOP}`}
        className="-ml-[35%] block h-auto w-[170%] max-w-none sm:-ml-[10%] sm:w-[120%]"
        focusable="false"
      >
        <defs>
          <clipPath id="hero-wave-crest">
            <rect x={0} y={TOP} width={SPAN} height={TROUGH_LINE - TOP} />
          </clipPath>
          <clipPath id="hero-wave-trough">
            <rect x={0} y={TROUGH_LINE} width={SPAN} height={BOTTOM - TROUGH_LINE} />
          </clipPath>
        </defs>
        <g clipPath="url(#hero-wave-crest)">
          <WavePath color={BRAND_PALETTE.white} opacity={0.06} />
        </g>
        <g clipPath="url(#hero-wave-trough)">
          <g className="glow-in" opacity={0.45}>
            <WavePath color={BRAND_PALETTE.teal} opacity={1} />
          </g>
        </g>
      </svg>
    </div>
  );
}

function WavePath({ color, opacity }: { color: string; opacity: number }) {
  return (
    <g className="tide" style={tide} opacity={opacity}>
      <path d={wave} fill="none" stroke={color} strokeWidth={stroke} />
      <path d={wave} fill="none" stroke={color} strokeWidth={stroke} transform={`translate(${SPAN} 0)`} />
    </g>
  );
}
