import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { BarChart3, BookOpen, CalendarClock, Globe } from "lucide-react";
import { HowItWorksViz } from "@/components/how-it-works-viz";
import { GridGreeting, GridGreetingSkeleton } from "@/components/grid-greeting";
import { InstallPicker } from "@/components/install-picker";
import { AgentPrompt, HeroPrompt } from "@/components/agent-prompt";
import { MARKDOWN_ALTERNATE, SITE_DESCRIPTION } from "@/lib/site-meta";

export const metadata: Metadata = {
  title: { absolute: "Tidegap — carbon-aware scheduling for AI workflows" },
  description: SITE_DESCRIPTION,
  alternates: { canonical: "https://www.tidegap.com", types: MARKDOWN_ALTERNATE },
};

const TILES: Array<{
  href: string;
  Icon: LucideIcon;
  title: string;
  body: string;
  external?: boolean;
}> = [
  {
    href: "/map",
    Icon: Globe,
    title: "Live carbon map",
    body: "Grid regions across North America, Europe and Asia-Pacific, real-time data. Click any region for the 72-hour forecast.",
  },
  {
    href: "/plan",
    Icon: CalendarClock,
    title: "Plan a task",
    body: "Pick a region + deadline. See the cleanest hour and the carbon you'd save vs running now.",
  },
  {
    href: "/stats",
    Icon: BarChart3,
    title: "My impact",
    body: "Personal carbon-receipt summary from your local Tidegap queue. CLI-parity in the browser.",
  },
  {
    href: "/docs",
    Icon: BookOpen,
    title: "Docs & commands",
    body: "All 8 /tidegap:* slash commands, 10 MCP tools, install matrix for every host. Architecture deep-dive.",
  },
];

export default function HomePage() {
  return (
    <div className="space-y-14">
      <FirstScreen />
      <HowItWorksViz />
      <InstallBlock />
      {/* Apps and extensions slot: the browser-extension and Mac-app PRs add their section here. */}
      <LiveDataBlock />
    </div>
  );
}

// Fills the viewport below the sticky nav (61px, 65px from sm) and main's 40px top padding.
function FirstScreen() {
  return (
    <section className="flex min-h-[calc(100svh-101px)] flex-col items-center justify-center gap-6 text-center sm:min-h-[calc(100svh-105px)]">
      <h1 className="max-w-3xl text-balance text-3xl font-extrabold leading-[1.1] tracking-tight text-fg sm:text-4xl lg:text-5xl">
        Run your agent&apos;s non-urgent LLM tasks at the{" "}
        <span className="tg-underline text-accent">cleanest grid hour</span>.
      </h1>
      <HeroPrompt />
      <p id="hero-helper" className="max-w-xl text-sm text-fg-muted">
        Paste it into Claude Code, Codex, Cursor or any MCP host. Your agent
        reads the public{" "}
        <a href="/install.md" className="text-accent hover:underline">
          install.md
        </a>{" "}
        and installs the open-source (Apache-2.0) Tidegap package (
        <a
          href="https://github.com/tidegap/tidegap"
          target="_blank"
          rel="noreferrer"
          className="text-accent hover:underline"
        >
          source on GitHub
        </a>
        ).
      </p>
      <a href="#install" className="font-mono text-xs text-fg-dim transition-colors hover:text-accent">
        Other ways to install<span aria-hidden="true"> ↓</span>
      </a>
    </section>
  );
}

function InstallBlock() {
  return (
    <section
      id="install"
      className="scroll-mt-20 rounded-xl border border-accent/30 bg-accent/[0.03] p-5 sm:p-7"
    >
      <header className="space-y-1">
        <p className="font-mono text-[11px] uppercase tracking-wider text-accent">
          install — 30 seconds
        </p>
        <h2 className="text-2xl font-semibold tracking-tight text-fg">
          One line. Any host.
        </h2>
        <p className="mt-1 text-sm text-fg-muted">
          Paste the prompt below into your agent. It detects the host
          (Claude Code, Codex, Cursor, Claude Desktop, Windsurf, Continue, Cline,
          Zed, Goose, OpenClaw, or any generic MCP host) and runs the right
          install path for you.
        </p>
      </header>

      <div className="mt-5">
        <AgentPrompt />
      </div>

      <div
        role="separator"
        aria-label="or install manually"
        className="mt-7 mb-6 flex items-center gap-3"
      >
        <span className="h-px flex-1 bg-rule" aria-hidden="true" />
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-fg-dim">
          or
        </span>
        <span className="h-px flex-1 bg-rule" aria-hidden="true" />
      </div>

      <div>
        <p className="font-mono text-[11px] uppercase tracking-wider text-accent">
          install it yourself
        </p>
        <p className="mt-1 text-sm text-fg-muted">
          Pick your host below and copy the command. Default is the universal
          MCP install; switch the dropdown for host-specific configs or to use
          the library directly.
        </p>
        <div className="mt-4">
          <InstallPicker />
        </div>
      </div>

      <p className="mt-6 text-sm text-fg-muted">
        Once installed, your assistant can call{" "}
        <code className="rounded bg-bg-elev px-1 font-mono text-xs">
          /tidegap:defer &quot;summarize this&quot; --by tomorrow 6pm
        </code>{" "}
        and the task lands at the cleanest grid hour inside the deadline.{" "}
        <Link href="/docs" className="text-accent hover:underline">
          See all commands →
        </Link>
      </p>
    </section>
  );
}

function LiveDataBlock() {
  return (
    <section className="space-y-4">
      <header className="space-y-1">
        <p className="font-mono text-[11px] uppercase tracking-wider text-accent">
          dashboard
        </p>
        <h2 className="text-2xl font-semibold tracking-tight text-fg">
          Live data + tools.
        </h2>
      </header>
      <Suspense fallback={<GridGreetingSkeleton />}>
        <GridGreeting />
      </Suspense>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {TILES.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            className="group rounded-xl border border-rule bg-bg-card p-5 transition-all hover:border-accent/40 hover:bg-accent/5"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <span
                  aria-hidden="true"
                  className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-accent/30 bg-accent/10 text-accent transition-colors group-hover:bg-accent/15"
                >
                  <t.Icon className="h-5 w-5" strokeWidth={1.75} />
                </span>
                <h3 className="mt-3 text-lg font-semibold tracking-tight text-fg">
                  {t.title}
                </h3>
                <p className="mt-1 text-sm leading-relaxed text-fg-muted">
                  {t.body}
                </p>
              </div>
              <span
                aria-hidden="true"
                className="mt-1 text-fg-muted transition-transform group-hover:translate-x-1 group-hover:text-accent"
              >
                →
              </span>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
