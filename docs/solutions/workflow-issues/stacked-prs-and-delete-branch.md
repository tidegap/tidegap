---
title: Merging the base of stacked PRs with --delete-branch closes the stacked PRs
date: 2026-10-17
category: workflow-issues
module: GitHub PR workflow (native-clients stack #63, #64, #65, #66)
problem_type: workflow_issue
component: development_workflow
severity: medium
applies_when:
  - "A PR is stacked on another PR's branch (its base is not main)"
  - "Merging the base PR with `gh pr merge --delete-branch` or the auto-delete setting"
tags: [github, stacked-prs, gh-cli, merge]
---

# Stacked PRs and `--delete-branch`

The native-clients work was a stack: #63 (foundation) under #64 (extension) and #65 (Mac app), with #66 on #65. Each stacked PR had its parent's branch as base.

## What happens

GitHub deletes the head branch of the merged base PR. Every PR whose base was that branch is **closed**, not retargeted. A closed PR whose base branch no longer exists cannot be reopened, and its base cannot be edited.

## Recovery

1. Recreate the deleted base ref at its old tip: `gh api repos/<org>/<repo>/git/refs -f ref=refs/heads/<base-branch> -f sha=<old-tip-sha>`. The sha is in the merged PR (`headRefOid`) or the closed PR's timeline.
2. Reopen: `gh api -X PATCH repos/<org>/<repo>/pulls/<n> -f state=open`.
3. Retarget: `gh api -X PATCH repos/<org>/<repo>/pulls/<n> -f base=main`.
4. Delete the recreated ref: `gh api -X DELETE repos/<org>/<repo>/git/refs/heads/<base-branch>`.

Do the steps in this order. Retarget before the delete, or the PR closes again.

## Prevention

- Merge the base **without** `--delete-branch`. Retarget each stacked PR to `main` first (`gh pr edit <n> --base main`), then delete the old branch.
- Or merge the stack bottom-up and retarget after each merge, before deleting anything.
- Turn off the repo's "automatically delete head branches" setting while a stack is open.

Related: `../developer-experience/folding-review-fixes-into-commits.md`.
