---
title: Dependency-free task UI (tidegap ui v2) — patterns that held up in review
date: 2026-10-15
category: best-practices
module: packages/cli/ui (api.js, state.js, app.js, keys.js, dnd.js, dom.js, region-card.js), scripts/ui-seed.mjs
problem_type: best_practice
component: frontend
severity: medium
last_updated: 2026-10-30
applies_when:
  - "Changing the tidegap ui front end (ES modules, no build step, no framework)"
  - "Adding a write action, a toast, a shortcut or a new view"
  - "Adding an edit form for a record that other clients can change (jobs)"
  - "Two async readers (a user action and a change event) write the same view state"
  - "A text input whose input handler, or any redraw while it has focus, rebuilds the tree that holds it"
  - "Writing a QA step or a test for a fix whose absence still produces a plausible result"
tags: [frontend, optimistic-update, sse, undo, keyboard, dnd, tidegap-ui, jobs, stale-revision, focus, edit-form, read-sequence, read-only, vacuous-assertion, ime, composition, patch-in-place, caret, qa-assertion]
---

# Dependency-free task UI patterns

PR #49 (ui v2) shipped about 3,200 lines of plain ES modules. Review found a bug in each place
where one of these patterns was missing. Server-side rules live in `loopback-web-ui-hardening.md`.

## Rules

- **Render with text nodes only.** `dom.js` `h()` appends strings as `document.createTextNode`.
  Task text never reaches HTML. `ui-server.test.ts` reads every file in `packages/cli/ui` and fails on
  `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval(`, `new Function`,
  `setAttribute("style"`, and on `localStorage`, `sessionStorage`, `document.cookie`, `indexedDB`.
  The browser-storage ban was added in review. Add a new forbidden API to that test, not to a comment.
- **Token lives in module memory.** `boot()` reads `#token=...` from the URL fragment into `api.js`
  (`setToken`). No storage. A reload without the fragment gives `SessionExpired` and the page says to run `tidegap ui` again.
- **Optimistic update = an "op" patch applied at read time** (`state.perform`). A refresh that lands
  before the server has the change cannot flash old state back. Keep the patch until the change
  stream names the task and a re-fetch shows the new state (`confirmOps`; a 5 s timer re-fetches
  if the stream is down). A failed refresh says nothing about the write, so it keeps the patch.
- **Roll back on error and show the server's reason.** 409 and 400 show `err.message` (the core's
  one-line rule, for example "Start dispatcher" refusals). Any other status shows a fixed text,
  and a network error says "nothing changed". Never show exception text.
- **Undo = a deferred request** (`cancelWithUndo`). The row looks cancelled at once. The POST goes out
  when the 5 s toast expires. Undo deletes the patch and sends nothing, so there is nothing to
  reverse on the server. On `pagehide` all delayed cancels flush with `keepalive: true`.
  Do not keep an Undo toast or an optimistic look for an op that already settled (fixed in `97f5ba9`).
- **One press, one action.** `keys.js` returns on `e.repeat`; holding `c` must not cancel row
  after row as focus moves. Reply send ignores a repeated Cmd/Ctrl+Enter and disables the button
  while in flight. `startDispatcher` disables its button and re-enables it in `finally`.
- **SSE through `fetch`, not `EventSource`** (the Authorization header is needed). On a drop:
  mark disconnected, wait `delay`, double it up to 30 s, reconnect. A `hello` event after a
  reconnect triggers `refresh()`, because changes made while the stream was down emit no event.
- **Cheap re-render for a long list.** The view is rebuilt as a detached tree, then dropped if
  `isEqualNode` matches the live one (`app.js`), so the stream firing on every tick does not
  destroy hover or a click in flight. `swapChildren` does the same for the banner and drawer.
  This is whole-tree compare, not per-row keys. It was enough for the 200-row seed. If a
  list outgrows it, add keys keyed by `task_id`; do not add a framework first.
- **Drag and drop has two other paths.** DnD (`dnd.js`) moves a task to a day. The same move is
  reachable by the `m` key and by the row "⋯" menu, both opening the move-to list in `dialog.js`.
  Touch uses the menu; touch targets are `--touch: 44px`. A drop label names a weekday once
  (`Moved to Sat 17 Oct`, `0a42730`).
- **Look up renderers by own key.** `Object.hasOwn(VIEWS, name)` before calling, because the name
  comes from `location.hash` (CodeQL `js/unvalidated-dynamic-method-call`, `94c7d98`).
- **Seed script refuses real ledgers.** `scripts/ui-seed.mjs` writes throwaway prompts that a
  running dispatcher would send to a provider. `--db` must name a new file outside `~/.tidegap` and the 0.17
  `~/.ebb-ai`; an existing file or a path inside either folder exits 1. Default is a temp dir.

## Why it matters

Each rule above came from a review finding or a CodeQL alert, not from design. The cost of
missing one is a cancelled task nobody asked to cancel, a lost token, or seed prompts sent to a provider.

## Update 2026-10-26 (PR #158, Jobs view and job form)

The first edit form on the page. Review found a lost update and several focus bugs. The rules:

- **Reload after a 409 keeps only what the user typed.** `reloadForm` (`packages/cli/ui/job-form.js:209`) takes the fresh revision and baseline. A field the user changed keeps the typed value; every other field takes the fresh value. The first version kept all form values, so Save after Reload sent back the old text of fields another writer had changed. The patch is the diff against the fresh baseline, so it holds only the typed fields (a changed template field sends the whole template).
- **Key on an error code, not on a sentence.** The stale-revision 409 carries `code: "stale_revision"` (`packages/cli/src/ui/jobs-api.ts:573`, documented in `docs/spec/ui-client-api.md`). The form shows Reload only for that code (`job-form.js:425`). The core's own compare-and-set conflict ("changed meanwhile; try again") has no code: Save again, then the code appears.
- **A dirty form ignores refreshes; a clean form follows them.** `refreshForm` returns a dirty form unchanged (typed values, old revision; Save then gets the 409). A clean form takes the fresh job, rebuilds the drawer (an input's `value` property does not follow a changed `value` attribute) and runs the preview again so "First run" matches the new schedule.
- **Restore focus after a structural re-render.** `render()` remembers the focused Jobs-row control by `data-action` or link and puts focus back on it, or on the row's title link when the control is gone or disabled (`app.js:196-215`). Form controls have stable ids (`jf-day-<d>`, `<name>-<value>`); a `jf-` control that disappears hands focus to `#jf-title`.
- **Job changes arrive as task ids.** The change stream names occurrence ids (`<job>~<seq>`, `r` for the retry). The view maps them back to the job and refetches. See `../logic-errors/floating-jobs-occurrence-sweep.md`, "Rules for clients", which also covers the retry label.
- **Leaving during Save puts the route back** with `history.replaceState`, so Cancel and Esc still work when the save answers. A refused read-only route redirects with `location.replace`, so Back does not loop.
- **A failed preview offers Retry.** Otherwise a 429 or a network error locked Save until a schedule field changed.

Tests: `packages/cli/test/ui-job-form-controller.test.ts` (409, Reload, refresh on dirty and clean forms) and `ui-jobs-actions.test.ts` (optimistic row actions, rollback, stale-answer guard).

## Update 2026-10-27 (PR #169, jobs page follow-ups)

Review of #169 found a read race, two API-state edges and a test that could not fail, and named the hand-written list-sequence bumps as a risk. The rules:

- **The route answers a visibly stale revision first; core covers the race.** `POST /api/jobs/<id>/update` returns 409 `stale_revision` when `body.revision` differs from the stored job, before it parses the patch (`packages/cli/src/ui/jobs-api.ts:611`). Then it passes the revision to `updateJob(..., { expectedRevision })`, which checks inside the compare-and-set. With the core check alone, a stale partial patch was parsed against the newer job first: after another writer switched the runner, a client got 400 "a prompt job has no command" and had no way to recover by re-reading. The page sends the whole template, so only other clients hit this. Why `stale_revision` is a `reason` and not a `code`: `../logic-errors/floating-jobs-occurrence-sweep.md`, rule 9. `refusal()` forwards any `reason` as the body `code`, so a new reason needs a `docs/spec/ui-client-api.md` entry first.
- **One helper for every local list write.** `setJobs` in `packages/cli/ui/jobs.js` bumps the list sequence and writes the list, so a `loadJobs` answer that started before the write is dropped. The first version wrote `seq++` by hand before each of four writes; one success path bumped twice, and a writer that forgets the line brings back the stale overwrite. Known cost: a local write also drops an in-flight list load; the next jobs event heals it, but a dropped first load keeps the skeleton until then (`setJobs` does not set `loaded`; only `loadJobs` does).
- **A background read must not cancel a read the user started.** Form reads (open, job event, Reload) share `form.readSeq`. A jobs event during Reload bumped it, Reload dropped its answer, and the event's answer was ignored because the form was dirty: the 409 line stayed and the user had to click Reload again. The 2 s events poll made this reachable, on the same 409-then-Reload path that QA step S15.9 drives. Now `form.reloading` makes `onJobFormEvent` skip its read (`packages/cli/ui/job-form.js:389`). When two readers share a sequence, the reader the user started wins.
- **A "waiting until" field checks that the row still waits.** `next_run.deferred_until` is the `retry_at` of the newest `deferred` event only while the row's `notBefore` still equals it (`deferredUntil` in `jobs-api.ts`). Run now clears `notBefore` and records `expedited`, not `dispatched`, so a rule that read the events alone kept "deferred until 07:00" on the row after Run now, while the toast said "next tick".
- **Read-only comes from server state, and so does the loading state.** A job with status `removed`, a 404 on a job event, or `actions.edit: false` opens the form read-only: a `role="status"` notice, fields and Save disabled, Remove hidden, typed text kept, and Close leaves without a Discard question. The form shows a loading shell until the author probe answers; a probe error shows a fixed line and no fields, so a read-only token never sees an editable form.
- **A dot-only job id never reaches `/api/`.** `jobRoute` decodes the hash segment and treats `.`, `..` or `..%2F` as unknown, so the list opens instead of a request to `/api/jobs/..`.
- **Assert that an element is absent, not that an attribute is empty.** The first read-only test checked `removeButton()?.attrs.disabled ?? ""` against `""`. That holds when the button is absent and also when it is present and enabled, and every fixture also set `actions.remove: false`, so the new read-only term never decided the outcome. Assert `expect(removeButton()).toBeUndefined()`, and add a fixture where only the term under test hides the button (`actions.remove: true` on a removed job, and with `actions.edit: false`).

Tests: `packages/cli/test/ui-job-form-controller.test.ts` ("a job event during Reload does not drop the Reload answer", "a read-only form hides Remove even when the answer still allows it"), `ui-jobs-api.test.ts` (stale partial patch gets 409; Run now clears `deferred_until`). QA: `ui-flows` S15.9-S15.12; `pnpm qa ui` runs alone.

## Update 2026-10-28 (PR #182, an input method in the region search)

The region search filters on each `input` event, and a filter draws the card (`draw` in `packages/cli/ui/region-card.js`). Before batch 25 a draw rebuilt every node, the search too. While an input method (IME) composes, a rebuild of the search ends the composition, so Japanese, Chinese or Korean text could not be typed. The rules:

- **No rebuild while an IME composes in a live input.** `compositionstart` sets `composing`, and `draw()` returns at once while it is set, whatever asked for the redraw (a filter, a load answer, a Save answer). Handlers still write the state; only the redraw waits. `compositionend` clears the flag and runs the filter with the committed text, which draws the latest state.
- **Give the composition a second exit.** Some input methods never send `compositionend`. The flag then stayed set, and the card stopped drawing until Settings was opened again (#182 review). A `blur` of the search ends an open composition and runs the filter. A blur with no open composition does nothing, so it keeps a shown Save error.
- **Keep the pressed nodes across a draw (batch 25).** A press on the select or on Save that ends a composition runs `blur` and `compositionend` before its `click`. When those handlers rebuilt the card, the click landed on a detached node and the press did nothing. Now `regionForm` builds the search, the select and Save once per ready card, and `draw` patches them in place: `disabled`, the select's options and value, the Save label, the no-match line, `aria-describedby`. Only the nodes around the form are rebuilt. A switch between loading, error and ready rebuilds everything. Submit reads the model of the last patch, so Save saves the zone that the form shows when the click lands. A deferred draw was rejected: a pointer held down past the delay still lands on a replaced node, and a native select popup outlives the pointer. Korean input chains compositions; each `compositionend` now patches the search and does not replace it.
- **Patch a kept node only where the value differs.** `patch` writes `search.value` only when the model's query differs, so the caret stays where the user types; the old focus and caret restore after each rebuild is gone. The select's options are replaced only when the list or the selection changes, so a Save and its error keep the option nodes. Each such line has a test that fails under a one-line mutation of `patch` (#196 review).
- **A QA step must fail when the fix is missing.** The first S14.3 checked that one press saved a zone. With the composition lost, the form would still show FR, Save would save FR, and the step would pass (#196 review). S14.3 now records the select's value at `submit`, composes "germ", which matches only Germany, and requires DE. Choose an input whose correct result differs from the result without the fix.
- **Check each new text input for the same risk.** The guard is needed where the input's own handler, or any redraw that can fire while it has focus, replaces the input node. The region search was the first input whose own `input` handler rebuilt it.

Not fixed (#182 and #196 reviews):

- Only headless Chromium was checked. WebKit (Safari and the Mac app's `WKWebView`) orders composition and `input` events differently. Check once by hand with a Japanese or Chinese IME, committing with Enter.
- WebKit does not focus a clicked button, so in Safari and the Mac app the kept-node fix depends on the IME sending `compositionend` before the click (#196 review). The manual IME check above covers it.
- Older than batch 25 (#196 review): a Save pressed while a composition is still open runs while `draw` returns early. The card shows no "Saving…", Save stays enabled, and a second press sends a second request.

Tests: `packages/cli/test/ui-region-card-live.test.ts` (input during a composition does not filter; a redraw from another source waits for `compositionend`; a missing `compositionend` ends on blur; a Save press and a select change that end a composition act on nodes that are still in the card; the select's options follow the query on the same select; two controls: blur with no composition keeps the Save error, plain typing filters at once and keeps the search node). The fake DOM dispatches the events in one fixed order, and its `contains` does not model the tree, so a test walks the card tree to prove that a held node is still in it. QA: `ui-flows` S14.3 starts a composition through the DevTools protocol (`Input.imeSetComposition`) and presses Save with the mouse.
