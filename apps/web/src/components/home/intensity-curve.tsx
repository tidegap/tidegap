import type { CSSProperties } from "react";
import { bandColor } from "@/components/carbon-band";
import type { VisitorForecast } from "@/lib/visitor-forecast";
import type { GridForecast } from "@/lib/types";

// Plot box in viewBox units. Text is HTML on top, so it stays readable at
// phone width while the SVG scales.
const W = 600;
const H = 220;
const PAD = { left: 8, right: 8, top: 12, bottom: 12 };

const FEED_NAME: Record<GridForecast["source"], string> = {
  ukCarbonIntensity: "National Grid ESO",
  electricityMaps: "Electricity Maps",
  eia: "U.S. EIA",
  entsoe: "ENTSO-E",
  wattTime: "WattTime",
  mock: "simulated",
};

function hourFormat(timeZone: string) {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone });
}

function zoneAbbreviation(timeZone: string, at: Date) {
  const locale = timeZone.startsWith("America/") ? "en-US" : "en-GB";
  const part = new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: "short" })
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName");
  return part?.value ?? timeZone;
}

const pct = (v: number, of: number) => `${(v / of) * 100}%`;

/**
 * The visitor's next 24 hours of grid carbon intensity (R7, R8), as a
 * server-rendered SVG: one path that draws in on scroll (M7), coloured by
 * band through a hard-stop gradient, with "now" and "cleanest" markers (M8).
 * The y-axis starts at 0 with a domain of at least 0-300, so a flat grid
 * looks flat. Values are shown only when the forecast is live.
 */
export function IntensityCurve({ data }: { data: VisitorForecast }) {
  const { entries, now, cleanest, live, timeZone } = data;
  const values = entries.map((e) => e.carbonIntensityGCo2PerKwh);
  const top = Math.max(300, Math.ceil(Math.max(...values) / 100) * 100);
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (i * plotW) / Math.max(1, entries.length - 1);
  const y = (v: number) => PAD.top + plotH * (1 - v / top);

  const d = entries.map((e, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(e.carbonIntensityGCo2PerKwh).toFixed(1)}`).join("");

  // Hard stops halfway between two hours whose bands differ.
  const stops: Array<{ at: number; color: string }> = [];
  entries.forEach((e, i) => {
    const color = bandColor(e.band);
    if (i === 0) stops.push({ at: 0, color });
    else if (e.band !== entries[i - 1]!.band) {
      const mid = (i - 0.5) / (entries.length - 1);
      stops.push({ at: mid, color: bandColor(entries[i - 1]!.band) }, { at: mid, color });
    }
  });
  stops.push({ at: 1, color: bandColor(entries[entries.length - 1]!.band) });

  const fmt = hourFormat(timeZone);
  const hourOf = (iso: string) => fmt.format(new Date(iso));
  const ticks = entries
    .map((e, i) => ({ i, label: hourOf(e.datetime) }))
    .filter((t) => Number(t.label.slice(0, 2)) % 6 === 0);
  const zone = zoneAbbreviation(timeZone, new Date(now.datetime));

  const nowIdx = 0;
  const cleanIdx = entries.indexOf(cleanest);
  const value = (v: number) => (live ? ` · ${Math.round(v)} g` : "");
  const sameHour = cleanIdx === nowIdx;

  // The now label sits above its point and the cleanest label below its own,
  // so the two never meet; a cleanest point too low for a label under it
  // (it would cover the hour ticks) keeps its label above.
  const cleanBelow = y(cleanest.carbonIntensityGCo2PerKwh) < H * 0.7;

  const title = live
    ? `${data.region.name} grid carbon intensity, next 24 hours. Now ${Math.round(now.carbonIntensityGCo2PerKwh)} gCO₂/kWh at ${hourOf(now.datetime)} ${zone}; cleanest ${Math.round(cleanest.carbonIntensityGCo2PerKwh)} gCO₂/kWh at ${hourOf(cleanest.datetime)}. Source: ${FEED_NAME[data.source]}.`
    : "Simulated grid carbon intensity curve for the next 24 hours; the live feed is unavailable.";

  return (
    <figure>
      <div className="pl-9 pt-8">
        <div className="relative">
          {/* Y gridline labels. */}
          {[top / 2, top].map((v) => (
            <span
              key={v}
              className="absolute right-full mr-2 -translate-y-1/2 font-mono text-[10px] text-fg-dim tabular-nums"
              style={{ top: pct(y(v), H) }}
            >
              {v}
            </span>
          ))}
          <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full overflow-visible" role="img">
            <title>{title}</title>
            <defs>
              <linearGradient id="curve-bands" gradientUnits="userSpaceOnUse" x1={PAD.left} x2={W - PAD.right} y1={0} y2={0}>
                {stops.map((s, i) => (
                  <stop key={i} offset={s.at} stopColor={s.color} />
                ))}
              </linearGradient>
            </defs>
            {[0, top / 2, top].map((v) => (
              <line
                key={v}
                x1={PAD.left}
                x2={W - PAD.right}
                y1={y(v)}
                y2={y(v)}
                stroke="var(--color-rule)"
                strokeDasharray={v ? "3 5" : undefined}
              />
            ))}
            <path
              d={d}
              pathLength={1}
              className="draw"
              fill="none"
              stroke={live ? "url(#curve-bands)" : "var(--color-fg-dim)"}
              strokeWidth={3}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          </svg>

          <Marker
            x={x(nowIdx)}
            y={y(now.carbonIntensityGCo2PerKwh)}
            color={live ? bandColor(now.band) : "var(--color-fg-muted)"}
            label={`${sameHour ? "Now, and the cleanest hour" : "Now"}${value(now.carbonIntensityGCo2PerKwh)} · ${hourOf(now.datetime)}`}
            below={false}
          />
          {sameHour ? null : (
            <Marker
              x={x(cleanIdx)}
              y={y(cleanest.carbonIntensityGCo2PerKwh)}
              color={live ? bandColor(cleanest.band) : "var(--color-fg-muted)"}
              label={`Cleanest${value(cleanest.carbonIntensityGCo2PerKwh)} · ${hourOf(cleanest.datetime)}`}
              below={cleanBelow}
            />
          )}
        </div>
        {/* X ticks every 6 hours, local time of the region shown. */}
        <div className="relative mt-2 h-4">
          {ticks.map((t) => (
            <span
              key={t.i}
              className="absolute -translate-x-1/2 font-mono text-[10px] text-fg-dim tabular-nums"
              style={{ left: pct(x(t.i), W) }}
            >
              {t.label}
            </span>
          ))}
        </div>
      </div>
      <figcaption className="mt-4 text-sm text-fg-muted">
        <Caption data={data} zone={zone} />
      </figcaption>
    </figure>
  );
}

function Marker({ x, y, color, label, below }: { x: number; y: number; color: string; label: string; below: boolean }) {
  const align = x < W * 0.2 ? "left-0" : x > W * 0.8 ? "right-0" : "left-0 -translate-x-1/2";
  return (
    <div className="pop absolute h-0 w-0" style={{ left: pct(x, W), top: pct(y, H) } as CSSProperties}>
      <span
        className="absolute -left-[6px] -top-[6px] h-3 w-3 rounded-full border-2 border-bg"
        style={{ background: color }}
      />
      <span
        className={`absolute ${align} ${below ? "top-3" : "bottom-3"} whitespace-nowrap rounded bg-bg-elev/90 px-1.5 py-0.5 font-mono text-[11px] text-fg`}
      >
        {label}
      </span>
    </div>
  );
}

function Caption({ data, zone }: { data: VisitorForecast; zone: string }) {
  if (!data.live) {
    return <>Simulated curve (live feed unavailable). Hours in {zone}.</>;
  }
  const feed = FEED_NAME[data.source];
  const where = data.fallback
    ? "Great Britain. Your grid has no live feed here right now, so this is the GB reference grid"
    : data.geo
      ? `your nearest grid, ${data.region.name}`
      : `${data.region.name}, our reference grid`;
  return (
    <>
      <span className="mr-2 inline-flex items-center gap-1.5 font-mono text-xs uppercase tracking-wider text-accent">
        <span className="h-1.5 w-1.5 rounded-full bg-accent motion-safe:animate-pulse" aria-hidden="true" />
        Live forecast
      </span>
      Next 24 hours for {where}. Data: {feed}. Hours in {zone}, values in gCO₂/kWh.
    </>
  );
}
