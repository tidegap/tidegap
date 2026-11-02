---
title: Dependency-free task UI (tidegap ui v2) — patterns that held up in review
date: 2026-10-15
category: best-practices
module: packages/cli/ui (api.js, state.js, app.js, keys.js, dnd.js, dom.js, region-card.js, usage.js, dispatcher.js, app.css, index.html), scripts/ui-seed.mjs, scripts/qa/ui-flows.mjs
problem_type: best_practice
component: frontend
severity: medium
last_updated: 2026-11-01
applies_when:
  - "Changing the tidegap ui front end (ES modules, no build step, no framework)"
  - "Adding a write action, a toast, a shortcut or a new view"
  - "Adding an edit form for a record that other clients can change (jobs)"
  - "Two async readers (a user action and a change event) write the same view state"
  - "A text input whose input handler, or any redraw while it has focus, rebuilds the tree that holds it"
  - "Writing a QA step or a test for a fix whose absence still produces a plausible result"
  - "Changing the page header, or any layout under 720 px"
  - "Giving a control a short text, an aria-label or a title"
  - "Writing a browser step that checks layout at a fixed window width"
  - "Budgeting header width, or putting a state word into a text that can end in an ellipsis"
tags: [frontend, optimistic-update, sse, undo, keyboard, dnd, tidegap-ui, jobs, stale-revision, focus, edit-form, read-sequence, read-only, vacuous-assertion, ime, composition, patch-in-place, caret, qa-assertion, narrow-width, flexbox, ellipsis, accessible-name, label-in-name, wcag, layout-qa]
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
- **A request that a held draw would show updates its own control (batch 27).** WebKit does not focus a clicked button, so a Save press can arrive while the composition is still open and `draw` returns early. `save()` returns at once while its request is in flight, and calls the form's `busy()`, which sets only Save's label and `disabled` and the form's `aria-busy`, when the request starts and when it settles. The rest of the card draws on `compositionend`, and a `compositionend` that commits text its input events already searched keeps a Save error.
- **Check each new text input for the same risk.** The guard is needed where the input's own handler, or any redraw that can fire while it has focus, replaces the input node. The region search was the first input whose own `input` handler rebuilt it.

Not fixed (#182 and #196 reviews):

- Only headless Chromium was checked. WebKit (Safari and the Mac app's `WKWebView`) orders composition and `input` events differently. Check once by hand with a Japanese or Chinese IME, committing with Enter.
- WebKit does not focus a clicked button, so in Safari and the Mac app the kept-node fix depends on the IME sending `compositionend` before the click (#196 review). The manual IME check above covers it.

Tests: `packages/cli/test/ui-region-card-live.test.ts` (input during a composition does not filter; a redraw from another source waits for `compositionend`; a missing `compositionend` ends on blur; a Save press and a select change that end a composition act on nodes that are still in the card; the select's options follow the query on the same select; two controls: blur with no composition keeps the Save error, plain typing filters at once and keeps the search node; batch 27: with a composition open, two presses send one request, a settled save shows "Save" again, a failed save enables Save and shows its error on `compositionend`). The fake DOM dispatches the events in one fixed order, and its `contains` does not model the tree, so a test walks the card tree to prove that a held node is still in it. QA: `ui-flows` S14.3 starts a composition through the DevTools protocol (`Input.imeSetComposition`) and presses Save with the mouse.

## Update 2026-11-01 (PR #216, the header under 720 px)

At 390 px with usage on, the header was 460 px wide in the QA browser and 474 px on a Mac. Apps and Settings sat past the window edge, the usage pill read "Claude limits · no…", and "Running · nothing can run" wrapped onto three lines outside its pill. The rules:

- **Two text spans per status pill; CSS picks one.** The `pill-long` span keeps the old id (`#usage-text`, `#dispatcher-text`); the `pill-short` span (`#usage-short`, `#dispatcher-short`) shows under 720 px; since #219, under 1,100 px (`packages/cli/ui/app.css:884`). A resize switches the text with no redraw; JS `matchMedia` was rejected, and the tests' fake DOM has none. The view models own both texts (`usageView` in `usage.js`, `dispatcherPill` in `dispatcher.js`). Each short text has at most 15 characters, and the title holds the long text (the readiness line when blocked).
- **Under 720 px the status pills shrink first.** A flex item does not shrink below its min-content width, so `.top-end` and both pills get `min-width: 0`, and `.pill-text` ends in an ellipsis only as a last resort. An empty flex item has an automatic minimum width of 0 and shrinks before any text: on `main` the 8 px dot shrank to 3.6 px. The dot, the brand, Apps and Settings get `flex: none`. Since #219 these rules hold under 1,280 px, and the tabs and the `?` button get `flex: none` too (`app.css:875-881`). A `max-width` cap on a text (the old 9em on `#usage-text`) cuts it at every width the query covers, not only at the width that was tested.
- **The brand shows its mark only under 480 px, with a target of 28 px or more.** `.brand-word` is hidden in the `max-width: 479px` block (`app.css:967`). The mark alone is 11 px high, so the link keeps `min-height: 32px` (the #216 review measured 32×11 px without it).
- **Width budget at 12 px, with the mark alone.** The two short texts together get about 145 px at 390 px and about 115 px at 360 px. "No reading" with "Blocked" needs about 105 px. The widest pair, "Limits reset" with "No dispatcher", ended in an ellipsis at 360 px; since #219 the `max-width: 399px` block (`app.css:974`) tightens the spacing, and the pair fits with about 16 px to spare. A new header control takes from this budget, so run S2.34 again.
- **Nothing changes at 720 px and wider.** The #216 review compared header pixels and boxes with `main` at 720, 900, 1,024 and 1,280 px, with the S2.34 fixture: identical. With usage on, the header at 720-1,100 px was still too wide (966 px at 900 px). #219 fixed it with width tiers under 1,280, 1,100 and 960 px (`app.css:875-907`); nothing changes at 1,280 px and wider.
- **The name contains the words the control shows (WCAG 2.5.3, label in name).** The first version put the long text in each pill's `aria-label`. Under 720 px the pill showed "Blocked" and was named "Running · nothing can run", so a voice command that says the shown word found no button (#216 review, P2). A `display: none` span is not part of the name, so with no `aria-label` the shown span names the button at each width. Keep the long text in `title`. An `aria-label` is right only when it contains the visible words ("Tidegap, Agenda" holds "Tidegap") or when the control shows only an icon (the Settings gear).

#219 (the header at 720-1,279 px) added two rules:

- **A width budget counts every header item, badges included.** The plan's estimate for 720-959 px left out the Journal unread count (28 px with one digit). With it, the S2.34 pair was 0.7 px too wide at 720 px. Narrower gaps from 720 to 1,279 px fixed it (`app.css:900`). Budget with the widest count the page can show: S2.34 runs again with 12 unread at 720 and 1,100 px.
- **A cue that an ellipsis can cut goes before the part that may be cut.** A stale reading first read "Claude 5h 72% · resets 16:30 · old". At 1,100 px, beside a ticking or blocked dispatcher, that text is about 16 px too wide (35 px for a weekly text with its weekday), and the ellipsis cut "old" first. Now it reads "Claude 5h 72% · old · resets 16:30" (`usage.js`). S2.37 fails at 1,100 px when "old" is cut. The word is there because a state must not show by the dot colour alone.

QA steps that check layout (`scripts/qa/ui-flows.mjs`):

- **Assert a layout value; a logged note is not a check.** S2.32 measured the page behind its dialog and only logged the width ("S2.25 owns the page width"). S2.25 passed because it runs with usage off, where the header needs about 335 px. So no step failed on the 460 px header. S2.32 now fails on the width.
- **Use the heaviest header the page can show.** `narrowHeaderPage` routes `/api/usage` to a no-reading document and replaces only `dispatcher` and `readiness` in the real `/api/status` with a running, blocked dispatcher; the page token shows Apps and Settings.
- **Measure against `innerWidth` at fixed widths** (`measureHeader`): `header.scrollWidth`, `document.scrollingElement.scrollWidth`, and the right edge of each rendered header element (1 px slack). For each pill: one line (span height at most 1.5 line heights), nothing outside the border (`scrollHeight <= clientHeight`), not cut (`scrollWidth <= clientWidth`, and since #219 the text's own width from a DOM Range against its box: the integer widths passed a 0.4 px overflow that already showed an ellipsis), the dot's width, and the name (`getByRole("button", { name, exact: true })`). S2.35 checks every view at 390 px: no rendered element past either window edge, unless a scrolling or clipping ancestor holds it.
- **Prove the step on the page without the fix.** `measureHeader` also reads a page without the new spans. With `main`'s page files, S2.34 and S2.35 failed: the header was 460 px wide at 360 and 390 px, Apps and Settings were past the edge, the dispatcher text drew outside its pill, and the dot was 3.6 px.
- **Match the breakpoint's edge.** The brand query is `max-width: 479px`, so 480 px is a wide width. The first brand-target check also ran at 480 px and failed in QA; it now runs under 480 px only.

Tests: `packages/cli/test/ui-dispatcher-age.test.ts` ("dispatcherPill": each state, short texts of 15 characters or less, each title), `ui-usage.test.ts` (the `short` of each pill state), `ui-server.test.ts` (the two spans per pill, the brand word's span, the brand link's name). QA: `ui-flows` S2.32, S2.34 (360, 390 and 480 px light, 390 px dark, 1,280 px; since #219, 17 widths from 360 to 1,440 px), S2.35, and since #219 S2.36 (the widest short pair) and S2.37 (the stale pill).
