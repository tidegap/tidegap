#!/bin/sh
# Builds Tidegap.app, quits a running copy, replaces ~/Applications/Tidegap.app
# and opens it. Arguments after `--` go to the app, for example:
#   apps/macos/scripts/install.sh -- -tidegapCommand "node $PWD/packages/cli/dist/index.js"
# INSTALL_DIR overrides the target folder (default: ~/Applications).
#
# The app's tidegap command: an explicit `-tidegapCommand` argument wins, then a
# stored `defaults write com.tidegap.mac tidegapCommand "<argv>"`. With neither,
# the script picks `node ~/.tidegap/runtime/cli/dist/index.js` when that file
# exists; else, when no `tidegap` is on PATH, this repo's
# packages/cli/dist/index.js. It prints which one.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
target_dir="${INSTALL_DIR:-$HOME/Applications}"
target="$target_dir/Tidegap.app"

if [ "${1:-}" = "--" ]; then shift; fi

# Pick the tidegap command unless the caller or a stored default already set it.
explicit=0
for arg in "$@"; do
  if [ "$arg" = "-tidegapCommand" ]; then explicit=1; fi
done
if [ $explicit -eq 1 ]; then
  echo "tidegapCommand: from the -tidegapCommand argument"
elif stored="$(defaults read com.tidegap.mac tidegapCommand 2>/dev/null)" && [ -n "$stored" ]; then
  echo "tidegapCommand: from stored defaults ($stored)"
else
  runtime_cli="$HOME/.tidegap/runtime/cli/dist/index.js"
  repo_cli="$(cd "$here/../../.." && pwd)/packages/cli/dist/index.js"
  if [ -f "$runtime_cli" ]; then
    chosen="$runtime_cli"
    echo "tidegapCommand: node $chosen (installed runtime)"
  elif command -v tidegap >/dev/null 2>&1; then
    chosen=""
    echo "tidegapCommand: tidegap on PATH; the app uses its own lookup"
  elif [ -f "$repo_cli" ]; then
    chosen="$repo_cli"
    echo "tidegapCommand: node $chosen (repo build)"
  else
    chosen=""
    echo "tidegapCommand: none found (no installed runtime, no repo build); the app uses its own lookup"
  fi
  case "$chosen" in
    "$HOME/Documents/"* | "$HOME/Desktop/"* | "$HOME/Downloads/"*)
      echo "warning: $chosen is in a privacy-protected folder; macOS may ask the app for access, and the server waits until you allow it" ;;
  esac
  if [ -n "$chosen" ]; then
    # The app splits the command on spaces; quote a path that has one.
    case "$chosen" in
      *" "*) set -- -tidegapCommand "node \"$chosen\"" "$@" ;;
      *) set -- -tidegapCommand "node $chosen" "$@" ;;
    esac
  fi
fi

"$here/build.sh"

# Waits up to 5 s for every Tidegap process to exit; fails when one still runs.
gone_within_5s() {
  i=0
  while pgrep -x Tidegap >/dev/null 2>&1; do
    [ $i -lt 50 ] || return 1
    sleep 0.1
    i=$((i + 1))
  done
}

# Quit, then SIGTERM, then SIGKILL, with a 5 s wait after each of the first two.
# SIGTERM quits like Quit, and an open alert can hold both; the bundle must not
# be replaced under a running copy. Quit does not wait for the app's reply,
# which an open alert can also hold (AppleScript waits 2 minutes for one).
if pgrep -x Tidegap >/dev/null 2>&1; then
  osascript -e 'ignoring application responses' -e 'tell application id "com.tidegap.mac" to quit' -e 'end ignoring' >/dev/null 2>&1 || true
  if ! gone_within_5s; then
    pkill -x Tidegap 2>/dev/null || true
    if ! gone_within_5s; then
      pkill -KILL -x Tidegap 2>/dev/null || true
    fi
  fi
fi

mkdir -p "$target_dir"
rm -rf "$target"
ditto "$here/../build/Tidegap.app" "$target"
echo "installed: $target"
if [ $# -gt 0 ]; then
  open "$target" --args "$@"
else
  open "$target"
fi
