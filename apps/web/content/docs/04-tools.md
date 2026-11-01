---
id: tools
label: MCP tools
---

<!-- source: packages/core-ts/src/tool-surface.ts (toolsForHost("mcp")); region: packages/mcp-server/src/server.ts, packages/openclaw-plugin/src/index.ts; handoff: packages/core-ts/src/handoff.ts, packages/core-ts/src/schedule-job.ts -->
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

### Handed-off work in tool calls {#tools-handoff}

- `schedule_task` on the MCP server takes the work shape of a task: `runner` (another name for `provider`; a call whose `runner` and `provider` differ is refused), `cwd` (the folder a `claude-code` run works in), `permission_profile` (`read`, `web` or `none`; `read` when only `cwd` is given) and `result_path` (a new file Tidegap writes the result text to). The reply adds `cwd:`, `profile:`, `tools:` and `result_path:` lines, and `check_queue_status` with a `task_id` shows them.
- `runner` or `provider` `command` is refused, and nothing is queued: a shell command task is the user's call, and the reply names `tidegap queue add --runner command --cwd <dir> --by <when> '<cmd>'`.
- `result_path` and `output_path` must be inside `cwd`, the session's project folder or the temp folder, in a folder that exists and is yours below that folder, with no name below that folder starting with `.`, and outside `~/.tidegap`, `~/.config`, `~/.claude`, `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/Library` and `.git` folders (in any letter case and under any other name). The home folder and `/` never count as the session's project folder. A refusal names the allowed folders. `result_path` must be a new file; `output_path` may replace a regular file you own that has no second name. Both are checked again before the write.
- `wake_session: true` wakes this Claude Code session when the task finishes, if it sits idle, within 12 hours after its last turn ended. The reply and `check_queue_status` add a `wake: on` line. It is refused outside a Claude Code session (also with an `origin_session_id` the server cannot check). A wake starts a model turn while nobody may be watching, so it is off by default; without it the notice comes with the next prompt. See [Wake an idle session](#handoff-wake).
- A job repeat refuses `cwd`, `permission_profile`, `result_path` and `wake_session`, like the other per-task options. A series repeat (with `deadline_kind` `quota_reset`) refuses `result_path`: each run would write the same new file.

The profiles, the folder rules and the result files: [Agent handoff](#handoff-queue).
