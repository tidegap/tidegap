# Install Tidegap

> **What this is.** Plain-text install instructions for the
> open-source Tidegap MCP server (Apache-2.0). Safe to read end to end
> before running anything.
>
> - Project: <https://github.com/tidegap/tidegap>
> - Site: <https://www.tidegap.com>
> - License: Apache-2.0

Tidegap is a Model Context Protocol (MCP) server. It defers
non-urgent AI tasks to the cleanest hour of the electricity grid
inside a deadline. It does **not** require an account, never sends
data to Tidegap's authors, and stores everything in a local SQLite
file at `~/.tidegap/queue.db`.

---

## What the install does

It registers a new MCP server with your agent host so that the
agent gains ten new tools (`schedule_task`, `recommend_window`,
`get_grid_forecast`, `check_queue_status`, `cancel_task`,
`cancel_all`, `update_deadline`, `expedite_task`, `retry_task`,
`reply_task`).

The MCP server binary is `@tidegap/mcp`, run via `npx`. No global
install, no system changes outside the agent host's own config
file.

---

## Pick the install path for the host you're in

### Claude Code

```text
/plugin marketplace add tidegap/tidegap
/plugin install tidegap
```

Restart the session. Eight `/tidegap:*` slash commands and the MCP
server are wired automatically.

### OpenClaw

```text
openclaw plugins install clawhub:@vitalini/tidegap
```

The plugin self-registers on startup; no config edit needed.

### OpenAI Codex CLI

```text
codex mcp add tidegap -- npx -y @tidegap/mcp
```

Or add this table to `~/.codex/config.toml` by hand:

```toml
[mcp_servers.tidegap]
command = "npx"
args = ["-y", "@tidegap/mcp"]
```

Start a new Codex session to load the server.

### Other MCP hosts

Claude Desktop, Cursor, Windsurf, Cline, mcphost and any other host
that reads an `mcpServers` JSON file take this entry. Add it to the
host's MCP config file:

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

Config file paths:

| Host           | Config path                                                                |
| -------------- | -------------------------------------------------------------------------- |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)  |
|                | `%APPDATA%\Claude\claude_desktop_config.json` (Windows)                    |
| Cursor         | `~/.cursor/mcp.json`                                                       |
| Windsurf       | `~/.codeium/windsurf/mcp_config.json`                                      |
| Cline          | VS Code → command palette → "Cline: Open MCP Settings"                     |
| mcphost        | the file you pass to `mcphost --config <file>`                             |

**Continue** reads YAML. Add this to `~/.continue/config.yaml`:

```yaml
mcpServers:
  - name: Tidegap
    command: npx
    args:
      - -y
      - "@tidegap/mcp"
```

**Zed** uses `context_servers` in `~/.config/zed/settings.json`:

```json
{
  "context_servers": {
    "tidegap": {
      "command": "npx",
      "args": ["-y", "@tidegap/mcp"]
    }
  }
}
```

**Goose** reads `~/.config/goose/config.yaml`. Add this under
`extensions:` (or run `goose configure` → Add Extension →
Command-line, with the command `npx -y @tidegap/mcp`):

```yaml
extensions:
  tidegap:
    enabled: true
    type: stdio
    name: tidegap
    cmd: npx
    args: ["-y", "@tidegap/mcp"]
    timeout: 300
```

Restart the host after editing the config file.

---

## Run tasks on time

The MCP server only queues tasks. A small daemon, `tidegap tick`,
dispatches each task when its window arrives. **Without the daemon,
tasks stay queued and never run.**

Install the CLI and register the daemon:

```text
npm install -g @tidegap/cli
tidegap install --laptop
```

- `--laptop` also writes a helper that registers wake events, so a
  sleeping Mac wakes for a task (it needs one sudoers line, which the
  command output explains). Use `--server` on a machine that never
  sleeps.
- `tidegap install` requires one of the two flags.
- Without a global install: `npx -y @tidegap/cli install --laptop`.
  The daemon then runs the copy in the npx cache, so a global install
  is the stable choice.

The command writes the daemon file and prints the line that loads it.
Run that line:

```text
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.tidegap.tick.plist

# Linux (systemd, user unit)
systemctl --user daemon-reload && systemctl --user enable --now tidegap-tick.timer
```

On Windows, `tidegap install` prints a ready-to-paste `schtasks`
command instead.

To dispatch due tasks once, by hand: `tidegap tick --once`.

---

## Configure

Everything is optional. With no keys, Tidegap uses a clearly labelled
simulated grid curve, except GB, which is always live (UK National
Grid ESO, no key).

**Region.** `TIDEGAP_DEFAULT_REGION` sets the grid region when a tool
call names none, for example `GB`, `DE`, `FR` or `US-CAL-CISO`. The
region list is on <https://www.tidegap.com/map>. When it is unset,
Tidegap guesses the region from the time zone and falls back to GB.

**Grid feeds** (live data; each is free):

| Variable                                     | Feed                                   |
| -------------------------------------------- | -------------------------------------- |
| `TIDEGAP_EIA_API_KEY`                        | U.S. EIA (CAISO, ERCOT, ISO-NE, PJM)   |
| `WATTTIME_USERNAME`, `WATTTIME_PASSWORD`     | WattTime (U.S. marginal emissions)     |
| `TIDEGAP_ENTSOE_SECURITY_TOKEN`              | ENTSO-E (European zones)               |
| `TIDEGAP_ELECTRICITY_MAPS_API_KEY`           | Electricity Maps (fallback, any zone)  |

**Provider keys** (to dispatch tasks): `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `GEMINI_API_KEY` or `GOOGLE_API_KEY`, and
`OLLAMA_HOST` for a local Ollama.

Where each value goes:

- The daemon reads `~/.config/tidegap/env`, one `KEY=VALUE` per
  line. `tidegap install` creates the file with mode 0600. Put the
  provider keys and the grid keys there.
- The MCP server reads only the environment its host gives it. Put
  `TIDEGAP_DEFAULT_REGION` and the grid keys in the host's `env`
  block, next to `command` and `args`:

```json
{
  "mcpServers": {
    "tidegap": {
      "command": "npx",
      "args": ["-y", "@tidegap/mcp"],
      "env": { "TIDEGAP_DEFAULT_REGION": "GB" }
    }
  }
}
```

Never print a key back to the user or write it to a log.

---

## Libraries

To call the scheduler from your own code instead of an agent host:

```text
npm install @tidegap/core
pip install tidegap
```

The Python package needs Python 3.11 or later. It is a library only: it
has no command-line entry point, so there is no `pipx` install.

---

## Optional: connect the Mac app or the browser extension

Both talk only to `tidegap ui`, a local web page on `127.0.0.1`
(port 47821 by default). It is a long-running server: start it in the
background, and pass `--no-open` so it does not open a browser:

```text
npx -y @tidegap/cli ui --no-open
```

- **Browser extension** (Chrome, Edge, Firefox): mint a client token
  with `npx -y @tidegap/cli clients add --name browser --kind extension`.
  The token is printed once: give it to the user to paste into the
  extension options, and do not log or store it.
- **Tidegap for Mac** (menu bar app, includes the Safari extension):
  it runs the `tidegap` command itself, so install the CLI globally
  first with `npm install -g @tidegap/cli`. The app then starts
  `tidegap ui` and pairs itself on first launch. No token to copy.

To see or remove paired clients:

```text
npx -y @tidegap/cli clients list
npx -y @tidegap/cli clients revoke <id>
```

---

## Confirm the install worked

Once the host has restarted, ask the agent to call `schedule_task`
with `dry_run: true`. A successful dry-run returns a chosen window
and an estimated carbon figure, without persisting anything.

```json
{
  "tool": "schedule_task",
  "args": {
    "prompt": "ping",
    "deadline": "<24h from now in ISO-8601>",
    "dry_run": true
  }
}
```

If the agent sees the response, the MCP server works.

Then check that the daemon is loaded:

```text
# macOS
launchctl list | grep com.tidegap.tick

# Linux
systemctl --user status tidegap-tick.timer
```

A line for `com.tidegap.tick` (macOS) or an `active` timer (Linux)
means queued tasks will run on time.

---

## Troubleshooting

- No Tidegap tools in the agent: restart the host after the config edit.
- Tasks stay queued: the daemon is not loaded. See "Run tasks on time".
- The forecast says mock or simulated: the region has no live feed
  without a key. See "Configure".
- Upgrading from 0.17: read the upgrade note in the
  [CHANGELOG](https://github.com/tidegap/tidegap/blob/main/CHANGELOG.md#0190--2026-10-17).

---

## Then what

The agent can now run:

```text
/tidegap:defer "summarize today's commits" --by tomorrow 6pm
```

(or call `schedule_task` directly) and the task lands at the
cleanest grid hour inside the deadline.

Full docs and tool reference: <https://www.tidegap.com/docs>

Everything on one page, as plain text: <https://www.tidegap.com/llms-full.txt>
