---
title: Settings - Grid region - Plan
type: feat
date: 2026-10-19
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Settings - Grid region - Plan

## Goal Capsule

- **Objective:** a Tidegap user sees which grid region Tidegap uses and why, and changes it once, in the page, the Mac app or the CLI. Every surface (ui, tick, queue, Telegram listener, MCP server, OpenClaw plugin, Mac app, extension) then uses that region.
- **Means:** one persisted key `TIDEGAP_DEFAULT_REGION` in `~/.tidegap/config` (KTD1), one resolver in `packages/core-ts/src/region.ts` with a fixed precedence (KTD2), a region catalog in the data SSOT (KTD4), a Settings → "Grid region" card and a `tidegap region` command over one shared module (KTD6, KTD7).
- **Authority:** owner report (Vitalii, 2026-10-19: saw `US-MIDA-PJM` and asked why) and the brief of the same day → this plan's R-IDs → KTDs → units. `docs/solutions/best-practices/shared-setup-module-for-cli-and-local-settings-api.md`, `loopback-web-ui-hardening.md`, `client-tokens-and-extension-origins.md` and `dependency-free-task-ui-patterns.md` stay binding.
- **Stop conditions:**
  - The ENTSO-E A75 answer for `10YPL-AREA-----S` has a shape the existing ENTSO-E parser does not read: drop KTD9 (PL stays on Electricity Maps or the mock) and report.
  - A design that lets an extension origin write the region: stop and report.
- **Execution profile:** starts after the channels S2 stream merges (shared file `packages/cli/src/commands/tick.ts`; S2 also owns `packages/cli/src/channels/serve.ts`, which this plan does not touch). One branch `feat/region-setting`, one PR, one review pass. Opus implements, Sonnet simplifies, Haiku runs gates and QA. Never merge.

---

## Product Contract

### Summary

Tidegap gets one region setting. The page shows a "Grid region" card in Settings with a searchable list of the 31 supported zones, the current zone, where it came from, and an "Auto-detect" button. The CLI gets `tidegap region show | set <zone> | detect | list`. A time-zone guess that is only approximate (Kyiv → PL) says so and links to a region request on GitHub.

### Problem Frame

`tidegap ui` and `tidegap tick` pick the region only from `--region` or a time-zone guess, else `GB`. `TIDEGAP_DEFAULT_REGION` works only in the MCP server; the OpenClaw plugin has its own `defaultRegion`. The Mac app starts `tidegap ui --no-open` with no `--region`, so a Mac user has no way to set it. No screen shows the region source. The TZ map has 7 entries and no `Europe/Kyiv`; there is no `UA` zone. A user who sees a wrong zone cannot tell where it came from or fix it.

### Requirements

**Setting and precedence**

- R1. One persisted region setting is stored on this machine and read by every Tidegap process on it.
- R2. Every surface resolves the region with the precedence in KTD2 and reports the source: `flag`, `env`, `setting`, `timezone`, `fallback` (OpenClaw: `config` in place of `env`).
- R3. A running `tidegap ui`, `tick --daemon`, Telegram listener and MCP server use a changed setting on their next request or tick, with no restart.
- R4. `TIDEGAP_DEFAULT_REGION` in the environment keeps working for the MCP server, and now also for the CLI.

**Page and Mac app**

- R5. Settings shows a "Grid region" card above Integrations: current zone name and code, the source in one sentence, and the data source of that zone.
- R6. The card has a searchable select of the 31 catalog zones. Each option shows name, country, grid operator and data source. Typing filters by any of these and by zone code.
- R7. "Auto-detect" clears the stored setting, so the time-zone guess applies again; the card shows the guessed zone and the time zone it came from.
- R8. When the guess is approximate or fell back to GB, the card shows a note and a "Request your region" link to a prefilled GitHub issue.
- R9. When `TIDEGAP_DEFAULT_REGION` is set in the environment (or `~/.config/tidegap/env`), the card shows "Set by TIDEGAP_DEFAULT_REGION" and the select is disabled.
- R10. The Mac app reaches the card through its existing Settings page; it needs no launch flag.

**CLI**

- R11. `tidegap region show` prints zone, name, source and data source; `--json` prints the same as one object.
- R12. `tidegap region set <zone>` accepts only a catalog zone (case-insensitive), stores it, and prints the new resolution; an unknown zone exits 2 with at most 3 closest matches and the request link. Match order: the approximate-map target of a typed country code (UA → PL), then catalog zones whose code, name or country starts with the input, then edit distance.
- R13. `tidegap region detect` prints the time-zone guess and stores nothing; `tidegap region set auto` clears the setting.
- R14. `tidegap region list` prints the 31 zones with name, country, operator and data source.

**Time-zone map and data**

- R15. `Europe/Kyiv` (and aliases `Europe/Kiev`, `Europe/Uzhgorod`, `Europe/Zaporozhye`) maps to `PL` with the note "No Ukrainian grid data yet; using Poland (PL), the nearest grid in the same synchronous area."
- R16. The TZ map gains the unambiguous zones listed in KTD8.
- R17. The extension and the Mac menu keep showing `summary.region`; the summary and status bodies also carry `region_source`.

**Docs**

- R18. The config docs page has a "Grid region" section; the CLI page lists `tidegap region`; agent command files and the OpenClaw field description state the new precedence.

### Acceptance Examples

- AE1. Covers R2, R15. Mac TZ `Europe/Kyiv`, no setting, no env. `tidegap region show` → `PL Poland — guessed from time zone Europe/Kyiv (approximate: no UA data yet)`.
- AE2. Covers R3. `tick --daemon` running; `tidegap region set FR`; the next tick's hydrated task has `region: FR`.
- AE3. Covers R9. `TIDEGAP_DEFAULT_REGION=DE` in `~/.config/tidegap/env`; the page card shows DE, source env, select disabled; `POST /api/settings/region` still stores the value and answers `{effective: "DE", stored: "FR"}`.
- AE4. Covers R12. `tidegap region set UA` exits 2: `Unknown zone UA. Closest: PL. Request a region: https://github.com/tidegap/tidegap/issues/new?template=region_request.md&title=Region+request:+UA`.
- AE5. Covers R2. Hand-edited `TIDEGAP_DEFAULT_REGION=XX` in `~/.tidegap/config`: the value is ignored, source is `timezone`, `region show` and the card warn "Stored region XX is not supported; ignored."

### Scope Boundaries

- No `UA` zone and no new grid feed for Ukraine.
- No native SwiftUI region screen; the Mac app uses the page.
- No change to the website (`apps/web`) region picker or its geo-detection.
- No per-task region UI change; `--region` and tool arguments behave as today.
- core-py gets the catalog data and the PL ENTSO-E zone only (KTD10); it reads no setting.

### Open Questions

- Deferred: where the owner's `US-MIDA-PJM` came from is not reproduced. Three paths exist: an `America/New_York` time zone, `TIDEGAP_DEFAULT_REGION` in an agent host's MCP config, and OpenClaw `defaultRegion`. `tidegap region show` answers the first; the MCP and OpenClaw paths live in other processes' config, which the card cannot see (docs say so, U6).

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Storage: key `TIDEGAP_DEFAULT_REGION` in `~/.tidegap/config`.** This file already holds the non-secret settings (`TIDEGAP_USAGE`, `TIDEGAP_NOTIFY`, `TIDEGAP_CARBON_BUDGET_*`, quota labels) with the rule "env first, then the file" (`packages/cli/src/usage/settings.ts`, `commands/tick.ts` `notifyDisabledInConfig`), and core already reads it (`budget.ts`, `quota.ts`), as do the MCP server and the OpenClaw plugin. Rejected: `~/.config/tidegap/env` (the secrets file; `loadEnvFileIntoProcess` turns it into env, so a setting there could not be told apart from an override, and the page would write the secrets file for a non-secret); a new JSON file (a second format for one key). Same key name as the env variable, as for the other keys. Governs R1, R4.
- KTD2. **Precedence.** `--region` flag / tool argument > `TIDEGAP_DEFAULT_REGION` env (includes keys loaded from `~/.config/tidegap/env`) > `~/.tidegap/config` setting > time-zone guess > `GB`. OpenClaw: tool argument > plugin config `defaultRegion` > setting > TZ > `GB`. A stored value that is not a catalog zone is ignored with a warning (AE5); a flag or env value keeps today's `REGION_RE` check only. Governs R2, R4.
- KTD3. **Resolver API.** `resolveRegion({requested?, configured?: {value, source: "env" | "config"}, setting?, timeZone?})` returns `{region, source, timeZone?, approximate?: {country, note}, ignored?: string}`. `RegionSource` becomes `flag | env | config | setting | timezone | fallback` (was `request | config | timezone | default`); the positional `(requested, configured)` wrapper stays and returns the new values (`configured` → `config`). OpenClaw's documented `region_source: "request"` becomes `"flag"`; CHANGELOG names the rename. `loadRegionSetting(path = carbonBudgetConfigPath())` in core returns the raw stored value or `undefined` (missing or unreadable file). Core stays environment-pure: hosts pass the env value in. Governs R2.
- KTD4. **Catalog in the data SSOT.** `packages/core-ts/src/data/regions.json` gains `regionCatalog: {<zone>: {name, country, countryName, operator}}` for the 31 zones already keyed there; `pnpm gen:data` emits `REGION_CATALOG` to `tables.generated.ts` and `_data.py`. `gen-data-validate.mjs` checks that the catalog keys equal the `regionFloors` keys and the zones in `apps/web/src/lib/regions.ts`. Governs R6, R14.
- KTD5. **Data source per zone from the feed maps.** `regionDataSource(zone)` in `packages/core-ts/src/grid.ts` derives `{id: "neso"|"entsoe"|"watttime-eia"|"electricitymaps", label, keyVar?}` from the same maps `buildDefaultGridFeed` uses (`EIA_RESPONDENT_BY_ZONE`, `ENTSOE_BIDDING_ZONE_BY_REGION`, GB), so the label cannot drift from routing. Hosts add `live: boolean` from the credentials they hold (mock when the key is missing). Governs R5, R6.
- KTD6. **One host module for CLI and API.** `packages/cli/src/region.ts` (new): `currentRegion({flag?, env, configPath?, now?})`, `storeRegion(zone | "auto")`, `regionView()` (catalog + data source + live flag). The `tidegap region` command and the API routes both call it (solution doc item 1). Writes call the existing line-preserving atomic writer `setEnvFileKey(path, key, value)` from `commands/env-file.ts` with the config path (no rename). Governs R11–R14.
- KTD7. **Routes in the integrations auth class.** `GET /api/settings/region` → `{effective, source, stored, ignored?, timeZone, detected, approximate?, catalog[]}`; `POST /api/settings/region {zone: "<catalog zone>" | "auto"}` → same body. The `isIntegrationsRoute` check in `packages/cli/src/ui/server.ts` widens to `integrations` and `settings` segments: page token or `macos` client token, never an extension origin. `checkBody` strict, 30 writes per minute. `/api/status` and `/api/summary` add `region_source` for every client. Governs R5–R9, R17.
- KTD8. **TZ map additions (exact):** `Europe/Warsaw` PL, `Europe/Vienna` AT, `Europe/Madrid` ES, `Europe/Amsterdam` NL, `Europe/Brussels` BE, `Europe/Dublin` IE, `Europe/Helsinki` FI, `Asia/Seoul` KR, `Asia/Singapore` SG, `Australia/Sydney` AU-NSW, `Africa/Johannesburg` ZA, `Asia/Dubai` AE, `Pacific/Auckland` NZ. Left out because one time zone spans several catalog or non-catalog grids: Oslo, Stockholm, Copenhagen, Rome, Tokyo, Kolkata, Toronto, Chicago. **Approximate map:** Kyiv and its three aliases → PL with `{country: "UA"}`. PL is the only catalog zone that borders Ukraine and is in the ENTSO-E Continental Europe synchronous area that Ukraine joined in March 2022; its mix (coal-heavy) differs, so absolute grams differ while hour-of-day timing is the useful part. The note says so in docs. Governs R15, R16.
- KTD9. **PL gets live ENTSO-E data when a token exists.** Add `PL: "10YPL-AREA-----S"` in TS and PY, but `buildDefaultGridFeed` routes PL to `entsoeFeed` only when `TIDEGAP_ENTSOE_SECURITY_TOKEN` is set; without it PL stays on the Electricity Maps fallback, as today (`entsoeFeed` without a token returns the mock with no fallback). `regionDataSource(PL)` uses the same check. The RS1 Haiku check runs one live A75 query for PL with the owner's ENTSO-E token from `~/.config/tidegap/env` and records the response shape; that decides the stop condition. Governs R15.
- KTD10. **core-py parity.** core-py has no TZ guess and reads no setting (its `Scheduler` takes `default_region`); it stays that way. It gets `REGION_CATALOG` through gen:data and the PL ENTSO-E zone. `docs/solutions/best-practices/cross-language-select-window-parity.md` is unaffected.
- KTD11. **Re-read, not restart.** The setting is a tiny file: `currentRegion` reads it on every call, cached by `(mtimeMs, size)`. `tick` already calls `runTickOnce` per loop, so resolving there is enough. `tidegap ui` passes `defaultRegion: () => currentRegion(...).region` to the core `Scheduler`, whose `defaultRegion` option accepts `string | (() => string)` (the `quotaConfig` getter pattern); `ApiContext.defaultRegion` becomes a getter. The listener and MCP server resolve per request. Not the env-file `process.env` sync of PR #100: that pattern exists because env keys live in `process.env`; this key is read from the file directly. A change applies to tasks queued after it; pending tasks keep their recorded `region` (the scheduler re-plans and dispatches from `record.region`). Docs say so. Governs R3.
- KTD12. **Request link.** `.github/ISSUE_TEMPLATE/region_request.md` (new) with fields: country or zone, time zone, known public data source. The link pre-fills the title with the detected country or typed zone.

### Card design note

Card above Integrations, same tokens and card style. Top line: zone name, code chip, and source sentence ("Chosen in Settings", "Guessed from your time zone Europe/Kyiv", "Set by TIDEGAP_DEFAULT_REGION", "Default (GB): your time zone is not mapped"). Second line: data source and live/mock ("Live: ENTSO-E" / "Sample curve: add TIDEGAP_ELECTRICITY_MAPS_API_KEY"). Below: a combobox (`role="combobox"`, listbox of options, arrow keys, Enter selects, Esc closes), options as text only (`textContent`), then "Auto-detect" ghost button (disabled when nothing is stored). Choosing an option saves at once; the card then shows "Previous: GB. Undo" until the view closes. With a flag or env source, the select and Auto-detect are disabled, the sentence is "Set by --region when this page's server started" or "Set by TIDEGAP_DEFAULT_REGION", and a stored value that differs shows "Stored setting FR applies when the override is removed." A note block (`role="note"`) for approximate, fallback ("Your time zone (<tz>) is not mapped; using Great Britain (GB).") or ignored values, with the request link. A filter with no match shows one non-selectable row "No supported zone matches '<text>'. Request your region" with the typed text in the link. Request-link title: country, else typed text, else the IANA time zone. States: loading (skeleton line, controls disabled); saving (controls disabled, previous zone shown); GET failure (`role="alert"` "Could not load the grid region" + Retry); POST failure 400/403/429/network (previous zone restored, `role="alert"` reason, focus stays on the combobox). Saving announces "Region set to France (FR)" in the polite live region. 390 px and dark mode with no horizontal scroll.

### Assumptions

- The channels S2 stream merges before this work starts; units rebase on it. If channels S3 (card component) is still in flight, U4 adds only a mount call to `packages/cli/ui/integrations.js` `mountSettings`.
- Electricity Maps zone codes stay the zone vocabulary.

### System-Wide Impact

- **Files on disk:** `~/.tidegap/config` gets a writer for the first time. The writer keeps other lines byte for byte and writes 0600 (a looser existing mode becomes 0600; docs say so).
- **Behaviour change:** the CLI now honours `TIDEGAP_DEFAULT_REGION`; a user who set it for the MCP server sees the CLI follow it. CHANGELOG states it.
- **Auth boundary:** one more route under the integrations class; `docs/spec/ui-client-api.md` matrix updated.
- **Agent parity:** every card action has a CLI equivalent (`region set`, `set auto`, `detect`, `show --json`).

### Risks & Dependencies

- Shared file `packages/cli/src/commands/tick.ts` with channels S2 → start after S2 merges. Later channels units also touch `ui/api.ts`, `ui/integrations.js`, `app.css`, the `server.ts` module list, `src/index.ts`, `cli-flows.mjs`, `08-config.md`, `03-cli.md`, `CHANGELOG.md`: whichever lands second rebases; RS3 and RS5 start after the channels card component (S3b) merges or rebase on it.
- A hand-edited config with duplicates or comments → the writer's existing tests cover it; U2 adds a config-file fixture.
- ENTSO-E PL shape → stop condition, KTD9 drops cleanly.

---

## Implementation Units

| Unit | Stream | Files (main) | Depends | Model |
|---|---|---|---|---|
| U1 Core resolver, catalog, TZ map, PL feed | RS1 | core-ts, core-py data, gen-data | channels S2 merged | Opus |
| U2 CLI host module, `tidegap region`, tick/ui/queue/listener | RS2 | packages/cli/src | U1 | Opus |
| U3 Settings API routes | RS2 | packages/cli/src/ui | U2 | Opus |
| U4 Page card | RS3 | packages/cli/ui | U3 | Opus |
| U5 MCP server and OpenClaw | RS4 | mcp-server, openclaw-plugin | U1 | Opus |
| U6 Docs, agent files, issue template, QA harness | RS5 (done) | apps/web/content, scripts/qa, plugin commands | U2, U3, U5 | Sonnet |

Order: RS1 → (RS2 ∥ RS4) → RS3 → RS5. RS2 and RS4 share no file. Sonnet simplifies RS1–RS4 (skip RS5, docs only). Haiku: per-stream gates, the full gate, browser QA and the Mac app check. Opus: one `ce-code-review` at the end, one fix stream.

### U1. Core resolver, catalog, TZ map, PL feed

- **Goal:** core resolves a region from all inputs, knows the 31 zones as data and reports their data source.
- **Requirements:** R2, R15, R16; KTD3, KTD4, KTD5, KTD8, KTD9, KTD10, KTD11.
- **Files:** `packages/core-ts/src/region.ts`, `src/grid.ts` (`regionDataSource`, PL zone), `src/scheduler.ts` (`defaultRegion` getter), `src/index.ts`, `src/data/regions.json`, `src/data/tables.generated.ts`, `packages/core-py/src/tidegap/_data.py`, `packages/core-py/src/tidegap/grid.py` (PL zone), `scripts/gen-data.mjs`, `scripts/gen-data-validate.mjs`; tests `packages/core-ts/test/region.test.ts`, `test/grid.test.ts`, `test/grid-feeds-fixtures.test.ts`, `test/scheduler.test.ts`, `packages/core-py/tests/test_grid.py`, `test_grid_feeds_fixtures.py`.
- **Test scenarios:**
  - Precedence: each layer wins over every lower one; `source` matches for all five.
  - `Europe/Kyiv` and the three aliases → PL with `approximate.country = "UA"`; each KTD8 zone maps; Oslo and Chicago stay unmapped → GB, source `fallback`.
  - Stored `XX` → ignored, `ignored: "XX"`, next layer used; stored `fr` → `FR`.
  - `loadRegionSetting`: missing file, unreadable file, comment and quoted value.
  - `regionDataSource`: GB neso, FR entsoe, PL entsoe with an ENTSO-E token and electricitymaps without one, US-CAL-CISO watttime-eia, JP-TK electricitymaps; every catalog zone has one.
  - ENTSO-E PL forecast through the fake ENTSO-E fixture; PY same.
  - Scheduler with a getter: two `schedule` calls see two values.
  - `gen:data:check` clean; validator fails on a catalog/web zone mismatch.
- **Verification:** core-ts tests and typecheck, `pnpm lint:py`, `pnpm gen:data:check`.

### U2. CLI host module, `tidegap region`, surfaces

- **Goal:** every CLI surface resolves through one module, and the user can see and set the region from the terminal.
- **Requirements:** R1–R4, R11–R14; KTD1, KTD2, KTD6, KTD11, KTD12.
- **Files:** `packages/cli/src/region.ts` (new), `src/commands/region.ts` (new), `src/index.ts` (command), `src/env.ts` (`defaultRegion` from `TIDEGAP_DEFAULT_REGION`), `src/commands/env-file.ts` (`setKeyValueFileKey`), `src/commands/tick.ts`, `src/commands/ui.ts`, `src/commands/queue.ts` (`actionScheduler`), `src/channels/listener.ts`, `src/ui/api.ts` (`defaultRegion` getter, `region_source`), `src/ui/summary.ts`; tests `packages/cli/test/region.test.ts` (new), `region-command.test.ts` (new), `env-file.test.ts`, `tick.test.ts`, `ui-summary.test.ts`.
- **Test scenarios:**
  - `region set fr` writes `TIDEGAP_DEFAULT_REGION=FR` and keeps other lines and comments; `set auto` removes the key; `set UA` exits 2 with closest match and link.
  - `show --json` shape for each source; `detect` writes nothing.
  - Env var set → `show` reports `env` even with a stored value.
  - AE2: two `runTickOnce` calls around a `region set` use the new region.
  - ui context: summary `region` changes after the file changes, without restart.
  - Listener `/defer` from chat uses the stored region.
  - A task queued before `region set FR` keeps its old region; one queued after gets FR.
  - `set ua` prints `Closest: PL`; `set fx` lists FR first.
- **Verification:** cli tests and typecheck; `node scripts/qa/gate.mjs cli`.

### U3. Settings API routes

- **Goal:** the page and the Mac app read and change the region over the loopback API.
- **Requirements:** R5–R9, R17; KTD7.
- **Files:** `packages/cli/src/ui/settings.ts` (new; route handlers over `cli/src/region.ts`), `src/ui/server.ts` (route class), `src/ui/api.ts` (status body), `docs/spec/ui-client-api.md`; tests `packages/cli/test/ui-settings-region.test.ts` (new), `ui-server.test.ts` (auth matrix).
- **Test scenarios:**
  - GET shape with catalog of 31; POST `FR` → stored and effective; POST `auto` clears; POST `UA` → 400 `unknown_zone`; extra body key → 400.
  - Auth: page token 200; `macos` client 200; extension client 403; extension origin with page token 403; no token 401. Extension client token and a `macos` token with an extension Origin get 403 on `/api/settings/region`, `/api//settings/region`, `/api/settings//region` and `/api///settings/region`, GET and POST; a page token gets the same answer on the double-slash paths as on the normalised path.
  - AE3: env override → `effective` env value, `stored` written.
  - Rate limit 31st write in a minute → 429.
- **Verification:** cli tests and typecheck (no browser).

### U4. Page card

- **Goal:** Settings shows and changes the region.
- **Requirements:** R5–R10; card design note.
- **Files:** `packages/cli/ui/region.js` (new), `ui/integrations.js` (mount call only), `ui/app.css`, `packages/cli/src/ui/server.ts` (static file list); tests `packages/cli/test/ui-region-view.test.ts` (new; pure view-model and filter functions).
- **Test scenarios:**
  - View model per source: setting, timezone, approximate (Kyiv), fallback, env and flag (select and Auto-detect disabled, differing stored value shown), ignored.
  - States: loading, saving, GET failure with Retry, POST 429 restores the previous zone; Undo restores it.
  - Filter with no match → the request row with the typed text.
  - Filter: "pol" → PL; "pjm" → US-MIDA-PJM; "ENTSO" → entsoe zones; empty → 31.
  - Request link: title pre-filled with country or typed zone, URL-encoded.
  - Options built with `textContent` only (no `innerHTML` in `region.js`).
- **Verification:** cli tests; browser QA at the end (U6 cases).

### U5. MCP server and OpenClaw

- **Goal:** agent hosts use the stored setting below their own explicit config.
- **Requirements:** R2–R4; KTD2, KTD11.
- **Files:** `packages/mcp-server/src/server.ts` (resolve per call), `src/env.ts`, `packages/openclaw-plugin/src/index.ts`, `src/config.ts` (field description), `openclaw.plugin.json`, `packages/openclaw-plugin/README.md`; tests `packages/mcp-server/test/server.protocol.test.ts`, `packages/openclaw-plugin/test/config.test.ts`, `plugin.test.ts`.
- **Test scenarios:** MCP: env beats setting; setting beats TZ; a setting written after start is used by the next tool call. OpenClaw: plugin config beats setting (`region_source: "config"`); setting beats TZ; a tool argument reports `"flag"` (README text and `plugin.test.ts` updated).
- **Verification:** package tests and typecheck; `node scripts/qa/gate.mjs mcp`.

### U6. Docs, agent files, issue template, QA harness (RS5, done)

- **Goal:** users and agents find the setting; QA covers it.
- **Requirements:** R18; KTD12.
- **Files:** `apps/web/content/docs/08-config.md` ("Grid region": precedence table, the file, the Kyiv note, request link), `03-cli.md` (`tidegap region`), `packages/claude-code-plugin/commands/grid.md`, `plan.md`, `.github/ISSUE_TEMPLATE/region_request.md` (new), `CHANGELOG.md` (Unreleased), `scripts/qa/cli-flows.mjs` (region cases with `TZ=Europe/Kyiv` under the harness's temp `HOME`; core reads no `TIDEGAP_HOME`), `scripts/qa/mcp-tools.mjs` (default from setting), `scripts/qa/ui-flows.mjs` (card cases), `docs/plans/2026-10-19-qa-matrix-checklist.md` (section S14).
- **Test expectation:** the harness cases are the tests; `pnpm gen:docs:check`, `node scripts/qa/docs-drift.mjs`, `node scripts/check-agent-files.mjs`.

---

## Verification Contract

- Per stream: `pnpm -r typecheck`, the changed test files with `vitest run`, and the stream's no-browser gate area. Streams never run `gate ui`.
- Integration branch, once, by Haiku, nothing else running: `pnpm preflight`, `node scripts/qa/gate.mjs all`, then `gate ui` alone. Failures sorted pass / flake / real; only real goes to Opus as a named fix brief.
- Acceptance checks (Haiku, with proof):
  0. Before checks 2-4 (real home), record the current `TIDEGAP_DEFAULT_REGION` line of `~/.tidegap/config`; restore it after check 5.
  1. `HOME=$(mktemp -d) TZ=Europe/Kyiv tidegap region show --json` → `{"region":"PL","source":"timezone","approximate":{"country":"UA",...}}`.
  2. `tidegap region set FR`, then `curl` `/api/summary` on a running `tidegap ui` → `region: "FR"`, `region_source: "setting"`, no restart.
  3. Mac app: quit, relaunch, open Settings → card shows FR; menu clean-window line ends `· FR`.
  4. Extension popup shows FR after its next poll.
  5. Page card at 390 px and dark mode: screenshot, no horizontal scroll; search "pol" selects PL; Auto-detect returns to the TZ guess.
  6. Extension-origin `POST /api/settings/region` → 403 (curl output).
- QA matrix S14 rows ticked with the evidence paths.

## Definition of Done

- All R-IDs covered by a unit and a test or acceptance check; AE1–AE5 pass.
- Preflight and `gate all` green on the branch; `gate ui` green or flake-only.
- One PR, `ce-code-review` done, findings fixed, CI green. Not merged.
- `ce-compound` entry written after the PR opens if the review found a non-obvious lesson.

## Sources

- `packages/core-ts/src/region.ts` (7-entry TZ map, `resolveRegion`), `src/grid.ts:406` (EIA zones), `:607` (ENTSO-E zones FR, DE, ES, IT, NL; catalog uses IT-NO, so `IT` is unused), `src/budget.ts:79` (`~/.tidegap/config`), `src/data/regions.json` (31 zones).
- `packages/cli/src/usage/settings.ts`, `commands/tick.ts:115` (env-then-config rule), `commands/env-file.ts` (atomic line-preserving writer), `commands/ui.ts:110`, `commands/tick.ts:423`, `commands/queue.ts:538`, `channels/listener.ts:59` (each resolves once from flag or TZ).
- `packages/mcp-server/src/server.ts:537`, `packages/openclaw-plugin/src/config.ts:110` (its description claims the CLI reads `TIDEGAP_DEFAULT_REGION`; it does not today).
- `apps/macos/TidegapKit/Sources/TidegapKit/ServerLauncher.swift:154` (`ui --no-open`), `apps/extension/src/lib/poller.js:34` (region is display state only).
- `apps/web/src/lib/regions.ts` (31 zones with names; the site's own list).
- `docs/plans/2026-10-19-integrations-all-channels.md` (S2 file list; route class KTD7).

---

## Results

Done 2026-10-20. All five streams merged or in review: RS1 core (#116), RS4 MCP and OpenClaw (#118), RS2 CLI and API (#121), RS3 Settings card (#123), RS5 docs (branch `docs/region-rs5`).

- **Shipped as planned:** the precedence flag > env (OpenClaw: `config`) > `~/.tidegap/config` setting > time zone > GB on every surface; `region_source` in `tidegap region show`, `/api/summary`, `/api/status` and `schedule_task`; `tidegap region show|set|detect|list`; `GET|POST /api/settings/region`; the Kyiv → PL approximation; the unknown-zone message with closest zones and a request link.
- **Env file, as built:** `tidegap tick`, `tidegap ui` and the Telegram listener read `TIDEGAP_DEFAULT_REGION` from `~/.config/tidegap/env` live (a key in the real environment wins). The MCP server reads only its process environment; OpenClaw reads its plugin config.
- **KTD9 not implemented:** `PL` has no ENTSO-E bidding zone in `grid.ts`; PL stays on Electricity Maps (or the sample curve). The docs say so.
- **Card differs from R7 wording:** Auto-detect is the "Auto (time zone)" option of the select plus Save, not a separate button.
- **RS5:** site docs (Config → Grid region with a zone table generated from the catalog by `pnpm gen:docs`, the CLI section, the card on the UI page, region rules on the MCP tools page), README, CHANGELOG, plugin commands `grid`, `plan`, `defer`; `.github/ISSUE_TEMPLATE/region_request.md` (the request link named it but it did not exist); `docs-drift` rule K12 checks the region docs against the resolver.
- **Open:** the Verification Contract acceptance checks 2-6 (Mac app, extension, real home) and the QA matrix Gate rows stay with the owner.
