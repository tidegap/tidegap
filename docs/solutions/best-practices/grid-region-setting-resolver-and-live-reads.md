---
title: "Grid region setting: resolver precedence, live reads per surface, the cache stamp, Kyiv to PL, exact-code-first search"
date: 2026-10-20
category: best-practices
module: packages/core-ts/src/region.ts, region-host.ts, packages/cli/src/region.ts, packages/cli/ui/region-card.js
problem_type: best_practice
component: tooling
severity: medium
last_updated: 2026-10-28
applies_when:
  - "One setting must be read by several long-lived processes without a restart"
  - "A cache is keyed on file metadata"
  - "A user types a code into a search box and presses Enter"
  - "A time zone maps to a grid that Tidegap has no data for"
tags: [region, resolver, precedence, cache, mtime, inode, search, kyiv, settings]
---

# Grid region setting

PRs #116 (core), #121 (CLI and API), #118 (MCP and OpenClaw), #123 (page card), #125 (docs). Plan: `docs/plans/2026-10-19-region-setting.md`. Trigger: the owner saw `US-MIDA-PJM` and could not tell why or change it.

## Resolver and precedence

The key is `TIDEGAP_DEFAULT_REGION` in `~/.tidegap/config` (the non-secret settings file, not the secrets env file: `loadEnvFileIntoProcess` would make a setting look like an override).

`--region` flag or tool argument > `TIDEGAP_DEFAULT_REGION` env (including keys loaded from `~/.config/tidegap/env`) > stored setting > time-zone guess > `GB`. OpenClaw: tool argument > plugin `defaultRegion` > setting > time zone > `GB`.

`resolveRegion({requested, configured: {value, source}, setting, timeZone})` returns `{region, source, ...}` with `source` in `flag | env | config | setting | timezone | fallback`. The old names (`request`, `default`) were renamed; CHANGELOG states it. Core stays environment-pure: hosts pass the env value in. A stored value outside the catalog is skipped and returned as `ignored`; a flag or env value keeps only the `REGION_RE` check. A tool argument outside the catalog still passes when a configured key gives it a live feed (`regionDataSource(...).live`): any zone with an Electricity Maps key, `IT` with an ENTSO-E token.

## Which surface reads what, live

| Surface | Env value | Setting file |
|---|---|---|
| `tidegap tick` | env file synced each tick | each tick |
| `tidegap ui`, Telegram listener | `liveEnvRegion()` per call (syncs `~/.config/tidegap/env` first) | per request or task |
| Queue writes | via `actionScheduler`, per task | per task |
| MCP server | **process environment only** (no env file) | per call |
| OpenClaw plugin | plugin config `defaultRegion` | per call |

Review finding (#121): the first version resolved the env value once at start in `tidegap ui` and the listener, so an env-file edit needed a restart. Fix: a getter, `liveEnvRegion`. Pending tasks keep their recorded `region`; a change applies to tasks queued after it.

## Cache stamp: mtime and size are not enough

The setting reader stats the file and re-reads only when the stamp changes. `(mtimeMs, size)` missed a same-size rewrite inside one mtime tick (`DE` to `FR`, same second): the reader kept the old value. Fix (#121 review): the stamp is `(ino, mtimeMs, size)`. The atomic writer renames a new file over the old one, so the inode changes. Also drop the cached reader right after our own write (`storeRegion`). Test it with a same-size rewrite and a forced equal mtime.

## Kyiv to PL

No UA zone and no Ukrainian grid feed. `Europe/Kyiv` (aliases `Kiev`, `Uzhgorod`, `Zaporozhye`) maps to `PL` as an approximate match with a note: "No Ukrainian grid data yet; using Poland (PL), the nearest grid in the same synchronous area." PL is the only catalog zone bordering Ukraine in the Continental Europe area Ukraine joined in 2022. Absolute grams differ (coal-heavy mix); hour-of-day timing is the useful part. `region set UA` exits 2 with `Closest: PL` and the request link. Node reports `Europe/Kyiv` as `Europe/Kiev` (a QA case failed on it), so map both. Zones that span several grids (Oslo, Stockholm, Rome, Tokyo, Kolkata, Toronto, Chicago) are left out of the TZ map on purpose. The ENTSO-E PL feed (KTD9) was not built; the owner's env had no token to check the A75 shape.

## Search ranking: exact code first

Card review (#123): typing `ES` and pressing Enter stored a US zone, because a substring filter ranked by list order. Rule: rank an exact zone or country code first, then a code or name prefix, then substring. The same order is used by `region set` (approximate-map target of a typed country code, then prefix, then edit distance). `closestRegions` for inputs up to 3 characters uses edit distance 1 only, so `XX` suggests nothing. Also: a new search or choice clears the last Save error; after a failed no-match Save, focus returns to the search; one `role="status"` per view (a second one hid the Integrations announcement).

## Open follow-ups from the reviews

Proposed, not in code yet: share the sliding-window limiter between `settings.ts` and `integrations.ts`; rename `isIntegrationsRoute` (it now guards `/api/settings`); the 31-zone count is hardcoded in two tests.

Done: the CLI's `detectRegion` calls core `resolveRegion` with the time zone alone, so `region detect` and the resolver guess through one code path. Tests written before the change pin its output as JSON strings, key order included.

Cut, with the reason:

- `hostRegionInputs()` for the five entry points: each one still calls `readEnvCredentials()` for the grid feed, and its region part is a one-line object. A helper adds a call and removes no logic.
- `catalogZoneOrAlias()` in core: it removes one expression in `parseRegionInput` but adds a permanent export to the published `@tidegap/core`. Applying the UK alias to `--region` and the env variable would change behaviour.

Related: `shared-setup-module-for-cli-and-local-settings-api.md`, `client-tokens-and-extension-origins.md`.
