---
title: Keep operations logs, token names and local paths out of a public repo
date: 2026-10-17
category: workflow-issues
module: docs/, .gitignore, git config
problem_type: workflow_issue
component: development_workflow
severity: medium
applies_when:
  - "A repo that held private notes becomes public"
  - "Writing plans, solution docs or PR bodies that mention accounts, paths or tokens"
tags: [public-repo, privacy, gitignore, git-author, docs]
---

# Public repo hygiene

PR #72 cleaned the tree before the repo went public. The leaks were ordinary: they came from working notes, not from code.

## What leaked, and the rule for each

- **Operations logs** (hub submission log, marketing channels, SEO playbook, AI-discoverability notes): moved out of `docs/internal/` into a gitignored `development/` folder. Links to them read "(internal submission log, not in the repo)". Rule: a file that records what was done on which account or channel is not documentation.
- **Token names and credential hints**: a token's name tells an attacker what exists and when it expires. Write "a publish token", never its name or expiry.
- **Local paths** (home directory, Homebrew prefix, scratchpad): replace with `$HOME`, `<repo>` or a described location. Plan docs written by agents contain them by default.
- **Account and team names** (a Vercel team, a ledger's details): use the public name or drop the line.
- **`.claude/`**: gitignored. It holds local settings and agent state.
- **Git author**: commits use the GitHub noreply address, not a personal mailbox (`git config user.email <id>+<login>@users.noreply.github.com`). An old commit with the wrong address stays in history; fix the config before the first public push, not after.

## Check before a plan or solution doc is committed

`grep -rnE "/Users/|/opt/homebrew|\.npmrc|token" docs/` and read each hit. Browser-agent download folders are covered in `../tooling-decisions/trusted-publishing-release-workflow.md`.
