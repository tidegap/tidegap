---
title: Keep operations logs, token names and local paths out of a public repo
date: 2026-10-17
last_updated: 2026-11-01
category: workflow-issues
module: docs/, .gitignore, git config
problem_type: workflow_issue
component: development_workflow
severity: medium
applies_when:
  - "A repo that held private notes becomes public"
  - "Writing plans, solution docs or PR bodies that mention accounts, paths or tokens"
  - "Writing a test fixture, a test constant or a docs example that needs a session id"
  - "Adding a value to scripts/check-hygiene.mjs"
tags: [public-repo, privacy, gitignore, git-author, docs, session-id, fixtures, check-hygiene, git-grep]
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

`pnpm check:hygiene` runs in CI and in `pnpm preflight`. It fails on each value listed in `scripts/check-hygiene.mjs` (a leaked session id, a session trailer, a session link) in the path or content of any tracked file. It knows only those values, so the grep above still applies. When a new kind of leak is found, add its value there.

## Session ids in fixtures, and how the check searches (#212)

An agent writes the session id it runs in into the tests and examples it writes. One real Claude Code session id reached about 20 files: CLI hook fixtures and transcripts, test constants in four packages, the README example, a plan, doc comments and one signed receipt vector. A Codex fixture carried a real Codex session id in its file name and its body.

- **Fixtures and examples use synthetic ids.** A Claude Code session: `11111111-2222-4333-8444-555555555555` (short form `11111111`). Other ids: `00000000-0000-4000-8000-00000000000N`. A brief that lets an agent write tests names the synthetic id to use.
- **Search file names, binary files and any letter case.** The first version ran `git grep -n -I -F`. It missed the id in a file name (`git grep` searches content only), in a binary file (`-I` skips them) and in upper case. `scripts/check-hygiene.mjs` now matches every `git ls-files -z` path, then runs `git grep -n -o -i -F` without `-I`. `-o` prints only the match, so a long or binary line stays small.
- **Build each pattern from parts,** so the script never matches itself. The parts still hold a short form of the value: the check stops new copies and does not hide a value that is already in the public history.
- **Use the narrowest pattern that has no legitimate hit.** The bare trailer name and the bare session-link domain match rule text in `docs/plans/`, so the check uses the trailer with its colon and the link with its path. The macOS home-folder prefix stays out of the check: tests use fake homes under it, and a pattern for the owner's own path would put the owner's name in a public file. The manual grep above covers it.
- **Rename a fixture file without changing what it means.** The Codex usage reader orders rollout files by the time in their names, so the renamed file kept its time and only the id changed.
- **A signed vector that holds the value** is re-signed in its own commit: the one allowed change to an existing vector (`../best-practices/signed-receipt-additive-fields.md`).
- **Test the check.** `scripts/check-hygiene.test.mjs` plants each kind of hit in a temp git tree (content, case, binary file, file name, trailer and link, an untracked file that must not count). It runs in the CI `node --test` step and in `preflight`.

Open: the check knows only the listed values, so a new real id passes until someone adds it. The old ids stay in git history, and possibly in packages published before #212 (a doc comment in the core).
