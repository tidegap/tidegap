# Tidegap for Mac

A menu bar app for the local `tidegap ui` server. It opens the full `tidegap ui` page in a window, shows the queue next to the menu bar icon, and sends a notification when a task finishes or a clean window starts. It is a client of the API in [`docs/spec/ui-client-api.md`](../../docs/spec/ui-client-api.md) and never reads `queue.db`. It never creates tasks: your agent does. Later, Cancel and Run now live on the page.

## Menu bar item

- **Left click** (or the keyboard activation) opens the Tidegap window. A second click hides it when it is in front; when it is behind another app, the click brings it to front.
- **Right click** or **⌃-click** opens a menu: Open Tidegap, Integrations…, Settings…, Launch at login, Quit Tidegap.
- **Title.** Nothing next to the icon when nothing is queued and nothing runs. `3`: three tasks queued. `●`: a task runs; `● 2`: a task runs and two more wait. `!` in front (`!3`, `!` alone): tasks will not run (no tick daemon, no runner). `?`: no token (Reconnect in the window or Settings). `off`: no server.
- **Tooltip** (hover the icon): the clean window and region (`Clean 04:00-09:00 · US-MIDA-PJM`), the counts (`0 active · 1 unread`), the Claude limit line, and the reason tasks will not run. The window subtitle shows the clean window and the counts too. When the app is not connected, the window shows the state with Retry or Reconnect.

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
4. After a 401 (the token was revoked) it deletes the token and waits. Only **Reconnect** in the window or in Settings creates a new one.

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

## Launch at login

Off by default. Turn on **Settings > App > Launch at login** (or **Launch at login** in the right-click menu) to start the app when you log in. The toggle shows the state in System Settings > General > Login Items. If you turned Tidegap off there, the toggle stays off and a hint says to turn it on there; **Open Login Items** opens that page.

## Notifications

The app asks for permission on its first connect. If you said no, turn it on in System Settings > Notifications > Tidegap. The menu bar item works without it. Two toggles in Settings choose the events. A clean window is scheduled as one pending notification at its start; a "cleanest hour" fallback window never notifies.

## Telegram

**Integrations…** in the right-click menu opens the page window on Settings → Integrations. Connect Telegram there: paste a bot token from @BotFather, press Connect, then open the link or scan the QR code on the phone. The card shows the paired chat and whether the listener runs, and offers Send test message and Disconnect. The window uses this app's client token (kind `macos`), which may use the integrations routes; the browser and Safari extensions may not. See [Telegram](../../apps/web/content/docs/07-telegram.md).

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

All logic lives in `TidegapKit` (discovery, launcher, token, API client, event stream, event derivation, formatting). The app target in `Tidegap/` is thin: an AppKit status item (`StatusItemController`) and SwiftUI views for the window and Settings. The project uses a synchronized folder: a new file in `Tidegap/` joins the target without editing `project.pbxproj`. `Info.plist` and `Tidegap.entitlements` are membership exceptions, so they are not copied as resources.

`MARKETING_VERSION` in `Config/Base.xcconfig` follows the lockstep version; `pnpm check:versions` fails when it differs.

## Uninstall

```sh
osascript -e 'tell application id "com.tidegap.mac" to quit'
rm -rf ~/Applications/Tidegap.app ~/Library/"Application Support"/Tidegap
defaults delete com.tidegap.mac
tidegap clients list    # then: tidegap clients revoke <id>
```
