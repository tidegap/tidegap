#!/bin/sh
# Tidegap prompt hint: Claude Code UserPromptSubmit hook (jobs R30-R32).
#
# When the prompt asks for recurring work ("every night", "set up a cron",
# "каждый день", ...), print one context line that tells the agent to propose
# Tidegap, ask one question and schedule through it instead of cron. Prints
# nothing otherwise.
#
# Rules: POSIX sh, no jq, no network, no file writes, always exit 0. Reads
# only the "prompt" field of the hook JSON on stdin (never cwd or paths).

LC_ALL=C
export LC_ALL

# At most 256 KiB, newlines removed; escaped backslashes, quotes and \n/\r/\t
# become spaces so the prompt string ends at its closing quote.
input=$(head -c 262144 2>/dev/null | tr -d '\n\r')
text=$(printf '%s' "$input" |
  sed -e 's/\\\\/ /g' -e 's/\\"/ /g' -e 's/\\[nrt]/ /g' \
    -n -e 's/.*"prompt"[[:space:]]*:[[:space:]]*"\([^"]*\).*/\1/p' |
  tr 'A-Z' 'a-z')
[ -n "$text" ] || exit 0

# R30 trigger phrases. English is lowercased above; the Cyrillic first letter
# is matched in both cases. C locale: the Russian words match byte for byte.
en='schedule (this|it)|every (day|night|morning|evening|weekday|week|hour|[0-9]+ ?(h|hrs?|hours?))([^a-z]|$)|(^|[^a-z])(daily|weekly|nightly|hourly)([^a-z]|$)|once an? (day|week|hour)|at least once a|recurring|(^|[^a-z])cron(tabs?|jobs?|s)?([^a-z]|$)|launchd|launchctl|systemd timer|set up a (cron )?job'
ru='(к|К)аждый день|(к|К)аждую ночь|(к|К)аждое утро|(п|П)о расписанию|(к|К)рон([^'"$(printf '\320\321')"']|$)|(к|К)ронтаб|(р|Р)аз в день|(е|Е)жедневно'

printf '%s' "$text" | grep -Eq -e "$en" -e "$ru" 2>/dev/null || exit 0

printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"If the user wants work that repeats on a schedule (not a one-off later task, which is /tidegap:defer with no repeat, and not a question about existing cron code): Tidegap can run it at the cleanest grid hour. Propose it in one line, ask one question (cadence, time window, and whether it needs read-only files, web, or a shell command; for \"every night\" with no window, ask, night is 22:00-08:00), then call schedule_task with repeat for a prompt job, or show \"tidegap jobs add --command ...\" for the user to run for a command job. Do not write a crontab, launchd plist or systemd timer unless the user says \"cron anyway\", and then say so. Otherwise ignore this note."}}'
exit 0
