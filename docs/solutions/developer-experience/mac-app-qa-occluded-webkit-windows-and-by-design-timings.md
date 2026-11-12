---
title: "Mac app QA: an occluded WKWebView window does not paint, a server replace takes 60-120 s by design, and two other false FAILs"
date: 2026-11-12
category: developer-experience
module: apps/macos/Tidegap (WebPageWindow, AppModel, TidegapApp, StatusItemController), apps/macos/TidegapKit (Connection, EventStream)
problem_type: developer_experience
component: testing
severity: medium
applies_when:
  - "An agent drives the Mac app in the background (accessibility actions, keys sent without activating the app)"
  - "A QA brief judges the page window by its accessibility tree or a screen capture"
  - "A QA brief sets a time limit for the app to reconnect after the UI server is replaced"
  - "A QA check reads the app menus or the menu bar status item through accessibility"
tags: [macos, qa, wkwebview, webkit, occlusion, axwebarea, accessibility, unified-log, reconnect, status-item, menus]
---

# Mac app QA: occluded WebKit windows, by-design timings, menus

## Context

A live QA pass on the Mac app reported a FAIL: after the UI server was replaced, the page window was blank and its accessibility tree had no `AXWebArea`. That looks like a lost web view. A debug run (about 230k tokens, with unified-log proof and its own app instance) showed it is not a defect. The same pass also had three wrong expectations in its brief. Each item below is by design; none needs a product fix.

## Guidance

### 1. An occluded WKWebView window does not paint

- A driver that works in the background (accessibility actions, keys without activation) leaves the page window covered by other windows.
- After a server replace the app builds a fresh web view. The page loads (`didFinish`). WebKit then hides the content until the next update and suspends the web process while the window is occluded.
- Result: a blank window with no `AXWebArea`. Bring the window to the front and it paints within about 100 ms.
- **Rule for QA briefs:** bring the window to the front before every judgement or capture. "No `AXWebArea` while the window is not frontmost" is not a finding.
- Screen capture can be denied to an agent. Then the unified log is the proof:

  ```sh
  log show --last 10m --predicate 'process == "Tidegap"' | grep -E 'occluded|hideContentUntilPendingUpdate|didFinish'
  ```

  The lines `occluded 1`, `hideContentUntilPendingUpdate` and `didFinish` together mean "loaded, waiting to paint".

### 2. A server replace takes 60-120 s to show, by design

- `AppModel.start` (`apps/macos/Tidegap/AppModel.swift`) polls every 60 s.
- `ConnectionController.refreshOnce` (`apps/macos/TidegapKit/Sources/TidegapKit/Connection.swift`) attaches again only after two failed polls in a row (`failedPolls >= 2`). The native clients plan (`docs/plans/2026-10-17-0647-feat-native-clients-plan.md`, U14 test scenarios) specifies "after two failed polls".
- A dropped event stream only backs off and retries (`EventStream.swift`, the `catch` branch). It never triggers a poll. `updateStream` stops the stream while the state is not connected.
- So the app shows the new server one to two poll intervals after the old one stops. A QA brief that expects 20 s or less is wrong.
- A product change (poll at once when the stream drops) is a candidate for the backlog, not a bug fix.

### 3. There are two "View" menus

- SwiftUI adds its own View menu, without Reload. `addMissingEditMenus` (`apps/macos/Tidegap/TidegapApp.swift`) adds a second View menu with Reload (Cmd-R), because the SwiftUI one has no `WKWebView.reload(_:)` action.
- An accessibility read that stops at the first "View" reports Reload as missing. Search every top-level menu for the Reload item.

### 4. The status item menu opens on a right click or Control-click

- `StatusItemController.clicked` (`apps/macos/Tidegap/StatusItemController.swift`) opens the menu on `.rightMouseUp` or a Control modifier. A left click toggles the page window.
- `AXShowMenu` on the status item fails (error -25206). Send a right click instead.

## Why This Matters

Each item produced a FAIL that cost a debug run or a re-check. A brief that names these behaviors as by design keeps a cheap QA model from reporting them, and keeps the next debug run from re-proving them.

## When to Apply

- Writing or reviewing a QA brief for the Mac app.
- Judging a blank page window, a slow reconnect, or a missing menu item in a QA report.
- Changing the poll interval, the re-attach rule or the menus: update this doc and the briefs that quote it.

## Related

- `../best-practices/webkit-page-routing-as-a-tested-state-machine.md`: the WebKit delegate orders behind the page window.
- `../best-practices/launch-at-login-in-a-menu-bar-app.md`: other menu bar app behavior.
