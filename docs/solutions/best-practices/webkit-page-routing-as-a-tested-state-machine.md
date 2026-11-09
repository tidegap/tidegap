---
title: "WKWebView view routing: put the decisions in a pure state machine in TidegapKit, and know the four WebKit orders that break a hash set"
date: 2026-11-09
category: best-practices
module: apps/macos/TidegapKit/Sources/TidegapKit/PageRouting.swift, apps/macos/Tidegap/WebPageWindow.swift
problem_type: best_practice
component: tooling
severity: medium
applies_when:
  - "The Mac app page window must open a view (a menu item, a restored view after a reload, a new link)"
  - "Code sets location.hash or runs evaluateJavaScript on a WKWebView page that can be loading or reloading"
  - "A WebKit delegate callback decides what the app does next"
tags: [macos, wkwebview, webkit, state-machine, location-hash, readystate, swift-testing, page-window]
---

# WKWebView view routing as a tested state machine

## Context

The page window opens a view by setting `#/<view>` on the local UI page. Before #243 the coordinator decided inline, in the WebKit delegate methods, when a view request counted as done. A request that came during a reload was lost, and no test could reach the order of events that lost it. #243 moved every decision into `PageRouting`, a value type in `TidegapKit`. The coordinator forwards each WebKit event (`finished`, `failed(cancelled:)`, `freshLink`, `request`, `hashResult`) and runs the actions that come back (`load`, `setHash`, `report`). `PageRoutingTests.swift` drives the event orders with no web view.

The review of #243 still found three P2 defects. Each one was a WebKit order the first state machine did not model. The code comments name the rules; this doc keeps why each one exists.

## Guidance

- **Model the WebKit events as inputs, not the web view as state.** A request is `(id, view)`, plain values, because `PageView` is an app-target type. The id tells a repeated request from the last one, so the same menu item twice sets the hash twice. Write one test per order: request during a load, request after a fresh link, cancelled load, failed load, error page, failed script call.
- **`didFinish` can come before the page's module script ran.** A hash set then replaces `#token=`, and the page boots without its token. So `setHash` sets the hash at once only when the address has no `#token=`; otherwise it waits for `DOMContentLoaded`.
- **Test `readyState === 'complete'`, not `!== 'loading'`.** At `interactive` the module script may not have run yet. The first version returned `reload` there, added no listener, and the hash was never set (#243 review). Only a complete document that still shows `#token=` reloads itself for the new link, and `setHash` returns `reload`.
- **A fragment-only load reaches the page late.** WebKit's policy check for a new `#token=` link is asynchronous. A `setHash` that runs right after the load call runs on the old page and returns `set`; then the page reloads for the link and the view is gone (#243 review). `PageRouting` keeps a `freshLoad` flag: a request waits for the fresh link's finish or failure.
- **A server error page has no script.** It never reloads for a new link, so `reload` from it would keep a request pending forever (#243 review). The coordinator reads the main-frame status in `decidePolicyFor navigationResponse`; on an error page a pending request is reported, `reload` counts as set, and a restored view is dropped.
- **A restored view belongs to one load (plan KTD4).** It is set for the fresh link that replaced a reload and dropped at that load's finish or failure. A cancelled load drops nothing: WebKit cancels a load only for a newer one (a port change, another fresh link), and that load replaces or applies both the restored view and a pending request. The plan said to drop the view on a cancel with no newer load; the review accepted the simpler rule because that case does not occur.
- **A failed script call counts as `set`**, so a request never sticks (KTD3; the review kept this on purpose).

## Why This Matters

Each of these orders depends on timing inside WebKit, so a manual check passes most of the time. Only a unit test of the order holds the rule, and only if the decisions sit outside the delegate methods. A new view source (a notification click, a URL scheme) goes through `PageRouting.request`; it needs no new WebKit code.

## When to Apply

- A change to `WebPageWindow.swift`'s coordinator or its `setHash` script.
- A new way to open a page view in the Mac app.
- Any other app that drives a `WKWebView` page whose script reads its own fragment.

## Related

`../../spec/ui-client-api.md` ("Embedding the page": the link, the reload rule, `expired`), `client-tokens-and-extension-origins.md` (a view request is an event, not state), `loopback-web-ui-hardening.md`.
