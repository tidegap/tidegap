#!/bin/sh
# Tidegap session wake: Claude Code Stop hook, run in the background
# (asyncRewake: exit code 2 wakes the session, with stderr as a reminder).
#
# A task queued with a wake (`tidegap queue add --wake`, or schedule_task
# with wake_session) leaves ~/.tidegap/sessions/wake/<session_id>. Without
# that marker this script exits 0 at once and starts no tidegap. With it,
# `tidegap queue notices --wait --rewake` waits for a wake task of this
# session to finish (while this session's claude process runs, at most
# 11 h 50 min). Then the notice goes to stderr and the exit code is 2, so the
# idle session starts a turn with the notice. Every other outcome, an older
# tidegap without the command included, exits 0 without output, and the
# notice comes with the next prompt (session-notice.sh).
#
# Rules: POSIX sh, no jq, no network, no file writes. Reads only the
# "session_id" field. tidegap gets that checked id on stdin, as
# {"session_id":"<id>"}, never through a shell or a command line. Only a
# notice (a line starting with "Tidegap: ") ever leaves with exit 2.

LC_ALL=C
export LC_ALL

[ -n "${HOME:-}" ] || exit 0

# At most 256 KiB, newlines removed for the match.
input=$(head -c 262144 2>/dev/null)

# The session id, only when it is 8-128 letters, digits, '-' or '_'.
session_id=$(printf '%s' "$input" | tr -d '\n\r' |
  sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([A-Za-z0-9_-]\{8,128\}\)".*/\1/p')
[ -n "$session_id" ] || exit 0
[ -f "$HOME/.tidegap/sessions/wake/$session_id" ] || exit 0
command -v tidegap >/dev/null 2>&1 || exit 0

# The id matched [A-Za-z0-9_-]{8,128}, so it needs no JSON escaping.
# stdout is dropped; stderr is kept for the notice.
out=$(printf '{"session_id":"%s"}' "$session_id" | tidegap queue notices --wait --rewake --hook-input - 2>&1 >/dev/null)
code=$?
[ "$code" -eq 2 ] || exit 0
# Lines before the notice (a Node warning) are not part of it.
notice=$(printf '%s\n' "$out" | sed -n '/^Tidegap: /,$p')
[ -n "$notice" ] || exit 0
printf '%s\n' "$notice" >&2
exit 2
