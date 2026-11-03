---
title: Nothing checked manifest versions against README/CHANGELOG, so npm, PyPI and git tags drifted apart unnoticed
date: 2026-09-30
category: tooling-decisions
module: scripts/check-versions.mjs (preflight)
problem_type: tooling_decision
component: tooling
severity: medium
applies_when:
  - "Bumping the version in this repo (release prep) across the TS packages, the Python package, and copy that quotes a version number"
  - "Deciding the order of npm/PyPI publish vs. merging a release-prep PR"
root_cause: missing_tooling
resolution_type: tooling_addition
tags: [release, version-drift, preflight, npm, pypi, lockstep]
---

# Nothing checked manifest versions against README/CHANGELOG, so npm, PyPI and git tags drifted apart unnoticed

## Context

Ahead of the InfoQ article prep (PR #37), the repo's published version state had quietly diverged: npm had `@ebb-ai/core` at 0.13.0, PyPI had the Python package at a different point, and git tags were at 0.15.1 — three different numbers for what should be one release identity. Nothing in CI or `pnpm preflight` compared the workspace manifests against each other or against the prose in `README.md` / `CHANGELOG.md`, so each publish target could move independently without anything failing.

## Guidance

**Add a dependency-free lockstep check and run it first in `pnpm preflight`.**

`scripts/check-versions.mjs` treats `packages/core-ts/package.json` as the single source of truth and compares its `version` against every other place a version is asserted: the other package manifests (`cli`, `mcp-server`, `openclaw-plugin` — both its `package.json` and `openclaw.plugin.json`), the Claude Code plugin manifest and marketplace entry, `packages/core-py/pyproject.toml`, the `README.md` status line (`^> **Status:** v(\S+)`), the `apps/web/public/llms.txt` line `Current release: X.Y.Z.` (added after 0.20.0 shipped that file still saying 0.19.0), and the newest dated `CHANGELOG.md` heading (`^## \[(\d[^\]]*)\] — \d{4}-\d{2}-\d{2}`). A mismatch prints every offending file and exits 1; a match prints `check-versions: <version> everywhere (<n> files)`. It follows the repo's existing `gen:data:check` pattern (a small script, no new dependency) and runs before the rest of `pnpm preflight` so a version drift fails fast rather than surfacing as a confusing downstream diff.

```js
// scripts/check-versions.mjs — core of the check
const SOURCE = "packages/core-ts/package.json";
const expected = json(SOURCE).version;
const mismatches = Object.entries(found).filter(([, v]) => v !== expected);
if (mismatches.length > 0) {
  console.error(`check-versions: expected ${expected} (from ${SOURCE})`);
  for (const [file, v] of mismatches) console.error(`  ${file}: ${v}`);
  process.exit(1);
}
```

> **Superseded 2026-10-16.** Releases now run merge → tag → approve → workflow (`.github/workflows/release.yml`, trusted publishing). The tag must point at a reviewed commit on `main`, so publishing from an unmerged PR head is no longer possible. `main` quotes the new version for the minutes between merge and publish; that window is accepted. Plan: `docs/plans/2026-10-16-1509-chore-trusted-publishing-plan.md`. The guidance below is kept as history.

**Publish npm from the reviewed PR head before merging it, not after.**

The recommended order this PR settled on (see PR #37, "Needs Vitalii"): publish the new version to npm from the branch that has already been reviewed, *then* merge to the default branch. Reversing the order — merge first, publish later — means the default branch, and anything that builds the public site from it, quotes a version that npm doesn't have yet. The window between merge and publish is exactly the kind of drift this check exists to catch, so closing it by ordering publish-before-merge removes the window rather than relying on the check to catch it after the fact.

## Why This Matters

Version drift across npm/PyPI/git tags/README/CHANGELOG is invisible until someone compares them by hand — there's no build failure, no red test, nothing that forces the comparison. By the time it's noticed (as here, ahead of writing about the release), three numbers have already diverged and there's no single "current version" to point to. A lockstep check converts that silent drift into a loud, first-in-preflight failure naming exactly which file is wrong.

## When to Apply

- Any time the version is bumped for a release, in any of the lockstep files `check-versions.mjs` lists.
- Any time a new manifest or copy location that quotes the version is added — it needs to be added to `check-versions.mjs`'s `found` map or it becomes a new place drift can hide.
- Before deciding the publish order for a release: merge the release-prep PR, then tag the merge commit `vX.Y.Z` (superseded 2026-10-16: the old order was publish from the PR head, merge after). `check-versions.mjs --tag vX.Y.Z` checks the tag.

## Examples

```bash
$ node scripts/check-versions.mjs
check-versions: 0.16.0 everywhere (10 files)
$ node scripts/check-versions.mjs   # after reverting one manifest to 0.15.9 locally
check-versions: expected 0.16.0 (from packages/core-ts/package.json)
  packages/cli/package.json: 0.15.9
```

## Related

- `scripts/check-versions.mjs` — the check itself.
- `package.json` — `preflight` script, where the check runs first.
- `docs/plans/2026-09-30-1647-chore-infoq-article-prep-plan.md`, KTD3 — the plan item that specified this check.
- PR #37 body, "Needs Vitalii" — the open publish-order decision this doc's second guidance item records the recommendation for.

## Related

- `trusted-publishing-release-workflow.md` (the current release path)
