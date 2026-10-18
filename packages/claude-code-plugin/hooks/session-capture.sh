#!/bin/sh
# Tidegap session capture: Claude Code SessionStart / SessionEnd hook.
#
#   session-capture.sh start   <hook JSON on stdin>
#   session-capture.sh end     <hook JSON on stdin>
#
# `start` writes ~/.tidegap/sessions/claude-<pid>.json, where <pid> is the
# nearest ancestor process named `claude` that runs as this user. The Tidegap MCP server of the same
# Claude Code process reads that file when a task is queued, so the task
# knows which session asked for it (also after /clear and /resume, which fire
# SessionStart again). `end` deletes the file when it still names the ending
# session.
#
# Rules: print nothing (SessionStart stdout becomes session context), always
# exit 0, never pass hook input to a shell or a command line. Needs only
# sh, ps, id, mkdir, cat, mv, rm, tr, sed and date.

mode=${1:-}
umask 077
# No pathname expansion: `set -- $line` below splits ps output only.
set -f

[ -n "${HOME:-}" ] || exit 0
dir="$HOME/.tidegap/sessions"

# The hook JSON is one object; read it whole, with newlines removed.
input=$(cat 2>/dev/null | tr -d '\n\r')

# The session id, only when it is 8-128 letters, digits, '-' or '_'.
session_id=$(printf '%s' "$input" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([A-Za-z0-9_-]\{8,128\}\)".*/\1/p')
[ -n "$session_id" ] || exit 0
me=$(id -u 2>/dev/null) || exit 0

# Nearest ancestor named `claude` and owned by this user, at most 6 levels up.
find_claude() {
  p=$PPID
  i=0
  while [ "$i" -lt 6 ]; do
    line=$(ps -o uid=,ppid=,comm= -p "$p" 2>/dev/null) || return 1
    [ -n "$line" ] || return 1
    # shellcheck disable=SC2086
    set -- $line
    [ $# -ge 3 ] || return 1
    uid=$1
    ppid=$2
    shift 2
    comm=$*
    if [ "${comm##*/}" = "claude" ] && [ "$uid" = "$me" ]; then
      printf '%s' "$p"
      return 0
    fi
    case $ppid in
      ''|*[!0-9]*) return 1 ;;
    esac
    [ "$ppid" -gt 1 ] || return 1
    p=$ppid
    i=$((i + 1))
  done
  return 1
}

# A JSON string body: backslash and quote escaped, control characters dropped.
json_text() {
  printf '%s' "$1" | tr -d '\000-\037' | sed 's/\\/\\\\/g; s/"/\\"/g'
}

pid=$(find_claude) || exit 0
case $pid in
  ''|*[!0-9]*) exit 0 ;;
esac
file="$dir/claude-$pid.json"

case $mode in
  start)
    case $input in
      '{'*'}') ;;
      *) exit 0 ;;
    esac
    mkdir -p "$dir" 2>/dev/null || exit 0
    chmod 700 "$dir" 2>/dev/null
    # Files of processes that no longer run are stale.
    set +f
    for old in "$dir"/claude-*.json; do
      [ -f "$old" ] || continue
      n=${old##*/claude-}
      n=${n%.json}
      case $n in
        ''|*[!0-9]*) continue ;;
      esac
      [ "$n" = "$pid" ] && continue
      ps -o pid= -p "$n" >/dev/null 2>&1 || rm -f "$old"
    done
    set -f
    project_dir=$(json_text "${CLAUDE_PROJECT_DIR:-}")
    written_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    tmp="$dir/.claude-$pid.json.$$.tmp"
    if printf '{"v":1,"pid":%s,"session_id":"%s","project_dir":"%s","written_at":"%s","hook":%s}\n' \
      "$pid" "$session_id" "$project_dir" "$written_at" "$input" > "$tmp" 2>/dev/null; then
      chmod 600 "$tmp" 2>/dev/null
      mv -f "$tmp" "$file" 2>/dev/null || rm -f "$tmp"
    else
      rm -f "$tmp"
    fi
    ;;
  end)
    [ -f "$file" ] || exit 0
    held=$(tr -d '\n\r' < "$file" 2>/dev/null | sed -n 's/^{"v":1,"pid":[0-9]*,"session_id":"\([A-Za-z0-9_-]*\)".*/\1/p')
    [ "$held" = "$session_id" ] && rm -f "$file"
    ;;
esac
exit 0
