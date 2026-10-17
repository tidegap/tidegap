import type { Metadata } from "next";
import { headers } from "next/headers";
import { DocsEmbed } from "@/components/docs/docs-embeds";
import { DocsNav } from "@/components/docs/docs-nav";
import { DocsProse } from "@/components/docs/docs-prose";
import { DOCS_FAQ, DOCS_SECTIONS } from "@/lib/docs.generated";
import { MARKDOWN_ALTERNATE } from "@/lib/site-meta";

export const metadata: Metadata = {
  title: "Docs · install, hosts, CLI, MCP tools",
  description:
    "Install Tidegap in any MCP host, then use the CLI, the MCP tools, the local UI and the signed carbon receipts. One page, one section per topic.",
  alternates: {
    canonical: "https://www.tidegap.com/docs",
    types: {
      "text/markdown": [{ url: MARKDOWN_ALTERNATE["text/markdown"] }, { url: "/llms-full.txt" }],
    },
  },
};

const NAV_ITEMS = DOCS_SECTIONS.map(({ id, label }) => ({ id, label }));

const FAQ_JSON_LD = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: DOCS_FAQ.map((pair) => ({
    "@type": "Question",
    name: pair.question,
    acceptedAnswer: { "@type": "Answer", text: pair.answer },
  })),
};

export default async function DocsPage() {
  // The JSON-LD tag needs the proxy's per-request nonce, as in layout.tsx.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <div className="lg:grid lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-12">
      <script
        type="application/ld+json"
        nonce={nonce}
        dangerouslySetInnerHTML={{ __html: JSON.stringify(FAQ_JSON_LD).replace(/</g, "\\u003c") }}
      />
      <DocsNav items={NAV_ITEMS} />

      <article className="min-w-0 max-w-3xl text-fg">
        <header className="pb-4 pt-6 lg:pt-0">
          <p className="type-eyebrow">docs</p>
          <h1 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">Tidegap docs</h1>
          <p className="mt-3 text-fg-muted">
            Install it, connect your host, and read what every command, tool and receipt does.
          </p>
        </header>

        {DOCS_SECTIONS.map((section) => (
          <section
            key={section.id}
            id={section.id}
            aria-labelledby={`${section.id}-title`}
            className="scroll-mt-[90px] border-t border-rule pt-10 pb-6 first-of-type:border-t-0 lg:scroll-mt-12"
          >
            <h2 id={`${section.id}-title`} className="text-2xl font-semibold tracking-tight">
              {section.label}
            </h2>
            {section.blocks.map((block, i) =>
              block.kind === "embed" ? (
                <DocsEmbed key={i} name={block.name} />
              ) : (
                <DocsProse key={i} html={block.html} />
              ),
            )}
          </section>
        ))}
      </article>
    </div>
  );
}
