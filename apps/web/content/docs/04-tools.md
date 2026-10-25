---
id: tools
label: MCP tools
---

<!-- source: packages/core-ts/src/tool-surface.ts (toolsForHost("mcp")); region: packages/mcp-server/src/server.ts, packages/openclaw-plugin/src/index.ts -->
Every MCP host gets the same tools. Each tool's JSON schema documents its parameters.

<!-- embed:tools -->

### Region in tool calls {#tools-region}

- On the MCP server, `get_grid_forecast` and `recommend_window` need a `region`. `schedule_task` takes it as an option. Without it, the task gets the default region: `TIDEGAP_DEFAULT_REGION` in the server's environment, then the stored setting (`tidegap region set`), then the time-zone guess, then `GB`.
- The `schedule_task` reply has a `region_source:` line: `flag` (the argument), `env`, `setting`, `timezone` or `fallback`.
- The MCP server reads `TIDEGAP_DEFAULT_REGION` only from its own process environment, which is the host's `env` block. It never reads `~/.config/tidegap/env`. It reads the stored setting again on each call, so `tidegap region set` needs no host restart.
- A `region` outside the supported zones fails with the closest zones and a request link: `Unknown zone UA. Closest: PL. Request a region: <link>`. With an Electricity Maps key, any other zone passes, except the ENTSO-E zone `IT`, which needs `TIDEGAP_ENTSOE_SECURITY_TOKEN`.
- OpenClaw: `region` is optional on every tool that takes it. The plugin's `defaultRegion` takes the place of `TIDEGAP_DEFAULT_REGION` and reports `region_source: "config"`.

The full rules and the zone list: [Grid region](#region).

### Recurring work in tool calls {#tools-jobs}

- `schedule_task` with `repeat` set to `daily`, `weekdays`, `weekly` or `every_n_hours` creates a [job](#jobs): each run is a new task with the same prompt, at the cleanest hour of its period. Set `every_hours`, `days`, `window` and `time_zone` to shape it.
- A job takes prompts only. Command jobs are written by the user on the page or in the CLI, and a command argument is rejected.
- `repeat: quota_reset` stays the older series that follows the quota reset.
- `cancel_task` with `series: true` ends a job or a series.
