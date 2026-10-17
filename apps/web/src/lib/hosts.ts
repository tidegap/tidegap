/**
 * The one host list for the site. Plain module (no "use client"), so server
 * components get the data, not a client reference. Every host count on the
 * site comes from HOST_COUNT.
 */

/** install.md covers every plain MCP host under one combined heading. */
const SHARED_MCP_HEADING = "Other MCP hosts";

export type Host = {
  id: string;
  label: string;
  group: "mcp" | "ide" | "agent" | "lib";
  desc: string;
  command: string;
  lang: "bash" | "json" | "yaml" | "toml";
  followup: string;
  /** The `public/install.md` heading that covers this host. */
  installHeading: string;
};

export const HOSTS: Host[] = [
  {
    id: "mcp",
    installHeading: SHARED_MCP_HEADING,
    label: "MCP server (generic)",
    group: "mcp",
    desc: "Universal — add tidegap-mcp to any host that speaks Model Context Protocol.",
    command: "npx -y @tidegap/mcp",
    lang: "bash",
    followup:
      "Wire this into your host's MCP config (the snippets for specific hosts are in the dropdown).",
  },
  {
    id: "claude-code",
    installHeading: "Claude Code",
    label: "Claude Code (plugin)",
    group: "agent",
    desc: "Adds eight /tidegap:* slash commands plus auto-wires the MCP server.",
    command: "/plugin marketplace add tidegap/tidegap\n/plugin install tidegap",
    lang: "bash",
    followup:
      "Restart your session. Then call: /tidegap:defer \"summarize this\" --by tomorrow 6pm",
  },
  {
    id: "codex",
    installHeading: "OpenAI Codex CLI",
    label: "OpenAI Codex CLI",
    group: "agent",
    desc: "Run codex mcp add, or add this table to ~/.codex/config.toml by hand.",
    command: `[mcp_servers.tidegap]
command = "npx"
args = ["-y", "@tidegap/mcp"]`,
    lang: "toml",
    followup:
      "Start a new Codex session to load the server. One-liner instead: codex mcp add tidegap -- npx -y @tidegap/mcp",
  },
  {
    id: "claude-desktop",
    installHeading: SHARED_MCP_HEADING,
    label: "Claude Desktop",
    group: "ide",
    desc: "Edit ~/Library/Application Support/Claude/claude_desktop_config.json (macOS) or %APPDATA%\\Claude\\claude_desktop_config.json (Windows).",
    command: `{
  "mcpServers": {
    "tidegap": {
      "command": "npx",
      "args": ["-y", "@tidegap/mcp"]
    }
  }
}`,
    lang: "json",
    followup: "Restart Claude Desktop. Tidegap tools available in any chat.",
  },
  {
    id: "cursor",
    installHeading: SHARED_MCP_HEADING,
    label: "Cursor",
    group: "ide",
    desc: "Settings → MCP → Add new MCP server. Or edit ~/.cursor/mcp.json directly.",
    command: `{
  "mcpServers": {
    "tidegap": {
      "command": "npx",
      "args": ["-y", "@tidegap/mcp"]
    }
  }
}`,
    lang: "json",
    followup: "Reload Cursor — Tidegap shows up in the MCP servers list.",
  },
  {
    id: "windsurf",
    installHeading: SHARED_MCP_HEADING,
    label: "Windsurf (Codeium)",
    group: "ide",
    desc: "Edit ~/.codeium/windsurf/mcp_config.json.",
    command: `{
  "mcpServers": {
    "tidegap": {
      "command": "npx",
      "args": ["-y", "@tidegap/mcp"]
    }
  }
}`,
    lang: "json",
    followup: "Restart Windsurf.",
  },
  {
    id: "continue",
    installHeading: SHARED_MCP_HEADING,
    label: "Continue (VS Code)",
    group: "ide",
    desc: "Add to ~/.continue/config.yaml under mcpServers.",
    command: `mcpServers:
  - name: Tidegap
    command: npx
    args:
      - -y
      - "@tidegap/mcp"`,
    lang: "yaml",
    followup: "Reload the Continue panel.",
  },
  {
    id: "cline",
    installHeading: SHARED_MCP_HEADING,
    label: "Cline (VS Code)",
    group: "ide",
    desc: "Cline → Settings (gear) → MCP Servers → Edit MCP Settings.",
    command: `{
  "mcpServers": {
    "tidegap": {
      "command": "npx",
      "args": ["-y", "@tidegap/mcp"],
      "disabled": false
    }
  }
}`,
    lang: "json",
    followup: "Reload Cline. Tidegap tools appear in Cline's tool list.",
  },
  {
    id: "zed",
    installHeading: SHARED_MCP_HEADING,
    label: "Zed editor",
    group: "ide",
    desc: "In Zed settings.json, add a context_servers entry.",
    command: `"context_servers": {
  "tidegap": {
    "command": "npx",
    "args": ["-y", "@tidegap/mcp"]
  }
}`,
    lang: "json",
    followup: "Restart Zed. Tools surface in the Assistant panel.",
  },
  {
    id: "goose",
    installHeading: SHARED_MCP_HEADING,
    label: "Goose (Block)",
    group: "agent",
    desc: "goose configure → Add Extension → Command-line.",
    command: "npx -y @tidegap/mcp",
    lang: "bash",
    followup:
      "When asked for an Extension Name, enter Tidegap. Then: goose session.",
  },
  {
    id: "openclaw",
    installHeading: "OpenClaw",
    label: "OpenClaw (plugin via ClawHub)",
    group: "agent",
    desc: "Native OpenClaw plugin that registers eleven Tidegap tools (schedule_task, recommend_window, check_queue_status, cancel_task, get_grid_forecast, update_deadline, cancel_all, set_delivery, expedite_task, retry_task, reply_task). Page: https://clawhub.ai/plugins/@vitalini/tidegap",
    command: "openclaw plugins install clawhub:@vitalini/tidegap",
    lang: "bash",
    followup:
      'Restart the OpenClaw gateway. Then say "do this later" / "by tomorrow" / "overnight" in any session — schedule_task fires automatically.',
  },
  {
    id: "mcphost-cli",
    installHeading: SHARED_MCP_HEADING,
    label: "mcphost / mcp-cli",
    group: "agent",
    desc: "Generic command-line MCP host. Add Tidegap to your hosts config.",
    command: `{
  "mcpServers": {
    "tidegap": {
      "command": "npx",
      "args": ["-y", "@tidegap/mcp"]
    }
  }
}`,
    lang: "json",
    followup: "mcphost --config <your-config>.json or mcp-cli with --server Tidegap.",
  },
  {
    id: "python-lib",
    installHeading: "Libraries",
    label: "Python library",
    group: "lib",
    desc: "Use Tidegap directly as a Python library — no MCP host needed.",
    command: "pip install tidegap",
    lang: "bash",
    followup:
      "from tidegap import Scheduler; s = Scheduler(); await s.schedule(...). Same API as the TypeScript core.",
  },
  {
    id: "node-lib",
    installHeading: "Libraries",
    label: "TypeScript / Node library (no MCP)",
    group: "lib",
    desc: "Use @tidegap/core directly as an npm dependency.",
    command: "pnpm add @tidegap/core   # or npm install / yarn add",
    lang: "bash",
    followup:
      "import { createScheduler } from '@tidegap/core'. Same scheduler shape, no MCP wrapper.",
  },
];

export const GROUP_LABELS: Record<Host["group"], string> = {
  mcp: "MCP universal",
  ide: "Editors / IDEs",
  agent: "Agent hosts",
  lib: "Library (no MCP)",
};

/** Hosts that run Tidegap as an agent tool; the libraries are not hosts. */
export const HOST_COUNT = HOSTS.filter((h) => h.group !== "lib").length;
