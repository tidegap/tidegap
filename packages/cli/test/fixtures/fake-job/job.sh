#!/bin/sh
# Fake job command for tests. Flags, applied in order:
#   --bytes N        print N bytes of "x" to stdout
#   --env NAME       print "NAME=<value>" of an environment variable
#   --stderr TEXT    print TEXT to stderr
#   --bg PIDFILE     start a background `sleep 30` and write its pid to PIDFILE
#   --pid PIDFILE    write this shell's pid to PIDFILE
#   --sleep S        sleep S seconds
#   --exit C         exit with code C
while [ $# -gt 0 ]; do
  case $1 in
    --bytes) head -c "$2" /dev/zero | tr '\0' x; shift 2 ;;
    --env) eval "v=\${$2-}"; printf '%s=%s\n' "$2" "$v"; shift 2 ;;
    --stderr) printf '%s\n' "$2" >&2; shift 2 ;;
    --bg) sleep 30 & echo $! > "$2"; shift 2 ;;
    --pid) echo $$ > "$2"; shift 2 ;;
    --sleep) sleep "$2"; shift 2 ;;
    --exit) exit "$2" ;;
    *) echo "job.sh: unknown flag $1" >&2; exit 2 ;;
  esac
done
exit 0
