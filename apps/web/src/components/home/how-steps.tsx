import type { CSSProperties, ReactNode } from "react";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Section } from "@/components/ui/section";

const STEPS: Array<{ title: string; body: ReactNode; visual?: ReactNode }> = [
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
    body: "Tidegap reads the grid forecast and picks the cleanest hour before your deadline.",
    visual: <MiniCurve />,
  },
  {
    title: "Run",
    body: "The task runs then, through the cheaper Batch API when the deadline allows, and gets a signed receipt.",
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
      lead={
        <>
          Tidegap is an open-source MCP scheduler: it holds an AI task that can
          wait and runs it at the cleanest grid hour before your deadline.{" "}
          <Link href="/about" className="text-accent hover:underline">
            More about the project
          </Link>
          .
        </>
      }
    >
      <div className="relative">
        {/* Connector (M6): horizontal through the badges at lg, vertical below. */}
        <span
          aria-hidden="true"
          className="reveal-line absolute left-[16.6%] right-[16.6%] top-[41px] hidden h-px bg-accent/40 lg:block"
        />
        <span
          aria-hidden="true"
          className="reveal-line absolute bottom-10 left-[41px] top-10 w-px bg-accent/40 lg:hidden"
        />
        <ol className="relative grid gap-5 lg:grid-cols-3 lg:gap-8">
          {STEPS.map((step, i) => (
            <li key={step.title} className="reveal" style={stagger(i)}>
              <Card className="flex h-full gap-4 lg:flex-col lg:items-center lg:text-center">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-accent/50 bg-bg font-mono text-sm font-semibold text-accent">
                  {i + 1}
                </span>
                <div>
                  <h3 className="text-lg font-semibold text-fg">{step.title}</h3>
                  <p className="mt-1 text-[15px] leading-relaxed text-fg-muted">{step.body}</p>
                  {step.visual}
                </div>
              </Card>
            </li>
          ))}
        </ol>
      </div>
    </Section>
  );
}

/** Illustrative day curve with a dot on the chosen hour. No values: a shape, not data. */
function MiniCurve() {
  return (
    <svg
      viewBox="0 0 160 48"
      className="mt-4 h-12 w-40 lg:mx-auto"
      role="img"
      aria-label="Illustration: carbon intensity over a day, with the cleanest hour marked"
    >
      <path
        d="M2 14 C 22 6, 38 8, 54 20 S 86 44, 104 40 S 136 12, 158 10"
        fill="none"
        stroke="var(--color-fg-dim)"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <line x1="98" y1="4" x2="98" y2="46" stroke="var(--color-rule-hi)" strokeDasharray="2 3" />
      <circle cx="98" cy="40.6" r="4.5" fill="var(--color-band-very-clean)" />
    </svg>
  );
}
