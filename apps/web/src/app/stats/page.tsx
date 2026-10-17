/**
 * /stats — personal carbon-impact preview.
 *
 * No synthetic data. The site doesn't have access to your local
 * SQLite ledger (~/.tidegap/queue.db); this page explains where your
 * numbers live, how to read them, and what the schema looks like.
 *
 * A later release will optionally surface aggregate community totals
 * here (opt-in telemetry; design at docs/spec/proposal/v09-leaderboard.md).
 * Today it's local-first and that's the whole point.
 */

import type { Metadata } from "next";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { BatteryCharging, CalendarCheck, Globe, MapPinned, Sprout, Target, Zap } from "lucide-react";

export const metadata: Metadata = {
  title: "Your impact",
  description:
    "Per-task carbon receipts live in ~/.tidegap/queue.db. Inspect them with `tidegap stats` from the CLI. No telemetry, no cloud copy — your numbers are yours.",
  alternates: { canonical: "https://www.tidegap.com/stats" },
};

type Achievement = { id: string; label: string; Icon: LucideIcon; description: string };

const ACHIEVEMENTS: Achievement[] = [
  { id: "first-deferral",     label: "First Deferral", Icon: Sprout,          description: "Queue your first Tidegap task." },
  { id: "ten-deferrals",      label: "Ten Up",         Icon: Zap,             description: "Ship 10 deferred tasks." },
  { id: "hundred-deferrals",  label: "Centurion",      Icon: BatteryCharging, description: "Ship 100 deferred tasks." },
  { id: "thousand-deferrals", label: "Long Run",       Icon: Globe,           description: "Ship 1 000 deferred tasks." },
  { id: "multi-region",       label: "World Tour",     Icon: MapPinned,       description: "Dispatch across three or more grid regions." },
  { id: "scored-streak",      label: "Sniper",         Icon: Target,          description: "Honour the scored window for 90% of completed tasks." },
  { id: "endurance",          label: "Endurance",      Icon: CalendarCheck,   description: "Active across 7+ calendar days." },
];

export default function StatsPage() {
  return (
    <article className="mx-auto max-w-3xl space-y-12 text-fg">
      <header className="space-y-3">
        <p className="font-mono text-xs uppercase tracking-wider text-accent">your impact</p>
        <h1 className="text-4xl font-extrabold leading-[1.05] tracking-tight sm:text-5xl">
          Local first. Your numbers are yours.
        </h1>
        <p className="max-w-2xl text-base leading-relaxed text-fg-muted">
          Tidegap writes a per-task carbon receipt to a SQLite ledger on
          your own machine. Nothing leaves your device. This page
          explains how to read those numbers.
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="text-2xl font-bold tracking-tight">Where your data lives</h2>
        <p className="leading-relaxed text-fg-muted">
          Every dispatched task writes one row to{" "}
          <code className="rounded bg-bg-elev px-1 font-mono text-sm">~/.tidegap/queue.db</code>
          {" "}— a local SQLite file. Schema:{" "}
          <code className="rounded bg-bg-elev px-1 font-mono text-sm">task_id</code>,{" "}
          <code className="rounded bg-bg-elev px-1 font-mono text-sm">dispatched_at</code>,{" "}
          <code className="rounded bg-bg-elev px-1 font-mono text-sm">region</code>,{" "}
          <code className="rounded bg-bg-elev px-1 font-mono text-sm">intensity_g_co2_per_kwh</code>,{" "}
          <code className="rounded bg-bg-elev px-1 font-mono text-sm">estimated_carbon_g</code>,{" "}
          <code className="rounded bg-bg-elev px-1 font-mono text-sm">actual_carbon_g</code>,{" "}
          <code className="rounded bg-bg-elev px-1 font-mono text-sm">intensity_source</code>{" "}
          (one of <code className="font-mono">scored</code> /{" "}
          <code className="font-mono">current</code> /{" "}
          <code className="font-mono">expedited</code>).
        </p>
        <p className="leading-relaxed text-fg-muted">
          The Claude Code plugin, the OpenClaw plugin, the MCP server,
          and the CLI all read and write this same file — defer in one
          host, check in another.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-2xl font-bold tracking-tight">Read it from the CLI</h2>
        <CodeBlock>
{`# Install once
npm install -g @tidegap/cli

# Personal-impact summary (counts, totals, per-region, achievements)
tidegap stats

# Programmatic
tidegap stats --json | jq '.stats.totalEstimatedCarbonGCo2'

# Per-task receipts (completed tasks)
tidegap receipts list
tidegap receipts list --since 2026-05-01

# Verify a receipt's Ed25519 signature
tidegap verify <task_id>`}
        </CodeBlock>
      </section>

      <section className="space-y-3">
        <h2 className="text-2xl font-bold tracking-tight">What the summary covers</h2>
        <ul className="ml-5 list-disc space-y-2 leading-relaxed text-fg-muted">
          <li>
            <strong className="text-fg">Cumulative impact:</strong>{" "}
            total tasks dispatched, accounted CO<sub>2</sub>e in grams,
            cleanest-window hit rate (scored vs. expedited), and
            run-now overrides.
          </li>
          <li>
            <strong className="text-fg">By region:</strong> dispatch
            counts and totals broken down by grid zone (CISO, ERCO, GB,
            FR, DE, etc.).
          </li>
          <li>
            <strong className="text-fg">Band distribution:</strong>{" "}
            histogram of how dirty/clean the grid was at each dispatch
            (very_clean → very_dirty).
          </li>
          <li>
            <strong className="text-fg">Achievements:</strong>{" "}
            local-only milestones (no leaderboard, no upload). The full
            list is below.
          </li>
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="text-2xl font-bold tracking-tight">Achievements (local-only)</h2>
        <p className="leading-relaxed text-fg-muted">
          These unlock against your local ledger as you queue and ship
          tasks. There&apos;s no server tracking; checking them just
          walks your SQLite rows.
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {ACHIEVEMENTS.map((a) => (
            <div
              key={a.id}
              className="rounded-lg border border-rule bg-bg-card p-4"
            >
              <div className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-rule bg-bg-elev text-fg-muted"
                >
                  <a.Icon className="h-4 w-4" strokeWidth={1.75} />
                </span>
                <div className="text-base font-semibold text-fg">{a.label}</div>
              </div>
              <p className="mt-2 text-xs text-fg-muted">{a.description}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-2xl font-bold tracking-tight">Why not show aggregate numbers here?</h2>
        <p className="leading-relaxed text-fg-muted">
          Every public dashboard that summarizes user impact has to
          either (a) phone home with telemetry — which we explicitly
          decided against through v0.10 — or (b) fabricate aggregate
          numbers that look real but aren&apos;t. Both are bad.
          Local-first is honest.
        </p>
        <p className="leading-relaxed text-fg-muted">
          A later release will add an{" "}
          <em>opt-in</em>, signed-anonymous-event aggregate counter
          that the site can read (no per-user identifying data). Design
          is at{" "}
          <a
            href="https://github.com/tidegap/tidegap/blob/main/docs/spec/proposal/v09-leaderboard.md"
            target="_blank"
            rel="noreferrer"
            className="text-accent hover:underline"
          >
            docs/spec/proposal/v09-leaderboard.md
          </a>
          . Until then, your stats live on your machine and only there.
        </p>
      </section>

      <footer className="rounded-xl border border-rule bg-bg-elev p-5 text-sm text-fg-muted">
        <p className="mb-2 font-mono text-xs uppercase tracking-wider text-accent">
          related
        </p>
        <ul className="space-y-1">
          <li>
            <Link href="/docs" className="text-accent hover:underline">
              /docs
            </Link>{" "}
            — all 8 slash commands + 12 MCP tools + install matrix.
          </li>
          <li>
            <Link href="/plan" className="text-accent hover:underline">
              /plan
            </Link>{" "}
            — best-window finder (preview before deferring).
          </li>
          <li>
            <Link href="/map" className="text-accent hover:underline">
              /map
            </Link>{" "}
            — live carbon-intensity map (31 regions).
          </li>
        </ul>
      </footer>
    </article>
  );
}

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-md border border-rule bg-bg-elev p-4 font-mono text-[13px] leading-relaxed text-fg">
      <code>{children}</code>
    </pre>
  );
}
