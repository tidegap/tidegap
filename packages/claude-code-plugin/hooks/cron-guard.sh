#!/bin/sh
# Tidegap cron guard: Claude Code PreToolUse hook on Bash (jobs R32, KTD14).
#
# Asks the user (never denies) before a Bash call that installs a system
# scheduler entry (crontab edits, launchctl load|bootstrap, systemctl --user
# enable), authors a Tidegap command job (tidegap jobs add|edit with
# --command or --file, tidegap jobs secrets set) or queues a task with
# `tidegap queue add --runner` set to anything but an LLM runner: agents
# create prompt tasks and jobs only. Fail-closed: a quoted, variable or
# substituted --runner value that is not plainly an LLM runner asks too.
# Anything else passes with no output, so the normal permission flow applies
# (crontab -l included).
#
# Rules: POSIX sh, no jq, no network, no file writes, always exit 0. Reads
# only tool_input.command from the hook JSON on stdin.

LC_ALL=C
export LC_ALL

input=$(head -c 262144 2>/dev/null | tr -d '\n\r')
# Escaped \n and quotes become command separators; escaped backslashes a space.
cmd=$(printf '%s' "$input" |
  sed -e 's/\\\\/ /g' -e 's/\\"/;/g' -e 's/\\[nr]/;/g' -e 's/\\t/ /g' \
    -n -e 's/.*"command"[[:space:]]*:[[:space:]]*"\([^"]*\).*/\1/p')
[ -n "$cmd" ] || exit 0

ask() {
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"%s"}}\n' "$1"
  exit 0
}

S='[[:space:]]'
# The CLI as a command: tidegap, or the npm package (npx @tidegap/cli@x).
T='(tidegap|@tidegap/cli(@[^[:space:]]*)?)'
# Authoring a command job reads the whole string: a quoted title may hold a separator.
if printf '%s' "$cmd" | grep -Eq "(^|[^a-z-])$T$S+jobs$S+secrets$S+set($S|$)" ||
  { printf '%s' "$cmd" | grep -Eq "(^|[^a-z-])$T$S+jobs$S+(add|edit)($S|$)" &&
    printf '%s' "$cmd" | grep -Eq -- "$S--(command|file)($S|=|$)"; }; then
  ask "Command jobs are authored by the user: Tidegap runs this shell command unattended on every run. Show the tidegap jobs add command to the user to run, or schedule a prompt job with schedule_task. Continue only if the user asked for this."
fi

# A one-off task with --runner: each value, with quotes, separators and
# backslashes removed, must be exactly an LLM runner; a missing value asks.
# The words are read with quotes and backslashes removed and separators made
# spaces, so `queue 'add'`, a quoted binary or a line break inside the words
# still match; a variable or substituted binary or subcommand counts as
# `tidegap queue add`.
flat=$(printf '%s' "$cmd" | tr ';' ' ' | tr -d "'\\\\")
if printf '%s' "$flat" | grep -Eq "(^|[^a-z-])($T|[\$\`][^[:space:]]*)$S+queue$S+(add|[\$\`][^[:space:]]*)($S|$)" &&
  printf '%s' "$flat" | grep -Eq -- "--runner"; then
  runners=$(printf '%s' "$flat" | grep -Eo -- "--runner(=[^[:space:]]*|$S+[^[:space:]]*|$)" |
    sed -e 's/^--runner//' -e "s/^=//" -e "s/^$S*//" | tr -d "\"';\\\\")
  if printf '%s\n' "$runners" | grep -Evxq '(claude-code|anthropic|openai|gemini|ollama)'; then
    ask "A shell command task runs unattended in the Tidegap daemon, outside this session's sandbox. Show the tidegap queue add command to the user to run, or queue a prompt with schedule_task. Continue only if the user asked for this."
  fi
fi

# One simple command per line: split at separators and quotes, then drop
# leading wrappers until none is left: VAR=value, sudo (with its options,
# -u user included), env, command, exec, nohup, time, xargs, a directory.
segments=$(printf '%s' "$cmd" | tr ';&|()`{}"'"'" '\n\n\n\n\n\n\n\n\n\n' |
  sed -e "s/^$S*//" -e ':a' \
    -e "s/^[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*$S\{1,\}//" -e 'ta' \
    -e "s/^sudo$S\{1,\}-[ugCDhpRrT]$S\{1,\}[^[:space:]]\{1,\}$S\{1,\}/sudo /" -e 'ta' \
    -e "s/^sudo\($S\{1,\}-[A-Za-z-]\{1,\}\)*$S\{1,\}//" -e 'ta' \
    -e "s/^env\($S\{1,\}-[A-Za-z-]\{1,\}\)*$S\{1,\}//" -e 'ta' \
    -e "s/^command$S\{1,\}//" -e 'ta' -e "s/^exec$S\{1,\}//" -e 'ta' \
    -e "s/^nohup$S\{1,\}//" -e 'ta' -e "s/^time$S\{1,\}//" -e 'ta' \
    -e "s/^xargs$S\{1,\}//" -e 'ta' \
    -e "s/^[^[:space:]]*\/\([a-z]\)/\1/" -e 'ta')

reason="This installs a system scheduler entry. Tidegap can run it at the cleanest hour with receipts: tidegap jobs add ... (or schedule_task with repeat for a prompt). Continue with cron?"
if printf '%s\n' "$segments" | grep -E "^crontab($S|$)" |
  grep -Evq "^crontab($S+-u$S+[^[:space:]]+)?$S+-l$S*([0-9]?>.*)?$"; then
  ask "$reason"
fi
printf '%s\n' "$segments" | grep -Eq "^launchctl$S+(load|bootstrap)($S|$)" && ask "$reason"
if printf '%s\n' "$segments" | grep -E "^systemctl$S" | grep -E "$S--user($S|$)" | grep -Eq "$S(enable)($S|$)"; then
  ask "$reason"
fi
exit 0
