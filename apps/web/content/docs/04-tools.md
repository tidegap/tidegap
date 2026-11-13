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
- `llm_timeout` sets the time limit of a task, or of each run of a job: a duration from 1s to 7d, such as `45m`, or `none`; `0` is refused. Without it the [run limits](#limits) setting applies. `check_queue_status` with a `task_id` shows each time limit and its source. On a task whose deadline is over 24 hours away and that may go to a provider Batch API, the reply notes that a Batch run applies no time limit.
- `retries` (0 to 10) and `retry_delay` (a duration, doubling for each later retry) set how a failed run is tried again, for a task or each run of a job; without them the setting applies, else one retry after 30 minutes ([Retries](#retries)). `check_queue_status` shows the policy and one `attempt_<n>` line per failed attempt that was tried again. Only the final outcome sends a notice.
- `retry_task` runs a failed task again as attempt 1 of a new count. With the provider's key in the server env it runs the call now; a `command` or `claude-code` task, or one with no key there, is due now and the next `tidegap tick` runs it. A job run is refused.
- `cancel_task` with `series: true` ends a job or a series. A cancel of a running task stops its command, `claude -p` run or API call.

### Handed-off work in tool calls {#tools-handoff}

- `schedule_task` on the MCP server takes the work shape of a task: `runner` (another name for `provider`; a call whose `runner` and `provider` differ is refused), `cwd` (the folder a `claude-code` run works in), `permission_profile` (`read`, `web` or `none`; `read` when only `cwd` is given) and `result_path` (a new file Tidegap writes the result text to). The reply adds `cwd:`, `profile:`, `tools:` and `result_path:` lines, and `check_queue_status` with a `task_id` shows them.
- `runner` or `provider` `command` is refused, and nothing is queued: a shell command task is the user's call, and the reply names `tidegap queue add --runner command --cwd <dir> --by <when> '<cmd>'`.
- `result_path` and `output_path` must be inside `cwd`, the session's project folder or the temp folder, in a folder that exists and is yours below that folder, with no name below that folder starting with `.`, and outside `~/.tidegap`, `~/.config`, `~/.claude`, `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/Library` and `.git` folders (in any letter case and under any other name). The home folder and `/` never count as the session's project folder. A refusal names the allowed folders. `result_path` must be a new file; `output_path` may replace a regular file you own that has no second name. Both are checked again before the write.
- `wake_session: true` wakes this Claude Code session when the task finishes, if it sits idle, within 12 hours after its last turn ended. The reply and `check_queue_status` add a `wake: on` line. It is refused outside a Claude Code session (also with an `origin_session_id` the server cannot check), and when the server's ledger is not the default `~/.tidegap/queue.db` (`TIDEGAP_DB_PATH` names another file or `:memory:`, or the server could not create its data folder and keeps its tasks in memory): the plugin's hooks read only that ledger, so the wake could never fire. A wake starts a model turn while nobody may be watching, so it is off by default; without it the notice comes with the next prompt. See [Wake an idle session](#handoff-wake).
- A job repeat refuses `cwd`, `permission_profile` and `result_path`, like the other per-task options. With a job repeat, `wake_session: true` binds the job to this session and wakes it on a run that failed for good, and `wake_match: "<pattern>"` wakes it on a run whose output matches (see [Waking the session](#jobs-wake)); `wake_match` without a job repeat is refused. A series repeat (with `deadline_kind` `quota_reset`) refuses `result_path`: each run would write the same new file.

The profiles, the folder rules and the result files: [Agent handoff](#handoff-queue).
