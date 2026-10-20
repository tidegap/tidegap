import type { Metadata } from "next";
import { InstallBox } from "@/components/install-box";
import { DemoVideo } from "@/components/home/demo-video";
import { HowSteps } from "@/components/home/how-steps";
import { Proof } from "@/components/home/proof";
import { Screens } from "@/components/home/screens";
import { WhyItMatters } from "@/components/home/why-it-matters";
import { Chip } from "@/components/ui/card";
import { MARKDOWN_ALTERNATE, SITE_DESCRIPTION } from "@/lib/site-meta";
import { VERSION } from "@/lib/version";

export const metadata: Metadata = {
  title: { absolute: "Tidegap — carbon-aware scheduling for AI workflows" },
  description: SITE_DESCRIPTION,
  alternates: { canonical: "https://www.tidegap.com", types: MARKDOWN_ALTERNATE },
};

export default function HomePage() {
  return (
    <>
      <FirstScreen />
      <DemoVideo />
      <HowSteps />
      <WhyItMatters />
      <Screens />
      <Proof />
    </>
  );
}

// Fills the viewport below the sticky nav (61px, 65px from sm) and main's 40px top padding.
function FirstScreen() {
  return (
    <section className="flex min-h-[calc(100svh-101px)] flex-col items-center gap-6 pt-[clamp(0.5rem,7svh,4.5rem)] pb-10 text-center sm:min-h-[calc(100svh-105px)]">
      <ul className="flex flex-wrap justify-center gap-2" aria-label="Project facts">
        <li>
          <Chip>Open source</Chip>
        </li>
        <li>
          <Chip>Apache-2.0</Chip>
        </li>
        <li>
          <Chip variant="accent">
            <span className="normal-case">v{VERSION}</span>
          </Chip>
        </li>
      </ul>
      <h1 className="max-w-3xl text-balance text-3xl font-extrabold leading-[1.1] tracking-tight text-fg sm:text-4xl lg:text-5xl">
        Run your agent&apos;s non-urgent LLM tasks at the{" "}
        <span className="tg-underline text-accent">cleanest grid hour</span>.
      </h1>
      <InstallBox />
      <p id="hero-helper" className="max-w-xl text-sm text-fg-muted">
        Paste it into Claude Code, Codex, Cursor or any MCP host. The agent
        reads the public{" "}
        <a href="/install.md" className="text-accent hover:underline">
          install.md
        </a>{" "}
        and installs the Apache-2.0 package (
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
    </section>
  );
}
