#!/bin/sh
# Tidegap session start: Claude Code SessionStart hook.
#
# Prints one line about finished tasks nobody has read, and names the tasks
# this session queued (`tidegap queue list --unread --hook`, which reads the
# hook input on stdin; an older tidegap gets the form without
# --hook-input; a 0.17 install gets the `ebb` command). Silent when nothing
# is unread.
#
# The CLI is `tidegap` on PATH, else node with the runtime CLI under
# ~/.tidegap/runtime (find-cli.sh). When neither nor `ebb` is found and the
# session is new ("source" is "startup" or absent), it prints one line that
# says task notices and wakes are off and how to fix it; resume, clear and
# compact print nothing, so the line comes once per session.
#
# Rules: POSIX sh, no jq, no network, no file writes, always exit 0. Reads
# only the "source" field; the CLI gets the input on stdin.

LC_ALL=C
export LC_ALL

# At most 256 KiB.
input=$(head -c 262144 2>/dev/null)

# The finder sits next to this script; without it, exit 0 (a failed `.`
# would end the shell with a non-zero code).
case "$0" in */*) hooks_dir=${0%/*} ;; *) hooks_dir=. ;; esac
[ -f "$hooks_dir/find-cli.sh" ] || exit 0
. "$hooks_dir/find-cli.sh"

if tidegap_cli_found; then
  printf '%s' "$input" | tidegap_cli queue list --unread --hook --hook-input - 2>/dev/null ||
    tidegap_cli queue list --unread --hook 2>/dev/null
elif command -v ebb >/dev/null 2>&1; then
  ebb queue list --unread --hook 2>/dev/null
else
  src=$(printf '%s' "$input" | tr -d '\n\r' |
    sed -n 's/.*"source"[[:space:]]*:[[:space:]]*"\([A-Za-z_-]*\)".*/\1/p')
  case "$src" in
    "" | startup)
      echo 'Tidegap: no tidegap CLI found (not on this session'"'"'s PATH, and no runtime at ~/.tidegap/runtime with a node to run it), so task notices and wakes are off. Install it (npm install -g @tidegap/cli) or add the folders of tidegap and node to the PATH that starts claude.'
      ;;
  esac
fi
exit 0
