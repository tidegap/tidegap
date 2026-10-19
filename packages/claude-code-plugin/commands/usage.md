---
description: Show Claude Code subscription limits and usage
---

Show how much of the Claude Code 5-hour and weekly limits is used, and
when each resets.

## Arguments

`$ARGUMENTS`

Optional: `--spend` (or "with spend") to add token and cost estimates.

## What to do

1. Call the `tidegap` MCP server's **`tidegap_usage`** tool with
   `include_spend` set to `true` when `--spend` was given, otherwise omit.
2. Render a compact summary, never raw JSON: percent used and reset time
   of the 5-hour and weekly windows, the age of the reading, and the
   Codex limits when present.
3. If a window is at 90% or more, suggest
   `/tidegap:defer <task> --by <when>` with `after_limit_reset`, or
   `/tidegap:later <id> after_limit_reset` for a queued task.

## Examples

```
/tidegap:usage
/tidegap:usage --spend
```
