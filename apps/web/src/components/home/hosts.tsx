import { Chip } from "@/components/ui/card";
import { Section } from "@/components/ui/section";
import { HOSTS } from "@/lib/hosts";
import { Apps } from "./apps";

/** Chip names, in display order. A chip shows only when lib/hosts.ts has the id (R11). */
const CHIPS: Array<[id: string, name: string]> = [
  ["claude-code", "Claude Code"],
  ["codex", "Codex"],
  ["cursor", "Cursor"],
  ["claude-desktop", "Claude Desktop"],
  ["openclaw", "OpenClaw"],
  ["windsurf", "Windsurf"],
  ["zed", "Zed"],
  ["goose", "Goose"],
  ["cline", "Cline"],
  ["continue", "Continue"],
];

const KNOWN = new Set(HOSTS.map((h) => h.id));

export function HostsSection() {
  return (
    <Section
      id="hosts"
      eyebrow="Works with your agent"
      title="Works with the agent you already use."
      lead="Tidegap is an MCP server, so any agent that speaks MCP can hand it a task."
    >
      <ul className="flex flex-wrap items-center gap-2.5" aria-label="Supported agent hosts">
        {CHIPS.filter(([id]) => KNOWN.has(id)).map(([id, name]) => (
          <li key={id} data-host={id}>
            <Chip>{name}</Chip>
          </li>
        ))}
        <li>
          <a href="#install" className="inline-flex min-h-10 items-center rounded-full">
            <Chip variant="accent">Any MCP host →</Chip>
          </a>
        </li>
      </ul>
      <Apps />
    </Section>
  );
}
