#!/bin/sh
# Installs this checkout's CLI build into the runtime that the launchd units
# run, then restarts the channels listener. The tick is started, never killed.
#   apps/macos/scripts/sync-runtime.sh [runtime-dir]
# The runtime dir is the argument, else TIDEGAP_RUNTIME_DIR, else
# ~/.tidegap/runtime. Under it the script reads only cli/package.json and
# cli/node_modules/@tidegap/core/package.json. It writes only cli/dist, cli/ui
# and the dist and package.json of cli/node_modules/@tidegap/core.
#
# It refuses, with nothing written and nothing built, when the runtime is
# missing, or when the repo and the runtime differ in a dependency, an optional
# dependency or a peer dependency: only first-party code is synced, so a
# dependency change needs a full reinstall of the runtime. devDependencies and
# the @tidegap/core entry (workspace:* in the repo) are not compared.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
root="${1:-${TIDEGAP_RUNTIME_DIR:-$HOME/.tidegap/runtime}}"
cli="$root/cli"
core="$cli/node_modules/@tidegap/core"

fail() {
  echo "sync-runtime: $*" >&2
  exit 1
}

[ -d "$cli" ] || fail "no runtime at $cli; install the runtime first"
[ -d "$core" ] || fail "no $core; the runtime is incomplete, reinstall it"
# Absolute from here, so the unit check below cannot match another runtime with the same tail.
cli="$(cd "$cli" && pwd)"
core="$cli/node_modules/@tidegap/core"

node - "$repo/packages/cli/package.json" "$cli/package.json" \
  "$repo/packages/core-ts/package.json" "$core/package.json" <<'JS'
const { readFileSync } = require("node:fs");
const FIELDS = ["dependencies", "optionalDependencies", "peerDependencies"];
const read = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    console.error(`sync-runtime: cannot read ${file}: ${error.message}`);
    process.exit(1);
  }
};
const files = process.argv.slice(2);
const drift = [];
for (let i = 0; i < files.length; i += 2) {
  const [repo, runtime] = [read(files[i]), read(files[i + 1])];
  for (const field of FIELDS) {
    const a = { ...repo[field] };
    const b = { ...runtime[field] };
    delete a["@tidegap/core"];
    delete b["@tidegap/core"];
    for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (a[name] !== b[name]) drift.push(`${name} (${field}): repo ${a[name] ?? "none"}, runtime ${b[name] ?? "none"} in ${files[i + 1]}`);
    }
  }
}
if (drift.length > 0) {
  console.error("sync-runtime: the runtime's dependencies differ from the repo; reinstall the runtime instead:");
  for (const line of drift) console.error(`  ${line}`);
  process.exit(1);
}
JS

commit="$(git -C "$repo" rev-parse --short HEAD)"
if [ -n "$(git -C "$repo" status --porcelain -- packages/cli packages/core-ts)" ]; then
  commit="$commit-dirty"
fi

echo "build: @tidegap/core and @tidegap/cli at $commit"
(cd "$repo" && pnpm --filter @tidegap/core --filter @tidegap/cli build)

rsync -a --delete "$repo/packages/cli/dist/" "$cli/dist/"
rsync -a --delete "$repo/packages/cli/ui/" "$cli/ui/"
rsync -a --delete "$repo/packages/core-ts/dist/" "$core/dist/"
rsync -a "$repo/packages/core-ts/package.json" "$core/package.json"
echo "synced: cli/dist, cli/ui, @tidegap/core dist and package.json into $cli"

# The units name the entry by its real path (tidegap install resolves it).
cli_real="$(cd "$cli" && pwd -P)"
uid="$(id -u)"
status=0
for label in com.tidegap.channels com.tidegap.tick; do
  target="gui/$uid/$label"
  if ! info="$(launchctl print "$target" 2>/dev/null)"; then
    echo "$label: not loaded, skipped"
    continue
  fi
  case "$info" in
    *"$cli/"* | *"$cli_real/"*) ;;
    *) echo "warning: $label does not run $cli; it runs another tidegap" >&2 ;;
  esac
  if [ "$label" = com.tidegap.channels ]; then
    # -k: the KeepAlive listener holds the old code until it restarts.
    if launchctl kickstart -k "$target"; then
      echo "$label: restarted"
    else
      # Not fatal at once: the code is synced, so start the tick and report, then exit 1.
      echo "sync-runtime: launchctl kickstart -k $target failed; the listener still runs the old code" >&2
      status=1
    fi
  elif launchctl kickstart "$target"; then
    # No -k: it would SIGTERM a tick in flight. A one-shot tick loads the new code on its next run.
    echo "$label: started"
  else
    echo "warning: launchctl kickstart $target failed; its next run loads the new code" >&2
  fi
done

echo "synced commit: $commit"
echo "page server: a running tidegap ui keeps the old API code and its old list of page files; it reads those files from cli/ui on each request."
echo "  Quit and reopen the Mac app to get a server on the new build: a sync keeps the version, so the app does not replace the server by itself."
exit "$status"
