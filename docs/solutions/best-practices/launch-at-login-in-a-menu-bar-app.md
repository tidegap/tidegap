---
title: Launch at login in a menu bar app; offer once as a sheet, show every SMAppService status, test without real login items
date: 2026-10-30
category: best-practices
module: apps/macos/TidegapKit/Sources/TidegapKit/LaunchAtLogin.swift, apps/macos/Tidegap (TidegapApp.swift, StatusItemController.swift, SettingsView.swift, AppModel.swift)
problem_type: best_practice
component: tooling
severity: medium
applies_when:
  - "An LSUIElement (menu bar) app asks the user something at launch"
  - "Code registers the app with SMAppService.mainApp, reads its status or opens Login Items"
  - "A test must cover login-item or defaults behavior without touching the real ones"
  - "A script replaces an app bundle that may be registered as a login item"
tags: [macos, smappservice, login-item, launch-at-login, lsuielement, nsalert, sheet, sigterm]
---

# Launch at login in a menu bar app

## Context

The owner restarted the Mac. The launchd tick and channels daemons ran, the menu bar app did not. Launch at login (#107) was off by default, and it sat only in the right-click menu and in Settings, which are easy to miss. A menu click could fail without a word: the reason sat in `LaunchAtLogin.message`, which only Settings showed. PR #198 made the app ask once and made every login-item outcome visible.

## Guidance

### 1. The offer at launch is a sheet, never `runModal`

- Show it with `NSAlert.beginSheetModal(for:)` on the page window (`StatusItemController.offerLaunchAtLogin`). The app turns SIGTERM into `NSApp.terminate`, and an open `runModal` alert holds Quit and SIGTERM (`vetting-a-process-by-pid-before-signalling.md`, "SIGTERM quits like Quit"). An unanswered launch-time `runModal` would make `install.sh` escalate to SIGKILL, which skips `applicationWillTerminate` and leaves the `tidegap ui` server running. It can also hold a logout or a restart, which is the event this feature exists for.
- Record the answer only from the two buttons. Any other end of the sheet (the app quits) records nothing, so the next launch asks again. `answer(_:)` writes the flag first, then acts, so a failed `register()` is still an answer.
- `enabled` or `requiresApproval` at launch count as answered: write the flag, show nothing. `requiresApproval` means the user turned the item off in System Settings, which is a choice. There is no public API to tell a login launch from a manual one, and this rule makes it unnecessary: a login launch reads `enabled`.
- A `-home` launch (an isolated run) never offers and never writes the flag (`isolated: model.paths.homeOverride != nil`).
- Start a follow-up sheet (the approval hint, or the reason a call failed) on the next main-queue turn (`DispatchQueue.main.async`), after the first sheet has left the window. A success needs no sheet; the code relies on macOS to announce a new login item.
- The menu's own alerts stay `runModal` (KTD5). A click opens them and the user answers at once.

### 2. Map every status and show every outcome

| Status | Menu checkmark | Menu title | Click |
|---|---|---|---|
| `enabled` | on | Launch at login | `unregister()` |
| `notRegistered`, `notFound` | off | Launch at login | `register()` |
| `requiresApproval` | off | Launch at login (needs approval) | opens Login Items, calls nothing else |

- `LoginItemStatus.init(_: SMAppService.Status)` maps the four values. `@unknown default` reads as `notRegistered` (`LaunchAtLogin.swift:21`). Why that is honest: every path on it shows a result. The offer asks; a click calls `register()`; a call that leaves the item off says "Launch at login is still off. Check General > Login Items in System Settings." A fifth `.unknown` case would add a row to every switch, for a value that, per the review, no macOS from 14 to 26 returns.
- A click re-reads the state first (`menuClick()`), so the menu never acts on a stale value.
- A refused call always shows its reason: an alert from the menu, a sheet from the offer, a caption in Settings. A call that ends in `requiresApproval` shows the hint with **Open Login Items**, which calls `SMAppService.openSystemSettingsLoginItems()` through the service.
- Approval happens outside the app. Settings re-reads the state on `NSApplication.didBecomeActiveNotification` as well as on open. The menu re-reads it each time it opens.

### 3. Test without the real login items or defaults

- `LoginItemService` is a protocol with `status`, `register()`, `unregister()` and `openSystemSettings()`. `MainAppLoginItem` is the only real one. No view calls `SMAppService`; the app target does not import `ServiceManagement`.
- The offer's flag storage is injected: `isAnswered` and `markAnswered` closures. The app wires them to `UserDefaults.standard` under `launchAtLoginOffered`; tests pass a local object that also counts writes.
- `SMAppService` is named in one test only, `statusMapsEverySystemValue`. `SMAppService.Status(rawValue: 99)` builds an unknown value for the `@unknown default` row.
- `FakeLoginItem.statusAfterRegister` covers a `register()` that succeeds but leaves `requiresApproval` or `notRegistered`.
- Isolation checks that must print nothing (or the one mapping test): `grep -rn UserDefaults apps/macos/TidegapKit/Tests`, `grep -rn SMAppService apps/macos/TidegapKit/Tests`, `grep -rn SMAppService apps/macos/Tidegap`.

## Why This Matters

- A launch-time `runModal` breaks the scripts and the logout that depend on Quit and SIGTERM. The failure shows only when nobody answers the prompt, which is exactly the unattended case.
- A silent login-item failure looks like "the feature does not work". The user then has no path to System Settings and no reason to read.
- A test that calls the real `SMAppService` changes the developer's login items. A test that writes `UserDefaults` changes the app's real domain.

## When to Apply

- Any prompt an `LSUIElement` app shows without a user click, not only this offer.
- Any code that reads `SMAppService` status or calls `register()`.
- A reinstall script for an app that may be a login item.

## Examples

The offer decision, all in TidegapKit (`LaunchAtLoginOffer.isDue()`):

```swift
guard !isolated, !isAnswered() else { return false }   // -home, or answered before
launchAtLogin.refresh()
switch launchAtLogin.status {
case .enabled, .requiresApproval:                      // the user already chose
    markAnswered()
    return false
case .notRegistered, .notFound:
    return true
}
```

Tests: `LaunchAtLoginTests` (`statusMapsEverySystemValue`, `menuClickInApprovalOpensSystemSettingsOnly`, `menuClickReadsTheStateFirst`, `registerThatLeavesTheItemOffSaysSo`, and others) and `LaunchAtLoginOfferTests` (`isolatedLaunchNeverOffersNorWrites` for all four statuses, `requiresApprovalAtLaunchRecordsTheOfferWithoutAsking`, `refusedRegisterReturnsTheReasonAndStillRecords`, and others).

## Open

- **Does a registration survive `install.sh`?** Not known as of 2026-10-30. `install.sh` deletes `~/Applications/Tidegap.app` and copies a new ad-hoc build to the same path, with the same bundle id `com.tidegap.mac`. An ad-hoc build has no team identifier and gets a new signature on each build. It is not documented whether the login-item record follows the bundle id, the path or the signature. How to check, after launch at login is on:
  1. Run `apps/macos/scripts/install.sh` again (no `-home`).
  2. No offer sheet appears (`defaults read com.tidegap.mac launchAtLoginOffered` prints `1`).
  3. The right-click **Launch at login** has a checkmark, and Settings > App shows the toggle on. Both read `SMAppService.mainApp.status`, so this is the status after the reinstall.
  4. Restart and log in: the menu bar item appears without a click.
  A lost checkmark means the reinstall dropped the registration. Then the "register at every launch when the stored choice is on" option, rejected in the plan, needs a new look. Record the result here.
- **Quit with the offer sheet open** (plan U5 step 2): expected to go through, not yet checked on a real Mac.
- Settings re-reads the state when the app becomes active, which clears a failure line from an earlier toggle (review P3, not fixed). The toggle still shows the live state. A fix inside `refresh()` would make `menuClick()` return a stale line.
- `NSApp.activate(ignoringOtherApps:)` before the menu alerts is deprecated on macOS 14 (review P3, not fixed). It matches the other alerts in `StatusItemController`, and the build shows no warning from it.

## Related

- PR #198; plan `docs/plans/2026-10-30-1642-feat-macos-launch-at-login-plan.md`.
- `vetting-a-process-by-pid-before-signalling.md`: SIGTERM quits like Quit, and the `install.sh` stop sequence.
- `../logic-errors/login-shell-query-that-ignores-sigterm.md`: a login launch with a slow login shell.
