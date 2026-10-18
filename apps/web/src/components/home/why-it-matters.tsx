import { Suspense } from "react";
import { headers } from "next/headers";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Section } from "@/components/ui/section";
import { getVisitorForecast } from "@/lib/visitor-forecast";
import { IntensityCurve } from "./intensity-curve";
import { ReceiptCard } from "./receipt-card";

// The streamed curve and its skeleton share this box, sized from the card
// width (container query), so the stream-in shifts nothing (R40): top label
// room + the 600x220 plot + the tick row + up to four caption lines.
const CURVE_BOX = "min-h-[calc(32px+(100cqw-36px)*0.3667+40px+5rem)]";

export function WhyItMatters() {
  return (
    <Section
      id="grid"
      eyebrow="Why it matters"
      title="Your grid, right now."
      lead="Carbon per kilowatt-hour rises and falls through the day. This curve is live for your region."
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

      <ul className="mt-8 flex flex-wrap gap-x-6 gap-y-2">
        <li>
          <Link href="/map" className="inline-flex min-h-11 items-center text-sm text-accent hover:underline">
            All 31 regions on the live map →
          </Link>
        </li>
        <li>
          <Link href="/plan" className="inline-flex min-h-11 items-center text-sm text-accent hover:underline">
            Plan a task →
          </Link>
        </li>
      </ul>
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
