# Tidegap CLI finder for the plugin hooks. Sourced, not run:
#   . "${0%/*}/find-cli.sh"
#
# tidegap_cli_found  returns 0 when a CLI is found, else 1.
# tidegap_cli ARGS   runs that CLI with ARGS, passing stdin, stdout, stderr
#                    and the exit code through; 127 when none is found.
#
# The CLI is `tidegap` on PATH, else the runtime CLI
# ${TIDEGAP_RUNTIME_DIR:-$HOME/.tidegap/runtime}/cli/dist/index.js run with
# the first node found: `node` on PATH, else (macOS) the node that
# `tidegap install` pinned for the tick LaunchAgent, read-only from
# ~/Library/LaunchAgents/com.tidegap.tick.plist and used only when it is an
# executable file named node. Claude Code often starts without the login
# shell's PATH, so the runtime is the usual fallback on a Mac app install.
#
# Rules: POSIX sh, no file writes, never writes or loads a LaunchAgent.

_tidegap_cli_state=
_tidegap_cli_node=
_tidegap_cli_main=

# The pinned node of the tick LaunchAgent, printed; 1 when there is none.
_tidegap_launchd_node() {
  [ -n "${HOME:-}" ] || return 1
  _plist="$HOME/Library/LaunchAgents/com.tidegap.tick.plist"
  [ -f "$_plist" ] || return 1
  command -v plutil >/dev/null 2>&1 || return 1
  _n=$(plutil -extract ProgramArguments.0 raw -o - "$_plist" 2>/dev/null) || return 1
  case "$_n" in
    /*/node) ;;
    *) return 1 ;;
  esac
  [ -f "$_n" ] && [ -x "$_n" ] || return 1
  printf '%s\n' "$_n"
}

tidegap_cli_found() {
  case "$_tidegap_cli_state" in
    path | runtime) return 0 ;;
    none) return 1 ;;
  esac
  _tidegap_cli_state=none
  if command -v tidegap >/dev/null 2>&1; then
    _tidegap_cli_state=path
    return 0
  fi
  [ -n "${HOME:-}" ] || [ -n "${TIDEGAP_RUNTIME_DIR:-}" ] || return 1
  _tidegap_cli_main="${TIDEGAP_RUNTIME_DIR:-$HOME/.tidegap/runtime}/cli/dist/index.js"
  [ -f "$_tidegap_cli_main" ] || return 1
  if command -v node >/dev/null 2>&1; then
    _tidegap_cli_node=node
  else
    _tidegap_cli_node=$(_tidegap_launchd_node) || return 1
  fi
  _tidegap_cli_state=runtime
  return 0
}

tidegap_cli() {
  tidegap_cli_found || return 127
  if [ "$_tidegap_cli_state" = path ]; then
    tidegap "$@"
  else
    "$_tidegap_cli_node" "$_tidegap_cli_main" "$@"
  fi
}
