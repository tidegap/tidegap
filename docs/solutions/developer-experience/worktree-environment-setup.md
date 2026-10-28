---
title: A fresh worktree needs its own venv and a build before its test results are trustworthy
date: 2026-09-27
category: developer-experience
module: development workflow / worktrees
problem_type: developer_experience
component: development_workflow
severity: medium
applies_when:
  - "Setting up a new git worktree for this repo and running pytest, or pnpm typecheck / pnpm test, in it for the first time"
tags: [worktree, venv, editable-install, pnpm-build, false-green]
---

# A fresh worktree needs its own venv and a build before its test results are trustworthy

## Context

The 2026-09 models/deps refresh (PR #35) ran as several parallel streams, each in its own worktree under the repo-relative `.worktrees/` directory (gitignored, per `.gitignore`; plan `docs/plans/2026-09-27-2059-chore-models-deps-refresh-plan.md`, KTD8). Two setup steps that look skippable each produced a result that looked fine but wasn't: one a silent false green, the other a misleading error that looks like a code bug.

## Guidance

**Python: create the venv inside the worktree; never reuse or symlink the main checkout's `.venv`.**

`packages/core-py/README.md:362-366` documents the standard setup: `python3 -m venv .venv && . .venv/bin/activate && pip install -e ".[dev,anthropic,openai]"`. The `-e` (editable) install is the part that matters for a worktree: pip records the *absolute source path* the package was installed from inside the venv's metadata. A venv built with `pip install -e` in the main checkout keeps pointing at the main checkout's `packages/core-py/src/`, even if that venv is symlinked into a worktree. `pytest` run through the symlinked venv then imports the main checkout's code, not the worktree's branch — tests report green while never having run the code under test.

Build the venv from inside the worktree itself:

```bash
cd packages/core-py   # inside the worktree
python3.11 -m venv .venv
.venv/bin/pip install -e '.[dev]'
.venv/bin/pytest -q
```

**TypeScript: run `pnpm build` before `pnpm typecheck` or `pnpm test` in a worktree that has never been built.**

`packages/core-ts/package.json`'s `main`, `types` and `exports` fields all resolve to `./dist/*`, and every package's `dist/` output directory is gitignored (`.gitignore:6`, pattern `dist/`), so it never ships with a fresh clone or worktree. `packages/cli/package.json:45` depends on `@tidegap/core` as `workspace:*`, which pnpm resolves through that same `package.json`, i.e. through `dist/`. Nothing generates `packages/core-ts/dist/` except the root `build` script (`pnpm -r --filter=./packages/* build`). A freshly created worktree has no `dist/` yet, so `pnpm typecheck` / `pnpm test` on `@tidegap/cli` (and anything else importing `@tidegap/core`) fails to resolve the import — an error that reads like a real type/module problem, not a missing build step.

```bash
pnpm build       # once, in the fresh worktree
pnpm typecheck
pnpm test
```

## Why This Matters

Neither failure mode points at its own cause. The venv case is the more dangerous of the two: it doesn't fail at all, it reports success while testing the wrong tree, so a real regression in the worktree's branch can go undetected. The build case at least fails, but the module-resolution error looks like a code defect and can send an agent hunting through `@tidegap/cli`'s source before it occurs to check whether `@tidegap/core` was ever built.

## When to Apply

- Any time a new worktree is created under `.worktrees/` (or a sibling checkout) for this repo.
- Before trusting a green `pytest`, `pnpm typecheck`, or `pnpm test` result from a worktree that was just created — confirm the venv was built there and `pnpm build` ran there first.

## Examples

```bash
# Wrong: false green
ln -s ../../main-checkout/packages/core-py/.venv packages/core-py/.venv
packages/core-py/.venv/bin/pytest -q   # passes, but ran the main checkout's code

# Right
cd packages/core-py
python3.11 -m venv .venv
.venv/bin/pip install -e '.[dev]'
.venv/bin/pytest -q   # runs this worktree's code
```

## Related

- `packages/core-py/README.md` — the venv setup steps this doc builds on (does not call out the worktree/symlink pitfall)
- `docs/plans/2026-09-27-2059-chore-models-deps-refresh-plan.md`, KTD8 — worktree layout for this refresh (names the venv command, not this failure mode)
