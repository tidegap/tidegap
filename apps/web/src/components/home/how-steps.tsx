import type { CSSProperties, ReactNode } from "react";
import Link from "next/link";
import { HowItWorksViz } from "@/components/how-it-works-viz";
import { Section } from "@/components/ui/section";

/** The steps are the chart's legend: 1 = arrives at the peak, 2 = rides down, 3 = dispatch and wins. */
const STEPS: Array<{ title: string; body: ReactNode }> = [
  {
    title: "Ask",
    body: (
      <>
        Tell your agent: <q className="text-fg">summarize this by tomorrow 6 pm</q>.
      </>
    ),
  },
  {
    title: "Wait",
    body: "Tidegap reads the grid forecast and picks the cleanest hour before the deadline.",
  },
  {
    title: "Run",
    body: "The task runs at that hour, through the cheaper Batch API when the deadline allows, and gets a signed receipt.",
  },
];

/** Each step reveals 8 % of the view range after the one before it (M5). */
function stagger(i: number): CSSProperties {
  return { "--reveal-from": `${i * 8}%`, "--reveal-to": `${40 + i * 8}%` } as CSSProperties;
}

export function HowSteps() {
  return (
    <Section
      id="how"
      eyebrow="How it works"
      title="Tasks that can wait, wait for clean power."
      lead="Tidegap holds an AI task that can wait and runs it at the cleanest grid hour before your deadline."
    >
      <div className="relative">
        {/* Connector (M6): horizontal through the badges at lg, vertical below. */}
        <span
          aria-hidden="true"
          className="reveal-line absolute left-[16.6%] right-[16.6%] top-5 hidden h-px bg-accent/40 lg:block"
        />
        <span
          aria-hidden="true"
          className="reveal-line absolute bottom-6 left-5 top-5 w-px bg-accent/40 lg:hidden"
        />
        <ol className="relative grid gap-6 lg:grid-cols-3 lg:gap-8">
          {STEPS.map((step, i) => (
            <li
              key={step.title}
              className="reveal flex gap-4 lg:flex-col lg:items-center lg:text-center"
              style={stagger(i)}
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-accent/50 bg-bg font-mono text-sm font-semibold text-accent">
                {i + 1}
              </span>
              <div>
                <h3 className="text-lg font-semibold text-fg">{step.title}</h3>
                <p className="mt-1 text-[15px] leading-relaxed text-fg-muted">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
      <div className="mt-8">
        <HowItWorksViz summary={null} />
      </div>
      <p className="mt-6 text-sm">
        <Link href="/about" className="text-accent hover:underline">
          More about the project →
        </Link>
      </p>
    </Section>
  );
}
