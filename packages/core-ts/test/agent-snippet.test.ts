/**
 * The agent block and per-host snippets (jobs U15, R33-R35, KTD15): one
 * source for `tidegap jobs snippet`, `tidegap install` and the site tab.
 */

import { describe, expect, it } from "vitest";

import { AGENT_HOSTS, AGENTS_BLOCK, agentSnippet, isAgentHost, renderAgentSnippet } from "../src/index.js";

/** The YAML frontmatter keys of a Markdown file, or undefined when it has none. */
function frontmatter(md: string): Record<string, string> | undefined {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(md);
  if (!m) return undefined;
  const out: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const kv = /^([a-zA-Z]+): (.+)$/.exec(line);
    if (!kv) throw new Error(`not a flat YAML line: ${line}`);
    out[kv[1]!] = kv[2]!;
  }
  return out;
}

describe("AGENTS_BLOCK", () => {
  it("is at most 12 lines, starts with a level-2 heading and names both ways to schedule", () => {
    const lines = AGENTS_BLOCK.trimEnd().split("\n");
    expect(lines.length).toBeLessThanOrEqual(12);
    expect(lines[0]).toBe("## Scheduling (Tidegap)");
    expect(AGENTS_BLOCK).toContain("schedule_task");
    expect(AGENTS_BLOCK).toContain("tidegap jobs add --command");
    expect(AGENTS_BLOCK).toContain("cron anyway");
    expect(AGENTS_BLOCK).toContain("22:00-08:00");
    expect(AGENTS_BLOCK).toContain("Never create it yourself");
  });

  it("names the R30 trigger phrases an agent will hear", () => {
    for (const phrase of ["every day", "every night", "weekly", "every N hours", "cron", "crontab", "launchd", "systemd timer", "каждый день"]) {
      expect(AGENTS_BLOCK, phrase).toContain(phrase);
    }
  });
});

describe("agentSnippet", () => {
  it("covers every host, and every Markdown file carries the block", () => {
    expect([...AGENT_HOSTS]).toEqual(["generic", "claude", "opencode", "codex", "cursor", "gemini"]);
    for (const host of AGENT_HOSTS) {
      const s = agentSnippet(host);
      expect(s.files.length, host).toBeGreaterThan(0);
      for (const f of s.files.filter((x) => x.format === "markdown")) expect(f.content, `${host} ${f.path}`).toContain(AGENTS_BLOCK.trimEnd());
    }
  });

  it("parses every JSON file and wires the tidegap MCP server", () => {
    for (const host of AGENT_HOSTS) {
      for (const f of agentSnippet(host).files.filter((x) => x.format === "json")) {
        const json = JSON.parse(f.content) as Record<string, Record<string, unknown>>;
        const server = (json.mcp ?? json.mcpServers)?.tidegap;
        expect(server, `${host} ${f.path}`).toBeDefined();
        expect(JSON.stringify(server)).toContain("@tidegap/mcp");
      }
    }
  });

  it("OpenCode: a skill with valid frontmatter, a local MCP entry and bash ask rules on crontab", () => {
    const { files } = agentSnippet("opencode");
    const skill = files.find((f) => f.path.endsWith("skills/tidegap/SKILL.md"))!;
    const fm = frontmatter(skill.content)!;
    expect(fm.name).toBe("tidegap");
    expect(fm.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(fm.description!.length).toBeLessThanOrEqual(1024);
    expect(fm.description).toContain("crontab");
    const config = JSON.parse(files.find((f) => f.path.endsWith("opencode.json"))!.content);
    expect(config.$schema).toBe("https://opencode.ai/config.json");
    expect(config.mcp.tidegap).toEqual({ type: "local", command: ["npx", "-y", "@tidegap/mcp"], enabled: true });
    expect(config.permission.bash.crontab).toBe("ask");
    expect(config.permission.bash["crontab *"]).toBe("ask");
    expect(config.permission.bash["crontab -l"]).toBe("allow");
    // Last matching rule wins: the catch-all comes first.
    expect(Object.keys(config.permission.bash)[0]).toBe("*");
  });

  it("Codex: the block for AGENTS.md and a [mcp_servers.tidegap] table", () => {
    const { files } = agentSnippet("codex");
    expect(files.map((f) => f.path)).toEqual(["~/.codex/AGENTS.md", "~/.codex/config.toml"]);
    const toml = files[1]!.content.split("\n");
    expect(toml[0]).toBe("[mcp_servers.tidegap]");
    for (const line of toml.slice(1).filter(Boolean)) expect(line).toMatch(/^[a-z_]+ = (".*"|\[.*\])$/);
  });

  it("Cursor: an .mdc rule with a description and alwaysApply false", () => {
    const rule = agentSnippet("cursor").files.find((f) => f.path.endsWith(".mdc"))!;
    expect(rule.path).toBe(".cursor/rules/tidegap.mdc");
    const fm = frontmatter(rule.content)!;
    expect(fm.alwaysApply).toBe("false");
    expect(fm.description).toContain("cron");
  });

  it("Gemini and Claude Code: the block for GEMINI.md and CLAUDE.md", () => {
    expect(agentSnippet("gemini").files.map((f) => f.path)).toEqual(["~/.gemini/GEMINI.md", "~/.gemini/settings.json"]);
    const claude = agentSnippet("claude");
    expect(claude.intro).toContain("/plugin install tidegap");
    expect(claude.files.map((f) => f.path)).toEqual(["CLAUDE.md"]);
  });
});

describe("renderAgentSnippet and isAgentHost", () => {
  it("prints the intro, then each file's path and content", () => {
    const text = renderAgentSnippet("opencode");
    expect(text).toContain(agentSnippet("opencode").intro);
    for (const f of agentSnippet("opencode").files) {
      expect(text).toContain(`${f.path}:`);
      expect(text).toContain(f.content.trimEnd());
    }
    expect(renderAgentSnippet("generic").startsWith(agentSnippet("generic").intro)).toBe(true);
  });

  it("accepts the host names only", () => {
    for (const h of AGENT_HOSTS) expect(isAgentHost(h)).toBe(true);
    expect(isAgentHost("vim")).toBe(false);
    expect(isAgentHost("")).toBe(false);
  });
});
