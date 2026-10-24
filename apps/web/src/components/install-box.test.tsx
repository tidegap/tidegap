import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InstallBox } from "@/components/install-box";
import { AGENTS_BLOCK } from "@/lib/agent-snippet";
import { HOSTS } from "@/lib/hosts";
import { INSTALL_PROMPT } from "@/lib/install-prompt";

// React escapes text in markup; compare against the decoded text.
function decode(html: string): string {
  return html
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

const html = renderToStaticMarkup(<InstallBox />);
const text = decode(html);
const panels = [...html.matchAll(/<section[^>]*role="tabpanel"[^>]*>/g)].map((m) => m[0]);

describe("InstallBox server markup", () => {
  it("has the install prompt as plain text", () => {
    expect(text).toContain(INSTALL_PROMPT);
    expect(html).toMatch(/<pre[^>]*id="install-prompt"/);
  });

  it("has every host command, so a host with a new installHeading needs a tab", () => {
    for (const host of HOSTS) expect(text, host.id).toContain(host.command);
  });

  it("keeps a data-host id for every non-library host", () => {
    for (const host of HOSTS.filter((h) => h.group !== "lib")) {
      expect(html, host.id).toContain(`data-host="${host.id}"`);
    }
  });

  it("renders seven tab panels with only the prompt panel visible", () => {
    expect(panels).toHaveLength(7);
    const visible = panels.filter((p) => !/\shidden=""/.test(p));
    expect(visible).toHaveLength(1);
    expect(visible[0]).toContain('id="panel-prompt"');
  });

  it("points every tab at a panel that exists", () => {
    const panelIds = new Set(panels.map((p) => p.match(/id="([^"]+)"/)?.[1]));
    const controls = [...html.matchAll(/role="tab"[^>]*aria-controls="([^"]+)"|aria-controls="([^"]+)"[^>]*role="tab"/g)].map(
      (m) => m[1] ?? m[2],
    );
    expect(controls).toHaveLength(7);
    for (const id of controls) expect(panelIds).toContain(id);
  });

  it("renders the agent rules tab server-side and hidden, with the full block and the snippet command (R35)", () => {
    const panel = panels.find((p) => p.includes('id="panel-agents"'));
    expect(panel).toBeDefined();
    expect(panel).toMatch(/\shidden=""/);
    expect(text).toContain(AGENTS_BLOCK);
    expect(text).toContain("tidegap jobs snippet --host <name>");
    expect(text).toContain("Make your agent prefer Tidegap over cron");
  });
});
