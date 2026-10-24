/**
 * Static copy of AGENTS_BLOCK from packages/core-ts/src/agent-snippet.ts: the
 * site does not import the core at runtime (jobs KTD15). docs-drift checks
 * that this text equals the built module, so edit the core and copy it here.
 */
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

/** The hosts `tidegap jobs snippet --host` prints files for. */
export const AGENT_SNIPPET_HOSTS = ["claude", "opencode", "codex", "cursor", "gemini"];
