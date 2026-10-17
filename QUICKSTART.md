# Quick start

**One command. Thirty seconds. Carbon-aware AI scheduling in any MCP host.**

---

## Step 1 — Install in your AI host

### Claude Code (one line)

```
/plugin marketplace add tidegap/tidegap
/plugin install tidegap
```

Auto-wires the MCP server and adds eight `/tidegap:*` slash commands.

### Cursor · Claude Desktop · any other MCP host

Add the MCP server to your host's config:

```json
{
  "mcpServers": {
    "tidegap": {
      "command": "npx",
      "args": ["-y", "@tidegap/mcp"]
    }
  }
}
```

Locations:
- **Claude Desktop:** `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) · `%APPDATA%\Claude\claude_desktop_config.json` (Windows)
- **Cursor:** `~/.cursor/mcp.json` or Settings → MCP
- **Cline / Windsurf / Zed / Continue / Goose / OpenClaw:** see the host-specific snippets at <https://www.tidegap.com/#install>

### Python library (no MCP)

```bash
pip install tidegap
```

Use the `tidegap.Scheduler` API directly.

### TypeScript / Node library (no MCP)

```bash
pnpm add @tidegap/core
```

Import `createScheduler`, `recommendWindow`, `TaskStore` from `@tidegap/core`.

---

## Step 2 — Try it

In any chat session with the host you installed it in, type a request
with deferral phrasing:

```
defer "summarize my GitHub notifications" by tomorrow 6pm
```

The agent picks up the trigger automatically and queues the task at
the cleanest electricity-grid hour inside the deadline. You get a
`task_id` immediately; the actual LLM call fires later.

Equivalent explicit form:

```
/tidegap:defer "summarize my GitHub notifications" --by tomorrow 6pm
```

---

## Step 3 — Run the tick daemon (for actual dispatch)

The MCP server **queues** tasks but doesn't run a clock. To actually
dispatch at the chosen window, install the CLI's tick daemon once:

```bash
npm install -g @tidegap/cli
tidegap install      # writes and loads the launchd agent (macOS) or systemd timer (Linux)
tidegap status       # will queued tasks run? exit 0 = yes
```

`tidegap install` picks `--laptop` on a Mac with a battery and `--server`
elsewhere, and says which. It loads the daemon itself and ends with the
`tidegap status` lines; `--no-load` only writes the files. When
`tidegap status` says "Tasks will not run", the line names the fix.

To push a queued task later (it never runs earlier than planned):

```bash
tidegap queue later <id> --until tonight       # or +2h, tomorrow, 9:00, an ISO time
tidegap queue later <id> --until after-limit-reset --reset-at 18:00
```

Without the daemon, tasks sit queued; you can dispatch manually with
`tidegap tick --once`.

---

## Step 4 — (Optional) live grid data for more regions

GB is always live via UK National Grid ESO with no API key. To unlock
live data for the US and EU regions, set any of:

```bash
export TIDEGAP_EIA_API_KEY="..."              # US ISOs (free at eia.gov)
export TIDEGAP_ENTSOE_SECURITY_TOKEN="..."    # Europe (free at transparency.entsoe.eu)
export TIDEGAP_ELECTRICITY_MAPS_API_KEY="..." # universal fallback (free at electricitymaps.com)
```

Without any of these, Tidegap uses a deterministic mock curve so the
stack still works end-to-end (useful for demos and CI).

---

## Where to go next

- **Live carbon map + planner:** <https://www.tidegap.com/>
- **Full docs (all 8 commands + 10 MCP tools + install matrix):** <https://www.tidegap.com/docs>
- **Why it exists:** <https://www.tidegap.com/about>
- **Architecture:** <https://www.tidegap.com/architecture>
- **Source / issues / CHANGELOG:** <https://github.com/tidegap/tidegap>

---

## Developer setup (only if hacking on Tidegap itself)

```bash
git clone https://github.com/tidegap/tidegap
cd Tidegap
pnpm install
pnpm -r build       # build every package in the workspace
pnpm -r test        # full TS + Python suite (current count: README.md badge)
```

Requirements: **Node 20+**, **pnpm 9+**, **Python 3.11+** for the
Python port.

Then:

```bash
pnpm --filter @tidegap/web dev   # local dashboard at :3000
```

See `apps/web/README.md` for dashboard-specific details.
