import type { Metadata } from "next";
import { headers } from "next/headers";
import { Nav } from "@/components/nav";
import { VERSION } from "@/lib/version";
import { MARKDOWN_ALTERNATE, SITE_DESCRIPTION } from "@/lib/site-meta";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Tidegap — carbon-aware scheduling for AI workflows",
    template: "%s · Tidegap",
  },
  description: SITE_DESCRIPTION,
  metadataBase: new URL("https://www.tidegap.com"),
  alternates: {
    canonical: "https://www.tidegap.com",
    types: MARKDOWN_ALTERNATE,
  },
  keywords: [
    "carbon-aware scheduling",
    "carbon-aware AI",
    "MCP server",
    "Model Context Protocol",
    "Claude Code plugin",
    "LLM batch API",
    "Anthropic Batch",
    "OpenAI Batch",
    "grid carbon intensity",
    "green AI",
    "sustainable AI",
    "carbon-aware computing",
    "tidegap",
  ],
  authors: [{ name: "Vitalii Borovyk", url: "https://github.com/Vitalini" }],
  creator: "Vitalii Borovyk",
  publisher: "Tidegap",
  category: "developer tools",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "16x16 32x32 48x48" },
      { url: "/icon.svg", type: "image/svg+xml" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
  openGraph: {
    title: "Tidegap — carbon-aware scheduling for AI workflows",
    description: SITE_DESCRIPTION,
    url: "https://www.tidegap.com",
    siteName: "Tidegap",
    locale: "en_US",
    type: "website",
    images: [
      {
        url: "/og-image.png?v=logo",
        width: 1200,
        height: 630,
        alt: "Run non-urgent LLM tasks at the cleanest grid hour before your deadline.",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Tidegap — carbon-aware scheduling for AI workflows",
    description: SITE_DESCRIPTION,
    images: ["/og-image.png?v=logo"],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
  verification: {
    google: "NWwuXFBCyAQVChXdBSa3n5wwxm6xsZVrhON5YvaxpSM",
  },
};

const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "SoftwareApplication",
      "@id": "https://www.tidegap.com/#software",
      name: "Tidegap",
      alternateName: "ebb-ai",
      url: "https://www.tidegap.com",
      sameAs: [
        "https://github.com/tidegap/tidegap",
        "https://www.npmjs.com/package/@tidegap/mcp",
        "https://pypi.org/project/tidegap/",
        "https://registry.modelcontextprotocol.io/v0/servers?search=io.github.tidegap/tidegap",
        "https://clawhub.ai/plugins/@vitalini/tidegap",
      ],
      downloadUrl: "https://www.npmjs.com/package/@tidegap/mcp",
      installUrl: "https://www.tidegap.com/install.md",
      softwareHelp: { "@type": "CreativeWork", url: "https://www.tidegap.com/docs" },
      description:
        "Open-source carbon-aware scheduler for agentic AI workflows. Defers non-urgent LLM calls to the cleanest electricity-grid window inside a deadline via the Model Context Protocol.",
      applicationCategory: "DeveloperApplication",
      operatingSystem: "macOS, Linux, Windows",
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      license: "https://opensource.org/licenses/Apache-2.0",
      softwareVersion: VERSION,
      author: {
        "@type": "Person",
        name: "Vitalii Borovyk",
        url: "https://github.com/Vitalini",
      },
      codeRepository: "https://github.com/tidegap/tidegap",
      keywords:
        "carbon-aware scheduling, MCP, Model Context Protocol, Claude Code plugin, grid carbon intensity, sustainable AI",
    },
    {
      "@type": "WebSite",
      "@id": "https://www.tidegap.com/#website",
      url: "https://www.tidegap.com",
      name: "Tidegap",
      description:
        "Carbon-aware scheduling for agentic AI workflows. Live electricity-grid carbon-intensity map for major LLM-provider regions.",
      publisher: { "@id": "https://www.tidegap.com/#software" },
      inLanguage: "en-US",
    },
  ],
};

const REPO = "https://github.com/tidegap/tidegap";

const FOOTER_COLUMNS: Array<{ title: string; mono?: boolean; links: Array<{ label: string; href: string }> }> = [
  {
    title: "Product",
    links: [
      { label: "Map", href: "/map" },
      { label: "Plan", href: "/plan" },
      { label: "Docs", href: "/docs" },
      { label: "About", href: "/about" },
    ],
  },
  {
    title: "For agents",
    mono: true,
    links: [
      { label: "/install.md", href: "/install.md" },
      { label: "/llms.txt", href: "/llms.txt" },
      { label: "/llms-full.txt", href: "/llms-full.txt" },
    ],
  },
  {
    title: "Project",
    links: [
      { label: "GitHub", href: REPO },
      { label: "Changelog", href: `${REPO}/blob/main/CHANGELOG.md` },
      { label: "Claims", href: `${REPO}/blob/main/docs/claims.md` },
      { label: "License", href: `${REPO}/blob/main/LICENSE` },
    ],
  },
];

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // The proxy-generated per-request nonce. The JSON-LD tag must carry it,
  // otherwise 'strict-dynamic' blocks this inline script. Reading `headers()`
  // is also what opts pages into dynamic rendering (see proxy.ts).
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="en">
      <head>
        <script
          type="application/ld+json"
          nonce={nonce}
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      </head>
      <body className="min-h-screen">
        <Nav />
        <main className="relative z-10 mx-auto max-w-6xl px-6 py-10">{children}</main>
        <footer className="relative z-10 mt-16 border-t border-rule">
          <div className="mx-auto max-w-6xl px-6 py-10 text-sm">
            <nav aria-label="Footer" className="grid gap-8 sm:grid-cols-3">
              {FOOTER_COLUMNS.map((col) => (
                <div key={col.title}>
                  <p className="type-eyebrow">{col.title}</p>
                  <ul className="mt-3 space-y-2">
                    {col.links.map((l) => (
                      <li key={l.href}>
                        <a
                          href={l.href}
                          className={`text-fg-muted hover:text-accent hover:underline ${col.mono ? "font-mono" : ""}`}
                          {...(l.href.startsWith("http") ? { target: "_blank", rel: "noreferrer" } : {})}
                        >
                          {l.label}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </nav>
            <div className="mt-10 flex flex-col gap-2 border-t border-rule pt-6 text-xs text-fg-muted sm:flex-row sm:items-center sm:justify-between">
              <p>
                Apache-2.0 · grid data via{" "}
                <a
                  href="https://www.electricitymaps.com/"
                  className="text-accent hover:underline"
                  target="_blank"
                  rel="noreferrer"
                >
                  Electricity Maps
                </a>{" "}
                (mock fallback when no key is configured)
              </p>
              <p className="font-mono text-fg-dim">
                For agents: read{" "}
                <a href="/install.md" className="text-accent hover:underline">
                  /install.md
                </a>
                .
              </p>
              <p className="font-mono text-fg-dim">
                v{VERSION} · operator preview · UTC-aligned
              </p>
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
