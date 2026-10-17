# Tidegap for Mac

A menu bar app for the local `tidegap ui` server. It shows the next clean grid window and the active queue, lets you push a task **Later** (one hour later, tonight, tomorrow morning, after limit reset, each with its time), **Cancel** it or **Run now** from the row's menu (Cancel and Run now ask once), sends a notification when a task finishes or a clean window starts, and opens the full `tidegap ui` page in a window. It is a client of the API in [`docs/spec/ui-client-api.md`](../../docs/spec/ui-client-api.md) and never reads `queue.db`. It never creates tasks: your agent does. When tasks will not run (no tick daemon, no runner), a line under the header says why and how to fix it, and the menu bar text gets a `!` in front (`!3`).

Requirements: macOS 14 or later, Xcode 16 or later to build, and the `tidegap` CLI 0.19 or later (or a repo build, see below).

## Build and install

```sh
apps/macos/scripts/build.sh      # ad-hoc signed Release build in apps/macos/build/Tidegap.app
apps/macos/scripts/install.sh    # builds, quits a running copy, installs to ~/Applications, opens it
```

`INSTALL_DIR=/Applications apps/macos/scripts/install.sh` installs elsewhere. Arguments after `--` go to the app (see "Launch arguments").

The build is ad-hoc signed and not notarized. Gatekeeper does not check an app you built yourself. A copy downloaded from a CI artifact needs `xattr -dr com.apple.quarantine Tidegap.app` first.

## How it connects

1. It reads its client token from `~/Library/Application Support/Tidegap/client-token` (mode 0600). On first launch it runs `tidegap clients add --name "Tidegap for Mac" --kind macos --json` and stores the token.
2. It reads `~/.tidegap/ui.json`. If the pid there is alive, it uses that server and never stops it.
3. Otherwise it starts `tidegap ui --no-open` itself, and stops only that child on quit.
4. After a 401 (the token was revoked) it deletes the token and waits. Only **Reconnect** in the menu or in Settings creates a new one.

The page in the window gets the same client token, so the "Connected apps" panel is hidden there. Revoke the app from the page in a browser, or with `tidegap clients revoke <id>`.

## Use a repo build of the CLI

Before 0.19.0 is published, the global `tidegap` (0.18) has no `clients` command, and the app shows "Update tidegap to 0.19 or later". Point the app at a repo build instead:

```sh
pnpm install --frozen-lockfile && pnpm build
defaults write com.tidegap.mac tidegapCommand "node $PWD/packages/cli/dist/index.js"
```

Or type the same command in **Settings > tidegap > Command** and click **Apply and retry**. The command is split into arguments on spaces; quote a path with spaces. The app runs it without a shell, with your login shell's `PATH`.

A repo build still reports version 0.18.0 until the release, so the app accepts a lower version when `clients list --json` works.

## Launch arguments

| Argument | Effect |
|---|---|
| `--show-window` | opens the page window at launch |
| `-tidegapCommand "<argv>"` | the command for this run only (not saved) |
| `-port <n>` | the port of a server the app starts, for this run only |
| `-home <dir>` | uses `<dir>/.tidegap`, `<dir>/Library/Application Support/Tidegap` and `HOME=<dir>` for the child, so a test run never touches your real data |

Example of an isolated test run:

```sh
apps/macos/scripts/install.sh -- -home /tmp/tidegap-test -port 47931 \
  -tidegapCommand "node $PWD/packages/cli/dist/index.js" --show-window
```

## Notifications

The app asks for permission on its first connect. If you said no, turn it on in System Settings > Notifications > Tidegap. The menu bar works without it. Two toggles in Settings choose the events. A clean window is scheduled as one pending notification at its start; a "cleanest hour" fallback window never notifies.

## Safari extension

`Tidegap.app` embeds "Tidegap Safari Extension", the `safari` build of `apps/extension` (badge, popup with Later, Cancel and Run now). Safari has no notifications API for extensions, so the app's notifications cover Safari.

The build is ad-hoc signed, so Safari shows it only while unsigned extensions are allowed:

1. Install and open the app once (`apps/macos/scripts/install.sh`).
2. In Safari, turn on Settings > Advanced > "Show features for web developers".
3. Develop > Developer Settings… > "Allow unsigned extensions" (asks for your password).
4. Settings > Extensions: turn on Tidegap.
5. Open the Tidegap extension options from that pane, paste a client token (`tidegap clients add --name safari --kind extension`), and click Save. Allow access to 127.0.0.1 when Safari asks.

Safari turns "Allow unsigned extensions" off each time it quits, so repeat step 3 after every Safari launch. A persistent install needs a Developer ID build.

## Develop

```sh
swift test --package-path apps/macos/TidegapKit
xcodebuild -project apps/macos/Tidegap.xcodeproj -scheme Tidegap -configuration Release build
```

`scripts/build.sh` first runs `scripts/sync-safari-extension.sh`, which builds `apps/extension/dist/safari` with Node and copies it to `SafariExtension/Resources/` (gitignored). Run that script once before building in Xcode.

All logic lives in `TidegapKit` (discovery, launcher, token, API client, event stream, event derivation, formatting). The app target in `Tidegap/` is thin SwiftUI. The project uses a synchronized folder: a new file in `Tidegap/` joins the target without editing `project.pbxproj`. `Info.plist` and `Tidegap.entitlements` are membership exceptions, so they are not copied as resources.

`MARKETING_VERSION` in `Config/Base.xcconfig` follows the lockstep version; `pnpm check:versions` fails when it differs.

## Uninstall

```sh
osascript -e 'tell application id "com.tidegap.mac" to quit'
rm -rf ~/Applications/Tidegap.app ~/Library/"Application Support"/Tidegap
defaults delete com.tidegap.mac
tidegap clients list    # then: tidegap clients revoke <id>
```
