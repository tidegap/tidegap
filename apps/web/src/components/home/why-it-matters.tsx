import { Suspense } from "react";
import { headers } from "next/headers";
import { Card, Stat } from "@/components/ui/card";
import { Section } from "@/components/ui/section";
import { getVisitorForecast } from "@/lib/visitor-forecast";
import { IntensityCurve } from "./intensity-curve";
import { ReceiptCard } from "./receipt-card";

const CLAIMS_URL = "https://github.com/tidegap/tidegap/blob/main/docs/claims.md";
const DOE_URL =
  "https://www.energy.gov/eere/buildings/articles/2024-united-states-data-center-energy-usage-report";

// The streamed curve and its skeleton share this box, sized from the card
// width (container query), so the stream-in shifts nothing (R40): top label
// room + the 600x220 plot + the tick row + up to four caption lines.
const CURVE_BOX = "min-h-[calc(32px+(100cqw-36px)*0.3667+40px+5rem)]";

export function WhyItMatters() {
  return (
    <Section
      id="why"
      eyebrow="Why it matters"
      title="The same electricity is cleaner at some hours."
      lead="Grid carbon intensity rises and falls through the day as sun, wind and demand change."
    >
      <div className="grid gap-5 lg:grid-cols-5">
        <Card className="reveal lg:col-span-3">
          <div className="@container">
            <div className={CURVE_BOX}>
              <Suspense fallback={<CurveSkeleton />}>
                <VisitorCurve />
              </Suspense>
            </div>
          </div>
        </Card>
        <figure className="reveal flex flex-col lg:col-span-2">
          <ReceiptCard />
          <figcaption className="type-caption mt-2">
            A real receipt from one run on the GB grid, 2026-09-30.
          </figcaption>
        </figure>
      </div>

      <div className="mt-12 grid grid-cols-2 gap-x-6 gap-y-8 border-t border-rule pt-10 lg:grid-cols-4">
        <Stat
          value="6.7–12 %"
          label={
            <>
              of US grid load used by data centers by 2028 (
              <a href={DOE_URL} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                DOE 2024
              </a>
              )
            </>
          }
          tag="projected"
        />
        <Stat value="31" label="grid regions covered" tag="measured" />
        <Stat value="5" label="live carbon feeds" tag="measured" />
        <Stat value="72 h" label="forecast horizon" tag="measured" />
      </div>
      <p className="type-caption mt-8">
        Every number on this page has a source in{" "}
        <a href={CLAIMS_URL} target="_blank" rel="noreferrer" className="text-accent hover:underline">
          docs/claims.md
        </a>
        .
      </p>
    </Section>
  );
}

async function VisitorCurve() {
  const data = await getVisitorForecast(await headers());
  return <IntensityCurve data={data} />;
}

function CurveSkeleton() {
  return <div className={`${CURVE_BOX} rounded-lg bg-bg motion-safe:animate-pulse`} aria-hidden="true" />;
}
