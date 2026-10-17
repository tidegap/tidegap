import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { HowItWorksViz } from "@/components/how-it-works-viz";
import { Section } from "@/components/ui/section";
import { HOST_COUNT, HOSTS } from "@/lib/hosts";
import { MARKDOWN_ALTERNATE } from "@/lib/site-meta";
import { VERSION } from "@/lib/version";

export const metadata: Metadata = {
  title: "About",
  description:
    "Tidegap is an open-source carbon-aware scheduler for agentic AI workflows. It defers non-urgent LLM calls to the cleanest electricity-grid window inside your deadline, with per-task carbon receipts and full audit log.",
  alternates: { canonical: "https://www.tidegap.com/about", types: MARKDOWN_ALTERNATE },
  openGraph: {
    title: "About Tidegap",
    description:
      "Why a carbon-aware scheduler for LLM workflows exists, who it's for, and how it actually moves the needle.",
    url: "https://www.tidegap.com/about",
    type: "article",
    images: [
      {
        url: "/og-image.png?v=logo",
        width: 1200,
        height: 630,
        alt: "Run non-urgent LLM tasks at the cleanest grid hour before your deadline.",
      },
    ],
  },
};

const REPO = "https://github.com/tidegap/tidegap";
const CLAIMS = `${REPO}/blob/main/docs/claims.md`;
const CHANGELOG = `${REPO}/blob/main/CHANGELOG.md`;
const DOE =
  "https://www.energy.gov/eere/buildings/articles/2024-united-states-data-center-energy-usage-report";

type ClaimClass = "measured" | "simulated" | "projected";

/** Every number on the homepage and this page, with its docs/claims.md row. */
const NUMBERS: Array<{ value: string; cls: ClaimClass; meaning: string; row: string }> = [
  { value: "6.7–12 %", cls: "projected", meaning: "Share of US grid load used by data centers in 2028 (DOE 2024 forecast)", row: "24" },
  { value: "50 %", cls: "projected", meaning: "Batch API price cut against the sync price (Anthropic and OpenAI list prices)", row: "4" },
  { value: "31", cls: "measured", meaning: "Grid regions Tidegap knows, on the live map", row: "6" },
  { value: "5", cls: "measured", meaning: "Live carbon feeds (UK National Grid ESO, US EIA, ENTSO-E, WattTime, Electricity Maps)", row: "10" },
  { value: "72 h", cls: "measured", meaning: "How far ahead Tidegap looks for a clean hour", row: "11" },
  { value: "158 gCO₂/kWh", cls: "measured", meaning: "Grid intensity at dispatch in one real run on the GB grid, 2026-09-30", row: "31" },
  { value: "1,423", cls: "measured", meaning: "Automated tests, all passing (run on 2026-10-16)", row: "13" },
  { value: "10", cls: "measured", meaning: "MCP tools an agent gets (11 in the OpenClaw plugin)", row: "16" },
  { value: String(HOST_COUNT), cls: "measured", meaning: "Agent hosts with an install path (libraries not counted)", row: "18" },
  { value: "15 %", cls: "measured", meaning: "Tolerance band when Tidegap picks among near-equal clean hours", row: "23" },
  { value: "−84 %", cls: "simulated", meaning: "Drop in peak-hour pile-up in a 10,000-task simulation", row: "5" },
  { value: "10.6 %", cls: "simulated", meaning: "Largest share of those tasks in one hour (the test allows up to 20 %)", row: "9" },
];

const CLASS_STYLE: Record<ClaimClass, string> = {
  measured: "border-accent/40 text-accent",
  simulated: "border-amber-400/40 text-amber-200",
  projected: "border-sky-400/40 text-sky-200",
};

/** Host labels as a reader knows them, without the "(plugin)"-style notes. */
const HOST_NAMES = HOSTS.filter((h) => h.group !== "lib" && h.id !== "mcp").map((h) =>
  h.label.replace(/\s*\(.*\)$/, ""),
);

function Ext({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-accent hover:underline">
      {children}
    </a>
  );
}

function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-bg-elev px-1 font-mono text-sm">{children}</code>;
}

const P = "leading-relaxed text-fg-muted";

export default function AboutPage() {
  return (
    <article className="mx-auto max-w-3xl text-fg">
      <header className="space-y-4 pt-4">
        <div className="inline-flex items-center gap-2 rounded-md border border-accent/40 bg-accent/5 px-3 py-1 font-mono text-xs uppercase tracking-wider text-accent">
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-accent motion-safe:animate-pulse" />
          v{VERSION} · operator preview
        </div>
        <h1 className="text-4xl font-extrabold leading-[1.05] tracking-tight sm:text-5xl">
          Smarter scheduling for AI workloads.
        </h1>
      </header>

      <Section id="mission" eyebrow="Mission" title="AI work that can wait should wait for clean power.">
        <p className={P}>
          Many AI tasks do not need an answer this minute: a nightly summary, a
          report for Friday, a batch of documents to sort. Tidegap is a free,
          open-source tool that holds those tasks and runs each one at the hour
          before its deadline when the electricity grid is cleanest. You tell
          your AI agent &quot;do this by tomorrow&quot;; Tidegap picks the hour.
        </p>
      </Section>

      <Section id="why" eyebrow="Why this exists" title="One shift, four wins.">
        <div className="space-y-4">
          <p className={P}>
            <strong className="text-fg">Grid load.</strong> US data centers are
            projected to use 6.7–12 % of the national grid by 2028 (
            <Ext href={DOE}>DOE 2024</Ext>, projected), and AI is the main driver.
            Today an AI agent runs every request at once, so &quot;summarize this
            overnight&quot; still lands at the busiest hour. Tidegap moves that
            work to quieter hours.
          </p>
          <p className={P}>
            <strong className="text-fg">Cost.</strong> Anthropic and OpenAI sell
            a Batch API at 50 % below the normal price (projected, provider list
            price), with answers within 24 hours. When the deadline allows,
            Tidegap sends the task through it: the same prompt for half the bill.
          </p>
          <p className={P}>
            <strong className="text-fg">Latency.</strong> Provider servers queue
            requests. At quiet hours fewer people send requests, so a task that
            waits for those hours meets shorter queues.
          </p>
          <p className={P}>
            <strong className="text-fg">Carbon.</strong> The carbon cost of a
            unit of electricity rises and falls through the day as sun, wind and
            demand change (simulated, from the mock curve&apos;s per-region model;
            see <Ext href={CLAIMS}>docs/claims.md</Ext>). Tidegap writes a carbon
            receipt for each task, with the real grid value at the moment it
            ran.
          </p>
          <div className="pt-4">
            <HowItWorksViz />
          </div>
        </div>
      </Section>

      <Section id="how-in-depth" eyebrow="How it works" title="From “by tomorrow” to a signed receipt.">
        <ol className={`ml-5 list-decimal space-y-3 ${P}`}>
          <li>
            Your agent ({HOST_NAMES.join(", ")}, or any MCP host) calls one of
            Tidegap&apos;s ten MCP tools, for example <Code>schedule_task</Code>{" "}
            with a prompt, a region and a deadline.
          </li>
          <li>
            Tidegap reads the carbon forecast for that region: UK National Grid
            ESO (no key needed), US EIA, WattTime, ENTSO-E for Europe, or
            Electricity Maps as the fallback.
          </li>
          <li>
            It scores every hour before the deadline and picks a clean one. A
            15 % tolerance band and a random tie-break spread tasks out, so not
            every user lands on the same hour.
          </li>
          <li>
            The task waits in a local queue file, <Code>~/.tidegap/queue.db</Code>.
            When its hour comes, the <Code>tidegap tick</Code> daemon sends it,
            through the provider&apos;s Batch API when the deadline allows.
          </li>
          <li>
            A carbon receipt is written: time, region, the grid value used,
            tokens, and cost. Receipts are Ed25519-signed and can be checked
            offline with <Code>tidegap verify</Code>. Every Tidegap client (the
            Claude Code plugin, the OpenClaw plugin, the MCP server and the CLI)
            reads and writes the same file, so you can defer in one tool and
            check in another.
          </li>
        </ol>
      </Section>

      <Section id="who" eyebrow="Who it is for" title="Anyone with AI work that has a deadline, not a timer.">
        <ul className={`ml-5 list-disc space-y-3 ${P}`}>
          <li>
            <strong className="text-fg">Builders running deferrable AI</strong>:
            nightly digests, batch evaluations, research sweeps, long reports.
          </li>
          <li>
            <strong className="text-fg">Teams watching their AI bill</strong>:
            the Batch API route costs less for the same answer.
          </li>
          <li>
            <strong className="text-fg">Teams with carbon commitments</strong>:
            per-task receipts give numbers you can defend, not spreadsheet
            estimates.
          </li>
          <li>
            <strong className="text-fg">Inference operators</strong>: per-task
            records show when work actually ran.
          </li>
          <li>
            <strong className="text-fg">Researchers</strong>: the simulated grid
            feed is reproducible, and the local ledger keeps every run.
          </li>
          <li>
            <strong className="text-fg">MCP host builders</strong>: the{" "}
            <Ext href={`${REPO}/blob/main/docs/spec/proposal/UPSTREAM-PR.md`}>upstream proposal</Ext>{" "}
            describes load-aware scheduling for the Model Context Protocol.
          </li>
        </ul>
        <div className="mt-8 grid gap-3 sm:grid-cols-2">
          <Link href="/map" className="rounded-md border border-rule bg-bg-card p-4 transition-colors hover:border-accent/40 hover:bg-accent/5">
            <p className="font-semibold text-fg">Carbon-intensity map</p>
            <p className="mt-1 text-sm text-fg-muted">Live values for 31 grid regions.</p>
          </Link>
          <Link href="/plan" className="rounded-md border border-rule bg-bg-card p-4 transition-colors hover:border-accent/40 hover:bg-accent/5">
            <p className="font-semibold text-fg">Best-window finder</p>
            <p className="mt-1 text-sm text-fg-muted">Pick a region and a deadline, see the clean hour. No code.</p>
          </Link>
          <Link href="/docs" className="rounded-md border border-rule bg-bg-card p-4 transition-colors hover:border-accent/40 hover:bg-accent/5">
            <p className="font-semibold text-fg">Install</p>
            <p className="mt-1 text-sm text-fg-muted">
              Install paths for {HOST_COUNT} hosts, plus Python and Node libraries.
            </p>
          </Link>
          <a href={REPO} target="_blank" rel="noreferrer" className="rounded-md border border-rule bg-bg-card p-4 transition-colors hover:border-accent/40 hover:bg-accent/5">
            <p className="font-semibold text-fg">Source on GitHub</p>
            <p className="mt-1 text-sm text-fg-muted">Apache-2.0. TypeScript and Python. Pull requests welcome.</p>
          </a>
        </div>
      </Section>

      <Section
        id="numbers"
        eyebrow="The numbers we stand behind"
        title="Every number, with its source."
        lead={
          <>
            Each number on this site is measured, simulated or projected. The
            row number points to its entry in <Ext href={CLAIMS}>docs/claims.md</Ext>.
          </>
        }
      >
        <div className="overflow-x-auto rounded-lg border border-rule">
          <table className="w-full min-w-[34rem] text-left text-sm">
            <thead className="bg-bg-elev font-mono text-xs uppercase tracking-wider text-fg-dim">
              <tr>
                <th scope="col" className="px-4 py-3">Number</th>
                <th scope="col" className="px-4 py-3">Class</th>
                <th scope="col" className="px-4 py-3">What it means</th>
                <th scope="col" className="px-4 py-3">Row</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {NUMBERS.map((n) => (
                <tr key={n.row}>
                  <td className="whitespace-nowrap px-4 py-3 font-mono text-fg">{n.value}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded border px-1.5 py-0.5 font-mono text-[11px] ${CLASS_STYLE[n.cls]}`}>
                      {n.cls}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-fg-muted">{n.meaning}</td>
                  <td className="px-4 py-3 font-mono">
                    <Ext href={CLAIMS}>#{n.row}</Ext>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-4 text-sm text-fg-muted">
          No general carbon-saving percentage appears on this site: the saving
          depends on the region and the day.
        </p>
      </Section>

      <Section id="status" eyebrow="Status" title={`Version ${VERSION}, operator preview.`}>
        <div className="space-y-4">
          <p className={P}>
            The scheduler works end to end. In a simulation, 10,000 synthetic tasks
            across 7 grid zones reach a 10.6 % largest-hour share (simulated; the
            test allows up to 20 %). The queue survives a restart. Live carbon
            feeds back every region on the map, and a feed outage falls back to
            a clearly labelled mock, never a silent one. Receipts use per-model
            energy figures and are signed.
          </p>
          <p className={P}>
            The public interface is still before 1.0, so it can change in a minor
            version. Planned next: the upstream MCP spec proposal, an opt-in
            aggregate leaderboard and cross-provider routing. Release notes are
            in the <Ext href={CHANGELOG}>CHANGELOG</Ext>.
          </p>
        </div>
      </Section>

      <Section id="name-history" eyebrow="Name history" title="Formerly Ebb AI.">
        <div className="space-y-4">
          <p className={P}>
            Tidegap was called Ebb AI up to version 0.17. On 2026-10-16 (version
            0.18.0) it was renamed, because &quot;Ebb&quot; conflicts with an
            existing software trademark. The packages, commands, plugin names
            and this site all moved to the Tidegap name.
          </p>
          <p className={P}>
            Version 0.18.0 kept the old names working. Version 0.19.0
            (2026-10-17) removed them: an old setting name now prints a notice
            with its new name and is not used. The old ClawHub plugin points to
            the new one. The <Ext href={`${CHANGELOG}#0190--2026-10-17`}>0.19.0 upgrade note</Ext>{" "}
            covers moving from 0.17.
          </p>
          <p className={P}>
            The mcp.so directory still lists the project under its former name:{" "}
            <Ext href="https://mcp.so/server/ebb-ai">mcp.so listing (former name)</Ext>.
          </p>
        </div>
      </Section>

      <Section id="maintainer" eyebrow="Maintainer" title="Built by Vitalii Borovyk.">
        <p className={P}>
          Built by <Ext href="https://github.com/Vitalini">Vitalii Borovyk</Ext>,
          independent and open source. Issues, pull requests and feature
          requests: <Ext href={`${REPO}/issues`}>github.com/tidegap/tidegap/issues</Ext>.
        </p>
      </Section>
    </article>
  );
}
