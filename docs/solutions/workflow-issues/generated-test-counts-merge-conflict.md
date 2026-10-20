---
title: "Merge conflict in generated test counts (README and tests.generated.ts): take main's, regenerate, commit"
date: 2026-10-20
category: workflow-issues
module: README.md, apps/web/src/lib/tests.generated.ts, scripts (gen:tests)
problem_type: workflow_issue
component: development_workflow
severity: low
applies_when:
  - "A merge of main into a feature branch conflicts in README.md and apps/web/src/lib/tests.generated.ts"
tags: [merge, conflict, generated, gen-tests, parallel-prs]
---

# Generated test counts conflict on merge

Every PR merged on 2026-10-19/20 (about 13) hit it. Each branch adds tests, `pnpm gen:tests` rewrites the counts in `README.md` and `apps/web/src/lib/tests.generated.ts`, and two branches changing the counts always conflict. Hand-merging the numbers is wrong, since the sum of two counts is not the regenerated count.

## Recipe

1. `git merge origin/main`; the conflict is in those two files (and only those; if others conflict, resolve them normally first).
2. Take main's side of both files: `git checkout origin/main -- README.md apps/web/src/lib/tests.generated.ts`.
3. `pnpm gen:tests` (regenerates both from the merged tree).
4. `git add README.md apps/web/src/lib/tests.generated.ts`, commit the merge (`git -c core.editor=true commit`).
5. `pnpm gen:tests:check` must pass. Commit message of a follow-up regeneration: `chore: regenerate test counts`.

Also regenerate (same idea) `docs.generated.ts` and `llms-full.txt` with `pnpm gen:docs` when they conflict.

A later merge of main into an open branch can conflict again; repeat the recipe. Do not resolve it before the last merge into main unless the branch needs the files.
