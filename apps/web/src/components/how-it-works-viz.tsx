/**
 * How it works — the signature animated infographic.
 *
 * A deferrable AI task lands on the dirty PEAK of the grid's 24-hour
 * carbon curve. Tidegap rides it down the curve — the low tide — into the
 * clean overnight TROUGH and dispatches it there. From the dispatch
 * point four energy streams fan out, glowing particles flowing along
 * each, and the four wins light up together: carbon, cost, latency,
 * grid load — the four parallel wins, made literal.
 *
 * Pure SVG + CSS keyframes on one shared 13s loop — no JS, no client
 * component. Particles ride the connectors via CSS Motion Path
 * (offset-path). Honours prefers-reduced-motion with a resolved still.
 */

import { Activity, Coins, Leaf, Zap, type LucideIcon } from "lucide-react";

type Hue = "emerald" | "amber" | "sky" | "violet";

const HEX: Record<Hue, string> = {
  emerald: "#34d399",
  amber: "#fbbf24",
  sky: "#38bdf8",
  violet: "#a78bfa",
};

/** The four streams — connector path + landing node, fanning from the trough. */
const STREAMS: Array<{ hue: Hue; d: string; nx: number }> = [
  { hue: "emerald", d: "M440 212 C 372 252 196 266 110 290", nx: 110 },
  { hue: "amber", d: "M440 212 C 414 254 352 270 330 290", nx: 330 },
  { hue: "sky", d: "M440 212 C 466 254 528 270 550 290", nx: 550 },
  { hue: "violet", d: "M440 212 C 508 252 684 266 770 290", nx: 770 },
];

const WINS: Array<{
  idx: number;
  label: string;
  value: string;
  caption: string;
  Icon: LucideIcon;
  hue: Hue;
}> = [
  { idx: 0, label: "Carbon", value: "Lower", caption: "vs dispatching at peak", Icon: Leaf, hue: "emerald" },
  { idx: 1, label: "Cost", value: "−50%", caption: "Batch window (projected)", Icon: Coins, hue: "amber" },
  { idx: 2, label: "Latency", value: "Faster", caption: "off-peak capacity", Icon: Zap, hue: "sky" },
  { idx: 3, label: "Grid load", value: "−84%", caption: "time-shifted (simulated)", Icon: Activity, hue: "violet" },
];

const HUE: Record<Hue, { ring: string; icon: string; value: string }> = {
  emerald: { ring: "border-emerald-400/25", icon: "text-emerald-300", value: "text-emerald-200" },
  amber: { ring: "border-amber-400/25", icon: "text-amber-300", value: "text-amber-200" },
  sky: { ring: "border-sky-400/25", icon: "text-sky-300", value: "text-sky-200" },
  violet: { ring: "border-violet-400/25", icon: "text-violet-300", value: "text-violet-200" },
};

export function HowItWorksViz() {
  return (
    <div className="space-y-6 rounded-2xl border border-rule bg-bg-elev p-5 sm:p-8">
      <header className="space-y-2">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-accent">
          one shift, four wins
        </p>
        <h3 className="text-xl font-semibold tracking-tight text-fg sm:text-2xl">
          One scheduled task, four parallel wins.
        </h3>
        <p className="max-w-2xl text-sm leading-relaxed text-fg-muted">
          A task arrives while the grid is at peak — dirty, strained,
          expensive. Tidegap rides it down the carbon curve and dispatches it
          at the clean off-peak trough. From that one dispatch, four wins
          flow out at once — carbon, cost, latency and grid load — because
          they all track the same thing: grid demand.
        </p>
      </header>

      {/* ── the signature animation + the four wins, one panel ──────────── */}
      <div className="overflow-hidden rounded-xl border border-rule bg-[#0a0e13]">
        <svg
          role="img"
          aria-label="A deferrable AI task arrives at the dirty peak of the grid's 24-hour carbon-intensity curve. Tidegap rides it down to the clean overnight trough and dispatches it there. Four energy streams then flow out to four wins — lower carbon, lower cost, lower latency, lower grid load."
          viewBox="0 0 880 330"
          xmlns="http://www.w3.org/2000/svg"
          className="ebb-viz w-full"
          preserveAspectRatio="xMidYMid meet"
        >
          <defs>
            <pattern id="ebbDots" width="26" height="26" patternUnits="userSpaceOnUse">
              <circle cx="1.5" cy="1.5" r="1" fill="#141b26" />
            </pattern>
            <linearGradient id="ebbCurve" x1="50" y1="0" x2="830" y2="0" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#fb7185" />
              <stop offset="0.22" stopColor="#fb7185" />
              <stop offset="0.4" stopColor="#fbbf24" />
              <stop offset="0.56" stopColor="#34d399" />
              <stop offset="1" stopColor="#22d3ee" />
            </linearGradient>
            <linearGradient id="ebbArea" x1="50" y1="0" x2="830" y2="0" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#fb7185" stopOpacity="0.18" />
              <stop offset="0.4" stopColor="#fbbf24" stopOpacity="0.10" />
              <stop offset="0.56" stopColor="#34d399" stopOpacity="0.16" />
              <stop offset="1" stopColor="#22d3ee" stopOpacity="0.05" />
            </linearGradient>
            <linearGradient id="ebbAreaFade" x1="0" y1="60" x2="0" y2="250" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#0a0e13" stopOpacity="0" />
              <stop offset="1" stopColor="#0a0e13" stopOpacity="0.92" />
            </linearGradient>
            <radialGradient id="ebbTroughHalo">
              <stop offset="0" stopColor="#34d399" stopOpacity="0.6" />
              <stop offset="1" stopColor="#34d399" stopOpacity="0" />
            </radialGradient>
            <filter id="ebbGlow" x="-70%" y="-70%" width="240%" height="240%">
              <feGaussianBlur stdDeviation="6" />
            </filter>
            <filter id="ebbGlowS" x="-120%" y="-120%" width="340%" height="340%">
              <feGaussianBlur stdDeviation="2.6" />
            </filter>
          </defs>

          <rect width="880" height="330" fill="url(#ebbDots)" />

          {/* faint hour grid */}
          <g stroke="#1c2533" strokeWidth="1">
            <line x1="180" y1="46" x2="180" y2="226" />
            <line x1="310" y1="46" x2="310" y2="226" />
            <line x1="440" y1="46" x2="440" y2="226" />
            <line x1="570" y1="46" x2="570" y2="226" />
            <line x1="700" y1="46" x2="700" y2="226" />
          </g>

          {/* area under the carbon curve */}
          <path
            d="M50 158 C 110 150 165 82 220 74 C 300 65 370 195 440 210 C 510 195 600 96 830 120 L830 226 L50 226 Z"
            fill="url(#ebbArea)"
          />
          <rect x="50" y="56" width="780" height="170" fill="url(#ebbAreaFade)" />

          {/* the carbon curve — glow copy + crisp copy */}
          <path
            className="ebb-curve-glow"
            d="M50 158 C 110 150 165 82 220 74 C 300 65 370 195 440 210 C 510 195 600 96 830 120"
            fill="none"
            stroke="url(#ebbCurve)"
            strokeWidth="4"
            strokeLinecap="round"
            filter="url(#ebbGlow)"
          />
          <path
            d="M50 158 C 110 150 165 82 220 74 C 300 65 370 195 440 210 C 510 195 600 96 830 120"
            fill="none"
            stroke="url(#ebbCurve)"
            strokeWidth="2.5"
            strokeLinecap="round"
          />

          <text className="ebb-axis" x="220" y="216" textAnchor="middle">peak demand · dirty</text>
          <text className="ebb-axis ebb-axis-clean" x="492" y="190" textAnchor="middle">off-peak trough · clean</text>

          {/* peak marker */}
          <circle className="ebb-peak-pulse" cx="220" cy="74" r="9" fill="#fb7185" fillOpacity="0.22" />
          <circle cx="220" cy="74" r="4.5" fill="#fb7185" />

          {/* ── the four streams: connectors fan from the trough ─────────── */}
          {STREAMS.map((s) => (
            <path
              key={`base-${s.hue}`}
              d={s.d}
              fill="none"
              stroke={HEX[s.hue]}
              strokeWidth="1.5"
              strokeLinecap="round"
              className="ebb-conn"
            />
          ))}
          {STREAMS.map((s) => (
            <path
              key={`lit-${s.hue}`}
              d={s.d}
              fill="none"
              stroke={HEX[s.hue]}
              strokeWidth="2.4"
              strokeLinecap="round"
              filter="url(#ebbGlow)"
              className="ebb-conn-lit"
            />
          ))}

          {/* flowing particles — three per stream, ride the connector path */}
          {STREAMS.flatMap((s) =>
            [0, 1, 2].map((k) => (
              <circle
                key={`dot-${s.hue}-${k}`}
                r="3.1"
                fill={HEX[s.hue]}
                filter="url(#ebbGlowS)"
                className="ebb-dot"
                style={{
                  offsetPath: `path("${s.d}")`,
                  offsetRotate: "0deg",
                  animationDelay: `${(-0.55 * k).toFixed(2)}s, 0s`,
                }}
              />
            )),
          )}

          {/* trough halo + dispatch burst */}
          <circle className="ebb-trough-halo" cx="440" cy="210" r="48" fill="url(#ebbTroughHalo)" />
          <circle className="ebb-burst ebb-burst-1" cx="440" cy="210" r="6" fill="none" stroke="#34d399" strokeWidth="2.5" />
          <circle className="ebb-burst ebb-burst-2" cx="440" cy="210" r="6" fill="none" stroke="#5eead4" strokeWidth="2" />
          <circle cx="440" cy="210" r="5.5" fill="#34d399" />

          {/* landing nodes — one per stream, light up as particles arrive */}
          {STREAMS.map((s) => (
            <g key={`node-${s.hue}`} transform={`translate(${s.nx} 290)`}>
              <circle className={`ebb-node-halo ebb-h-${s.hue}`} r="17" fill={HEX[s.hue]} />
              <circle className={`ebb-node-ring ebb-h-${s.hue}`} r="9" fill="none" stroke={HEX[s.hue]} strokeWidth="2" />
              <circle className={`ebb-node-core ebb-h-${s.hue}`} r="3.6" fill={HEX[s.hue]} />
            </g>
          ))}

          {/* grid-status pill */}
          <g>
            <rect x="366" y="26" width="118" height="24" rx="12" fill="#0c1014" stroke="#222b38" />
            <circle className="ebb-status-led" cx="384" cy="38" r="3.5" />
            <text className="ebb-status ebb-status-peak" x="400" y="39">PEAK · dirty</text>
            <text className="ebb-status ebb-status-clean" x="396" y="39">CLEAN · off-peak</text>
          </g>

          {/* result check at the trough */}
          <g className="ebb-result">
            <circle r="14" fill="#34d399" fillOpacity="0.16" stroke="#34d399" strokeWidth="2" />
            <path d="M -5.5 0 L -1.5 4.5 L 6.5 -5" fill="none" stroke="#5eead4" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
          </g>

          {/* the task chip — rides the curve from peak to trough */}
          <g className="ebb-task">
            <rect className="ebb-chip-shadow" x="-40" y="-17" width="80" height="34" rx="9" filter="url(#ebbGlowS)" />
            <rect className="ebb-chip" x="-40" y="-17" width="80" height="34" rx="9" fill="#0e151d" />
            <circle className="ebb-chip-dot" cx="-25" cy="0" r="4.5" />
            <text className="ebb-chip-label" x="6" y="1" textAnchor="middle">AI task</text>
          </g>

          <style>{`
            /* One 15s loop with two deliberate dwells:
               · 5%–22%   — task RECEIVED, parked at the dirty peak (~2.5s)
               · ~52%–88% — task EXECUTED, the four wins held (~5.4s)
               The ride and reset bridge the two pauses. */
            .ebb-viz text { font-family: ui-monospace, SFMono-Regular, monospace; dominant-baseline: middle; }
            .ebb-axis { font-size: 10px; letter-spacing: 0.5px; fill: #5b6675; }
            .ebb-axis-clean { animation: ebbAxisClean 15s ease-in-out infinite; }
            @keyframes ebbAxisClean { 0%,44%{fill:#5b6675;} 54%,86%{fill:#34d399;} 100%{fill:#5b6675;} }

            .ebb-status { font-size: 10px; letter-spacing: 0.6px; }
            .ebb-status-peak  { fill: #fb7185; animation: ebbFadePeak 15s infinite; }
            .ebb-status-clean { fill: #34d399; opacity: 0; animation: ebbFadeClean 15s infinite; }
            .ebb-status-led   { fill: #fb7185; animation: ebbLed 15s infinite; }
            @keyframes ebbFadePeak  { 0%,40%{opacity:1;} 47%,92%{opacity:0;} 100%{opacity:1;} }
            @keyframes ebbFadeClean { 0%,40%{opacity:0;} 47%,92%{opacity:1;} 100%{opacity:0;} }
            @keyframes ebbLed { 0%,40%{fill:#fb7185;} 47%,92%{fill:#34d399;} 100%{fill:#fb7185;} }

            .ebb-curve-glow { opacity: 0.3; animation: ebbCurveGlow 15s ease-in-out infinite; }
            @keyframes ebbCurveGlow { 0%,44%{opacity:0.24;} 56%,86%{opacity:0.58;} 100%{opacity:0.24;} }

            .ebb-peak-pulse { animation: ebbPeakPulse 2.6s ease-in-out infinite; }
            @keyframes ebbPeakPulse { 0%,100%{r:9px;opacity:0.5;} 50%{r:15px;opacity:0.05;} }

            .ebb-trough-halo { opacity: 0; animation: ebbTroughHalo 15s ease-in-out infinite; }
            @keyframes ebbTroughHalo {
              0%,47%{opacity:0;} 52%{opacity:0.95;} 58%{opacity:0.55;}
              64%,86%{opacity:0.7;} 92%,100%{opacity:0;}
            }
            .ebb-burst { opacity: 0; }
            .ebb-burst-1 { animation: ebbBurst 15s ease-out infinite; }
            .ebb-burst-2 { animation: ebbBurst 15s ease-out infinite; animation-delay: 0.3s; }
            @keyframes ebbBurst {
              0%,48%{r:6px;opacity:0;} 52%{r:6px;opacity:0.9;}
              60%{r:58px;opacity:0;} 100%{r:58px;opacity:0;}
            }

            /* connectors — dim base, lit overlay held through the executed dwell */
            .ebb-conn { opacity: 0.16; }
            .ebb-conn-lit { opacity: 0; animation: ebbConnLit 15s ease-out infinite; }
            @keyframes ebbConnLit {
              0%,49%{opacity:0;} 54%{opacity:0.5;} 62%,86%{opacity:0.34;} 92%,100%{opacity:0;}
            }

            /* flowing particles ride the connector via offset-path */
            .ebb-dot {
              offset-distance: 0%;
              animation: ebbFlow 1.65s linear infinite, ebbDotGate 15s infinite;
            }
            @keyframes ebbFlow { to { offset-distance: 100%; } }
            @keyframes ebbDotGate {
              0%,50%{opacity:0;} 54%,86%{opacity:1;} 90%,100%{opacity:0;}
            }

            /* landing nodes */
            .ebb-node-halo { opacity: 0; animation: ebbNodeHalo 15s ease-out infinite; }
            .ebb-node-ring { opacity: 0.2; animation: ebbNodeRing 15s ease-out infinite; }
            .ebb-node-core { opacity: 0.25; animation: ebbNodeCore 15s ease-out infinite; }
            @keyframes ebbNodeHalo {
              0%,53%{opacity:0;} 61%{opacity:0.4;} 72%,86%{opacity:0.26;} 92%,100%{opacity:0;}
            }
            @keyframes ebbNodeRing {
              0%,52%{opacity:0.2;} 60%{opacity:1;} 86%{opacity:0.85;} 92%,100%{opacity:0.2;}
            }
            @keyframes ebbNodeCore {
              0%,52%{opacity:0.25;r:3.6px;} 59%{opacity:1;r:5px;}
              70%,86%{opacity:1;r:3.9px;} 92%,100%{opacity:0.25;r:3.6px;}
            }

            /* the task chip — glides the real curve via CSS Motion Path
               (one continuous bezier sweep), and dwells at peak then trough */
            .ebb-task {
              offset-path: path("M220 74 C 300 65 370 195 440 210");
              offset-rotate: 0deg;
              offset-distance: 0%;
              animation: ebbTask 15s linear infinite;
            }
            @keyframes ebbTask {
              0%   { offset-distance: 0%;   opacity: 0; transform: scale(0.55); }
              5%   { offset-distance: 0%;   opacity: 1; transform: scale(1); }
              22%  { offset-distance: 0%;   opacity: 1; transform: scale(1);
                     animation-timing-function: cubic-bezier(0.45,0,0.55,1); }
              48%  { offset-distance: 100%; opacity: 1; transform: scale(1); }
              52%  { offset-distance: 100%; opacity: 1; transform: scale(1.08); }
              56%  { offset-distance: 100%; opacity: 0; transform: scale(0.4); }
              100% { offset-distance: 100%; opacity: 0; transform: scale(0.55); }
            }
            .ebb-chip       { stroke: #fbbf24; stroke-width: 1.6; animation: ebbChipStroke 15s infinite; }
            .ebb-chip-shadow{ fill: #fbbf24; opacity: 0.22; animation: ebbChipStroke 15s infinite; }
            .ebb-chip-dot   { fill: #fbbf24; animation: ebbChipStroke 15s infinite; }
            .ebb-chip-label { font-size: 11.5px; fill: #e6e8ee; }
            @keyframes ebbChipStroke {
              0%,30%   { stroke: #fbbf24; fill: #fbbf24; }
              46%,100% { stroke: #34d399; fill: #34d399; }
            }

            .ebb-result {
              opacity: 0;
              transform: translate(440px,210px) scale(0.3);
              animation: ebbResult 15s ease-out infinite;
            }
            @keyframes ebbResult {
              0%,52%  { opacity: 0; transform: translate(440px,210px) scale(0.3); }
              57%     { opacity: 1; transform: translate(440px,210px) scale(1.16); }
              61%,86% { opacity: 1; transform: translate(440px,210px) scale(1); }
              93%,100%{ opacity: 0; transform: translate(440px,210px) scale(1); }
            }

            /* the four win-cards charge + glow, held through the executed dwell */
            .ebb-card-bar { transform: scaleX(0); transform-origin: left; }
            .ebb-card-0 .ebb-card-bar { animation: ebbCharge 15s ease-out infinite; }
            .ebb-card-1 .ebb-card-bar { animation: ebbCharge 15s ease-out infinite; animation-delay: 0.05s; }
            .ebb-card-2 .ebb-card-bar { animation: ebbCharge 15s ease-out infinite; animation-delay: 0.1s; }
            .ebb-card-3 .ebb-card-bar { animation: ebbCharge 15s ease-out infinite; animation-delay: 0.15s; }
            @keyframes ebbCharge {
              0%,54%  { transform: scaleX(0); }
              66%,88% { transform: scaleX(1); }
              100%    { transform: scaleX(0); }
            }
            .ebb-card-glow { opacity: 0; }
            .ebb-card-0 .ebb-card-glow,
            .ebb-card-1 .ebb-card-glow,
            .ebb-card-2 .ebb-card-glow,
            .ebb-card-3 .ebb-card-glow { animation: ebbCardGlow 15s ease-out infinite; }
            .ebb-card-1 .ebb-card-glow { animation-delay: 0.05s; }
            .ebb-card-2 .ebb-card-glow { animation-delay: 0.1s; }
            .ebb-card-3 .ebb-card-glow { animation-delay: 0.15s; }
            @keyframes ebbCardGlow {
              0%,55%  { opacity: 0; }
              63%     { opacity: 1; }
              74%,86% { opacity: 0.5; }
              100%    { opacity: 0; }
            }

            @media (prefers-reduced-motion: reduce) {
              .ebb-viz *, .ebb-card-0, .ebb-card-1, .ebb-card-2, .ebb-card-3,
              .ebb-card-bar, .ebb-card-glow { animation: none !important; }
              .ebb-task { offset-distance: 100%; transform: scale(1); opacity: 1; }
              .ebb-chip, .ebb-chip-dot, .ebb-chip-shadow { stroke: #34d399; fill: #34d399; }
              .ebb-trough-halo { opacity: 0.6; }
              .ebb-curve-glow { opacity: 0.5; }
              .ebb-status-peak { opacity: 0; }
              .ebb-status-clean { opacity: 1; }
              .ebb-status-led { fill: #34d399; }
              .ebb-axis-clean { fill: #34d399; }
              .ebb-burst, .ebb-result, .ebb-dot { opacity: 0; }
              .ebb-conn-lit { opacity: 0.34; }
              .ebb-node-ring { opacity: 0.9; }
              .ebb-node-core { opacity: 1; }
              .ebb-card-bar { transform: scaleX(1); }
              .ebb-card-glow { opacity: 0.5; }
            }
          `}</style>
        </svg>

        {/* ── the four parallel wins ────────────────────────────────────── */}
        <div className="grid grid-cols-2 gap-px border-t border-rule bg-rule sm:grid-cols-4">
          {WINS.map((w) => (
            <WinCard key={w.idx} {...w} />
          ))}
        </div>
      </div>

      <p className="text-xs leading-relaxed text-fg-muted">
        Illustrative — the loop shows the mechanism, not live data. A
        deferrable task waits through the dirty, strained peak and is
        dispatched at the off-peak trough inside its deadline. Carbon, cost
        and latency move together because they all track grid demand; exact
        figures vary per region per day. Cost and grid-load figures are
        labelled projected/simulated above; sources in{" "}
        <a
          href="https://github.com/tidegap/tidegap/blob/main/docs/claims.md"
          target="_blank"
          rel="noreferrer"
          className="text-accent hover:underline"
        >
          docs/claims.md
        </a>
        .
      </p>
    </div>
  );
}

function WinCard({
  idx,
  label,
  value,
  caption,
  Icon,
  hue,
}: {
  idx: number;
  label: string;
  value: string;
  caption: string;
  Icon: LucideIcon;
  hue: Hue;
}) {
  const h = HUE[hue];
  return (
    <div
      className={`ebb-card-${idx} relative overflow-hidden bg-[#0a0e13] p-4`}
    >
      <div
        className="ebb-card-glow pointer-events-none absolute inset-0"
        style={{ background: `radial-gradient(120% 80% at 50% 100%, ${HEX[hue]}26, transparent 72%)` }}
      />
      <div className="relative flex items-center gap-2">
        <span className={`flex h-7 w-7 items-center justify-center rounded-md border ${h.ring} ${h.icon}`}>
          <Icon className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
        </span>
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-fg-muted">
          {label}
        </p>
      </div>
      <p className={`relative mt-3 font-mono text-2xl font-semibold ${h.value}`}>{value}</p>
      <p className="relative mt-0.5 text-[11px] text-fg-muted">{caption}</p>
      <div className="relative mt-3 h-1 overflow-hidden rounded-full bg-white/[0.06]">
        <div
          className="ebb-card-bar h-full rounded-full"
          style={{ background: `linear-gradient(90deg, ${HEX[hue]}55, ${HEX[hue]})` }}
        />
      </div>
    </div>
  );
}
