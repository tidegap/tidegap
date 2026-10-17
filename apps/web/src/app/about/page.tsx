import type { Metadata } from "next";
import Link from "next/link";
import { VERSION } from "@/lib/version";

export const metadata: Metadata = {
  title: "About",
  description:
    "Tidegap is an open-source carbon-aware scheduler for agentic AI workflows. It defers non-urgent LLM calls to the cleanest electricity-grid window inside your deadline, with per-task carbon receipts and full audit log.",
  alternates: { canonical: "https://www.tidegap.com/about" },
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

export default function AboutPage() {
  return (
    <article className="mx-auto max-w-3xl space-y-10 text-fg">
      <header className="space-y-4">
        <p className="font-mono text-xs uppercase tracking-wider text-accent">about</p>
        <div className="inline-flex items-center gap-2 rounded-md border border-accent/40 bg-accent/5 px-3 py-1 font-mono text-xs uppercase tracking-wider text-accent">
          <span aria-hidden="true" className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
          v{VERSION} · operator preview
        </div>
        <h1 className="text-4xl font-extrabold leading-[1.05] tracking-tight sm:text-5xl">
          Smarter scheduling for AI workloads.
        </h1>
        <p className="text-lg leading-relaxed text-fg-muted">
          Tidegap is an open-source MCP scheduler. Give it any LLM task with a
          deadline, and it routes the dispatch to off-peak hours — when the
          electricity grid is less loaded, providers&apos; APIs are cheaper and
          faster, and per-task carbon is lower. A single shift with four
          parallel wins.
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="text-2xl font-bold tracking-tight">Why this exists</h2>
        <p className="leading-relaxed text-fg-muted">
          <strong className="text-fg">Grid load.</strong> US data centers are
          projected to consume 6.7–12 % of national electricity grid load by
          2028 (
          <a
            href="https://www.energy.gov/eere/buildings/articles/2024-united-states-data-center-energy-usage-report"
            target="_blank"
            rel="noreferrer"
            className="text-accent hover:underline"
          >
            DOE 2024
          </a>
          ), driven primarily by AI compute. Today, agent code dispatches
          synchronously by default — every &quot;summarize this overnight&quot;
          and &quot;analyze by Friday&quot; request piles onto peak hours.
          Tidegap automates the deferral: a huge fraction of agent work
          (nightly digests, evaluator sweeps, batch enrichment, long-horizon
          research) doesn&apos;t need to run right now and shouldn&apos;t.
        </p>
        <p className="leading-relaxed text-fg-muted">
          <strong className="text-fg">Cost.</strong> Anthropic and OpenAI
          Batch APIs are priced 50 % below their sync siblings (projected,
          provider list price) in exchange for a 24-hour SLA. Tidegap
          auto-routes through Batch when the deadline allows. The same
          prompt, half the bill.
        </p>
        <p className="leading-relaxed text-fg-muted">
          <strong className="text-fg">Latency.</strong> Provider servers
          have variable queueing latency depending on global request volume.
          Anthropic explicitly expanded off-peak capacity in 2026 — doubling
          usage limits before 8 a.m. ET, after 2 p.m. ET on weekdays, and
          all weekend — citing smoothed demand as the goal. The implication
          for sync calls: shorter queues at off-peak, faster observed
          first-token times.
        </p>
        <p className="leading-relaxed text-fg-muted">
          <strong className="text-fg">Carbon.</strong> Carbon-intensity in
          any given grid region swings substantially across a single day as
          solar / wind / hydro come on- and off-line (simulated, from the
          mock diurnal curve&apos;s per-region floor/amplitude model — see{" "}
          <a
            href="https://github.com/tidegap/tidegap/blob/main/docs/claims.md"
            target="_blank"
            rel="noreferrer"
            className="text-accent hover:underline"
          >
            docs/claims.md
          </a>
          ). Tidegap writes a per-task carbon receipt against the actual
          grid intensity at the moment of dispatch — auditable, region-aware,
          reproducible from the persistent SQLite ledger.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-2xl font-bold tracking-tight">How it works</h2>
        <ol className="ml-5 list-decimal space-y-2 leading-relaxed text-fg-muted">
          <li>
            Your agent (Claude Code, Claude Desktop, Cursor, Windsurf,
            Continue, Cline, Zed, Goose, OpenClaw, or any MCP host) calls
            one of Tidegap&apos;s ten MCP tools — for example,{" "}
            <code className="rounded bg-bg-elev px-1 font-mono text-sm">schedule_task</code>{" "}
            with a prompt, region, and deadline.
          </li>
          <li>
            Tidegap fetches the live carbon-intensity forecast for that
            region — UK National Grid ESO (key-less), U.S. EIA, ENTSO-E
            for Europe, or Electricity Maps as universal fallback.
          </li>
          <li>
            It scores every hour inside the deadline and picks the
            cleanest one — with a 15 % tolerance band plus randomized
            tie-break so the global fleet doesn&apos;t converge on a
            single UTC hour (the &quot;everyone at 03:00 UTC&quot;
            pathology).
          </li>
          <li>
            The task is persisted to a local SQLite queue at{" "}
            <code className="rounded bg-bg-elev px-1 font-mono text-sm">~/.tidegap/queue.db</code>
            . When the chosen hour arrives, the{" "}
            <code className="rounded bg-bg-elev px-1 font-mono text-sm">tidegap tick</code>{" "}
            daemon dispatches via the provider&apos;s Batch API
            (50 % discount on the bill, same answer) when the deadline
            allows.
          </li>
          <li>
            A carbon receipt is written: timestamp, region, exact intensity
            used for scoring, tokens in/out, dollar cost vs peak.
            Inspectable via{" "}
            <code className="rounded bg-bg-elev px-1 font-mono text-sm">tidegap stats</code>{" "}
            on the CLI. The Claude Code plugin, the OpenClaw plugin, the
            MCP server, and the CLI all read and write this same file —
            defer in one host, check in another.
          </li>
        </ol>
      </section>

      <section className="space-y-3">
        <h2 className="text-2xl font-bold tracking-tight">Who it&apos;s for</h2>
        <ul className="ml-5 list-disc space-y-2 leading-relaxed text-fg-muted">
          <li>
            <strong className="text-fg">Builders running deferrable AI</strong> —
            anyone whose agent has &quot;by tomorrow&quot;-class workloads (nightly
            digest jobs, batch evaluations, research sweeps, multi-step report
            generation).
          </li>
          <li>
            <strong className="text-fg">Compute infrastructure operators</strong>{" "}
            — anyone managing inference fleets where grid load and off-peak
            capacity shape provisioning decisions. Tidegap gives them per-task
            telemetry about when their tasks actually run.
          </li>
          <li>
            <strong className="text-fg">Cost-sensitive engineering teams</strong>{" "}
            — anyone spending non-trivial money on Anthropic / OpenAI calls.
            Automatic Batch-API routing pays for itself in days.
          </li>
          <li>
            <strong className="text-fg">Engineering teams with carbon
            commitments</strong> — companies with internal CO<sub>2</sub>e
            budgets or external ESG reporting that need defensible per-job
            numbers rather than spreadsheet estimates.
          </li>
          <li>
            <strong className="text-fg">Researchers</strong> — the deterministic
            mock grid feed makes simulations reproducible; the persistent SQLite
            ledger makes longitudinal study cheap.
          </li>
          <li>
            <strong className="text-fg">MCP host implementers</strong> — Tidegap
            is a reference implementation of load-aware scheduling extensions to
            the Model Context Protocol; the{" "}
            <a
              href="https://github.com/tidegap/tidegap/blob/main/docs/spec/proposal/UPSTREAM-PR.md"
              target="_blank"
              rel="noreferrer"
              className="text-accent hover:underline"
            >
              upstream PR draft
            </a>{" "}
            spells out the schema shape.
          </li>
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="text-2xl font-bold tracking-tight">What you can do right now</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Link
            href="/map"
            className="rounded-md border border-rule bg-bg-card p-4 transition-colors hover:border-accent/40 hover:bg-accent/5"
          >
            <p className="font-mono text-xs uppercase tracking-wider text-accent">
              live data
            </p>
            <p className="mt-1 font-semibold text-fg">Carbon-intensity map</p>
            <p className="mt-1 text-sm text-fg-muted">
              Real numbers for 31 grid regions, updated every few minutes.
            </p>
          </Link>
          <Link
            href="/plan"
            className="rounded-md border border-rule bg-bg-card p-4 transition-colors hover:border-accent/40 hover:bg-accent/5"
          >
            <p className="font-mono text-xs uppercase tracking-wider text-accent">
              try it without code
            </p>
            <p className="mt-1 font-semibold text-fg">Best-window finder</p>
            <p className="mt-1 text-sm text-fg-muted">
              Pick a region + deadline; see the optimal dispatch hour and the
              CO<sub>2</sub>e savings vs dispatching now.
            </p>
          </Link>
          <Link
            href="/docs"
            className="rounded-md border border-rule bg-bg-card p-4 transition-colors hover:border-accent/40 hover:bg-accent/5"
          >
            <p className="font-mono text-xs uppercase tracking-wider text-accent">
              install — 30 seconds
            </p>
            <p className="mt-1 font-semibold text-fg">Pick your host</p>
            <p className="mt-1 text-sm text-fg-muted">
              One-line install picker for 13 hosts: Claude Code, Cursor,
              Claude Desktop, Windsurf, Continue, Cline, Zed, Goose,
              OpenClaw, mcphost, Python lib, Node lib.
            </p>
          </Link>
          <a
            href="https://clawhub.ai/plugins/@vitalini/tidegap"
            target="_blank"
            rel="noreferrer"
            className="rounded-md border border-rule bg-bg-card p-4 transition-colors hover:border-accent/40 hover:bg-accent/5"
          >
            <p className="font-mono text-xs uppercase tracking-wider text-accent">
              openclaw
            </p>
            <p className="mt-1 font-semibold text-fg">@vitalini/tidegap on ClawHub</p>
            <p className="mt-1 text-sm text-fg-muted">
              Native OpenClaw plugin. Install with{" "}
              <code className="font-mono">openclaw plugins install
              clawhub:@vitalini/tidegap</code>.
            </p>
          </a>
          <a
            href="https://github.com/tidegap/tidegap"
            target="_blank"
            rel="noreferrer"
            className="rounded-md border border-rule bg-bg-card p-4 transition-colors hover:border-accent/40 hover:bg-accent/5"
          >
            <p className="font-mono text-xs uppercase tracking-wider text-accent">
              source
            </p>
            <p className="mt-1 font-semibold text-fg">GitHub repository</p>
            <p className="mt-1 text-sm text-fg-muted">
              Apache-2.0. TypeScript + Python ports. 1,423 tests. PRs welcome.
            </p>
          </a>
          <a
            href="https://mcp.so/server/ebb-ai"
            target="_blank"
            rel="noreferrer"
            className="rounded-md border border-rule bg-bg-card p-4 transition-colors hover:border-accent/40 hover:bg-accent/5"
          >
            <p className="font-mono text-xs uppercase tracking-wider text-accent">
              mcp directory
            </p>
            <p className="mt-1 font-semibold text-fg">mcp.so/server/ebb-ai</p>
            <p className="mt-1 text-sm text-fg-muted">
              Listing in the largest community MCP-server catalog.
            </p>
          </a>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-2xl font-bold tracking-tight">Status</h2>
        <p className="leading-relaxed text-fg-muted">
          v{VERSION} (operator preview). The scheduler is production-grade — the
          even-distribution simulation routes 10,000 synthetic tasks across 7
          monitored grid zones with a 10.6 % max-bucket concentration
          (simulated, test asserts &lt;20 %; see{" "}
          <a
            href="https://github.com/tidegap/tidegap/blob/main/docs/claims.md"
            target="_blank"
            rel="noreferrer"
            className="text-accent hover:underline"
          >
            docs/claims.md
          </a>
          ), the SQLite ledger
          survives process restart, and per-region routing is auto-wired. Live
          carbon feeds (UK National Grid ESO, US EIA, ENTSO-E, Electricity
          Maps) back every region on the map; a feed outage falls back to a
          clearly-labelled mock, never a silent one. As of v0.10, per-task
          carbon receipts use per-model Wh/token coefficients (Patterson 2021,
          Luccioni 2024, Hugging Face AI Energy Score) instead of a flat
          placeholder; as of v0.11, receipts are Ed25519-signed and verifiable
          offline with{" "}
          <code className="rounded bg-bg-elev px-1 font-mono text-sm">tidegap verify</code>.
        </p>
        <p className="leading-relaxed text-fg-muted">
          The public surface is still pre-1.0: API shapes can change in minor
          versions. Still on the roadmap: upstream MCP spec PR, opt-in aggregate
          leaderboard, cross-provider routing. v1.0 will freeze the API surface.
          (WattTime marginal-emissions forecasts shipped as the fifth grid
          feed.)
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-2xl font-bold tracking-tight">Maintainer</h2>
        <p className="leading-relaxed text-fg-muted">
          Built by{" "}
          <a
            href="https://github.com/Vitalini"
            target="_blank"
            rel="noreferrer"
            className="text-accent hover:underline"
          >
            Vitalii Borovyk
          </a>{" "}
          (independent, open-source). Issues, PRs, and feature requests:{" "}
          <a
            href="https://github.com/tidegap/tidegap/issues"
            target="_blank"
            rel="noreferrer"
            className="text-accent hover:underline"
          >
            github.com/tidegap/tidegap/issues
          </a>
          .
        </p>
      </section>
    </article>
  );
}
