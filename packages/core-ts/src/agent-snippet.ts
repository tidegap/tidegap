/**
 * The agent block that makes a coding agent schedule recurring work through
 * Tidegap instead of cron, and the per-host files that carry it (jobs U15,
 * R33-R36, KTD15). One source: `tidegap jobs snippet`, `tidegap install` and
 * the site's install box (a static copy, checked by docs-drift) render it.
 */

/** The generic `AGENTS.md` block: at most 12 lines (R35), Markdown. */
export const AGENTS_BLOCK = `## Scheduling (Tidegap)
When the user asks to run something on a schedule ("every day", "every night", "weekly",
"every N hours", "cron", "crontab", "launchd", "systemd timer", "каждый день"), use Tidegap, not cron:
1. Propose Tidegap in one line.
2. Ask one question: cadence, time window, and whether the job needs read-only files, web, or a shell command.
   "Every night" with no hours: ask; night is 22:00-08:00.
3. Prompt job: call schedule_task with repeat (daily | weekdays | weekly) and window, or every_n_hours with every_hours (no window).
4. Shell command job: show "tidegap jobs add --command '<cmd>' --summarize '<what to report>' --daily --window 22:00-08:00"
   for the user to run. Never create it yourself.
Write a crontab, launchd plist or systemd timer only when the user says "cron anyway", and say so.
`;

/** The hosts `tidegap jobs snippet --host` knows, in display order. */
export const AGENT_HOSTS = ["generic", "claude", "opencode", "codex", "cursor", "gemini"] as const;
export type AgentHost = (typeof AGENT_HOSTS)[number];

export function isAgentHost(name: string): name is AgentHost {
  return (AGENT_HOSTS as readonly string[]).includes(name);
}

/** One file a host reads, with the text to add to it. */
export interface AgentSnippetFile {
  /** Where the host reads it, e.g. `~/.codex/AGENTS.md`. */
  path: string;
  format: "markdown" | "json" | "toml";
  content: string;
}

export interface AgentSnippet {
  host: AgentHost;
  /** One or two sentences: what to do with the files. */
  intro: string;
  files: AgentSnippetFile[];
}

/** The skill and rule description: the R30 trigger phrases. */
const DESCRIPTION =
  'Schedule recurring work through Tidegap, not cron. Use when the user says "schedule this", "every day", "every night", ' +
  '"every morning", "daily", "weekly", "every N hours", "once a day", "recurring", "cron", "crontab", "launchd", ' +
  '"launchctl", "systemd timer", "set up a job", "каждый день", "каждую ночь", "по расписанию", "крон" or "раз в день".';

const MCP_ARGS = ["-y", "@tidegap/mcp"];

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const mcpServers = json({ mcpServers: { tidegap: { command: "npx", args: MCP_ARGS } } });
const markdown = (path: string): AgentSnippetFile => ({ path, format: "markdown", content: AGENTS_BLOCK });

const ASK = "ask";
/** OpenCode bash rules: last match wins, so the catch-all comes first (opencode.ai/docs/permissions). */
const OPENCODE_BASH = {
  "*": "allow",
  crontab: ASK,
  "crontab *": ASK,
  "crontab -l": "allow",
  "launchctl load *": ASK,
  "launchctl bootstrap *": ASK,
  "systemctl --user enable *": ASK,
};

/** The intro and files for one host. */
export function agentSnippet(host: AgentHost): AgentSnippet {
  switch (host) {
    case "generic":
      return {
        host,
        intro: "Add this block to the instructions file your agent reads (AGENTS.md, CLAUDE.md, GEMINI.md). The MCP server is npx -y @tidegap/mcp.",
        files: [markdown("AGENTS.md")],
      };
    case "claude":
      return {
        host,
        intro:
          "The Tidegap plugin already does this (skill text, a prompt hint, and a guard that asks before crontab): " +
          "/plugin marketplace add tidegap/tidegap, then /plugin install tidegap. Without the plugin, add the block to CLAUDE.md " +
          "(~/.claude/CLAUDE.md for every project).",
        files: [markdown("CLAUDE.md")],
      };
    case "opencode":
      return {
        host,
        intro:
          "Create the skill, then merge the MCP entry and the bash rules into opencode.json (keep your own \"*\" rule if you have one).",
        files: [
          {
            path: "~/.config/opencode/skills/tidegap/SKILL.md",
            format: "markdown",
            content: `---\nname: tidegap\ndescription: ${DESCRIPTION}\n---\n\n${AGENTS_BLOCK}`,
          },
          {
            path: "~/.config/opencode/opencode.json",
            format: "json",
            content: json({
              $schema: "https://opencode.ai/config.json",
              mcp: { tidegap: { type: "local", command: ["npx", ...MCP_ARGS], enabled: true } },
              permission: { bash: OPENCODE_BASH },
            }),
          },
        ],
      };
    case "codex":
      return {
        host,
        intro: "Add the block to AGENTS.md and the MCP table to config.toml.",
        files: [
          markdown("~/.codex/AGENTS.md"),
          {
            path: "~/.codex/config.toml",
            format: "toml",
            content: `[mcp_servers.tidegap]\ncommand = "npx"\nargs = ${JSON.stringify(MCP_ARGS).replace(/,/g, ", ")}\n`,
          },
        ],
      };
    case "cursor":
      return {
        host,
        intro: "Create the rule in your project and add the MCP entry to .cursor/mcp.json.",
        files: [
          {
            path: ".cursor/rules/tidegap.mdc",
            format: "markdown",
            content: `---\ndescription: ${DESCRIPTION}\nalwaysApply: false\n---\n\n${AGENTS_BLOCK}`,
          },
          { path: ".cursor/mcp.json", format: "json", content: mcpServers },
        ],
      };
    case "gemini":
      return {
        host,
        intro: "Add the block to GEMINI.md and merge the MCP entry into settings.json.",
        files: [markdown("~/.gemini/GEMINI.md"), { path: "~/.gemini/settings.json", format: "json", content: mcpServers }],
      };
  }
}

/** The text `tidegap jobs snippet --host <host>` prints. */
export function renderAgentSnippet(host: AgentHost): string {
  const s = agentSnippet(host);
  return [s.intro, ...s.files.map((f) => `${f.path}:\n\n${f.content.trimEnd()}`)].join("\n\n");
}
