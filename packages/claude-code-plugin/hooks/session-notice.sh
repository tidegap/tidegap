#!/bin/sh
# Tidegap session notice: Claude Code UserPromptSubmit hook.
#
# When tasks this session queued have finished, the next prompt gets one
# notice: their ids, status, titles and result files, never their text.
# The tidegap tick keeps ~/.tidegap/sessions/notices/<session_id> while the
# session has something to hear, so on every other prompt this script exits
# without starting tidegap.
#
# With the marker, `tidegap queue notices --hook` prints the notice (plain
# stdout becomes context) and records that the session saw it. An older
# tidegap without that command, or any failure, prints nothing.
#
# Rules: POSIX sh, no jq, no network, no file writes, always exit 0. Reads
# only the "session_id" field. tidegap gets that checked id on stdin, as
# {"session_id":"<id>"}, never through a shell or a command line, so a
# prompt cut at the input cap still gets its notice.

LC_ALL=C
export LC_ALL

[ -n "${HOME:-}" ] || exit 0

# At most 256 KiB, newlines removed for the match.
input=$(head -c 262144 2>/dev/null)

# The session id, only when it is 8-128 letters, digits, '-' or '_'.
session_id=$(printf '%s' "$input" | tr -d '\n\r' |
  sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([A-Za-z0-9_-]\{8,128\}\)".*/\1/p')
[ -n "$session_id" ] || exit 0
[ -f "$HOME/.tidegap/sessions/notices/$session_id" ] || exit 0
command -v tidegap >/dev/null 2>&1 || exit 0

# The id matched [A-Za-z0-9_-]{8,128}, so it needs no JSON escaping.
out=$(printf '{"session_id":"%s"}' "$session_id" | tidegap queue notices --hook --hook-input - 2>/dev/null) || exit 0
[ -n "$out" ] && printf '%s\n' "$out"
exit 0
