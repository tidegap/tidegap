import { Stat } from "@/components/ui/card";
import { Section } from "@/components/ui/section";
import { HOST_COUNT } from "@/lib/hosts";

const CLAIMS_URL = "https://github.com/tidegap/tidegap/blob/main/docs/claims.md";

// Public listings only (R31): no testimonials, stars or download counts.
const LISTINGS: Array<[name: string, href: string]> = [
  ["GitHub", "https://github.com/tidegap/tidegap"],
  ["npm", "https://www.npmjs.com/package/@tidegap/mcp"],
  ["PyPI", "https://pypi.org/project/tidegap/"],
  ["MCP Registry", "https://registry.modelcontextprotocol.io/v0/servers?search=io.github.tidegap/tidegap"],
  ["ClawHub", "https://clawhub.ai/plugins/@vitalini/tidegap"],
];

export function Proof() {
  return (
    <Section id="proof" eyebrow="Proof" title="Open source, tested, documented.">
      <div className="grid grid-cols-2 gap-x-6 gap-y-8 lg:grid-cols-4">
        {/* docs/claims.md row 13 */}
        <Stat value="1,578" label="tests across 4 packages" tag="measured 2026-10-19" />
        {/* docs/claims.md row 6 */}
        <Stat value="31" label="grid regions covered" tag="measured" />
        {/* docs/claims.md row 10 */}
        <Stat value="5" label="live carbon feeds" tag="measured" />
        {/* docs/claims.md row 18; counted from lib/hosts.ts */}
        <Stat value={HOST_COUNT} label="agent hosts with an install path" tag="measured" />
      </div>
      <ul className="mt-10 flex flex-wrap gap-x-6 gap-y-2 border-t border-rule pt-8">
        {LISTINGS.map(([name, href]) => (
          <li key={name}>
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-10 items-center text-sm text-fg-muted transition-colors hover:text-accent"
            >
              {name} ↗
            </a>
          </li>
        ))}
      </ul>
      <p className="type-caption mt-6">
        Every number on this page has a source in{" "}
        <a href={CLAIMS_URL} target="_blank" rel="noreferrer" className="text-accent hover:underline">
          docs/claims.md
        </a>
        .
      </p>
    </Section>
  );
}
