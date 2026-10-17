---
title: Releases ship by GitHub OIDC trusted publishing; setup limits and traps found on the way
date: 2026-10-16
updated: 2026-10-17
category: tooling-decisions
module: .github/workflows/release.yml, mcp-registry.yml
problem_type: tooling_decision
component: tooling
severity: medium
applies_when:
  - "Changing how npm, PyPI, ClawHub or the MCP Registry get published"
  - "Setting up or debugging trusted publishers"
  - "Driving a registry web form with a browser agent"
tags: [release, oidc, trusted-publishing, npm, provenance, pnpm, clawhub, github-environment]
---

# Releases by trusted publishing

PR #60, plan `docs/plans/2026-10-16-1509-chore-trusted-publishing-plan.md`. Release order and web settings are in the PR and `CONTRIBUTING`. This doc keeps what is not obvious from `release.yml`.

## Decisions and traps

- **npm cannot be set up with the old token.** npm 11.19 has `npm trust github|list`, but a bypass-2FA granular token gets 403 even on `npm trust list`. npm also warns these tokens are being restricted for direct publishing. Set the trusted publisher in the npm web form per package.
- **The npm web form needs account 2FA with a security key**, and asks for the key again on every save. Plan for three saves (three packages) and a human at the key.
- **Use `pnpm pack` then `npm publish <tgz> --provenance`.** `pnpm publish` gets OIDC only from pnpm 11. Pack with pnpm so `workspace:` ranges are rewritten; check the tarball has none and has the right `repository.url`.
- **`npm publish --dry-run` fails for an already-published version** unless `--force` is passed. Use `--force` in the dry run only, never in the real publish. The real job skips versions that exist, so "Re-run failed jobs" finishes a partial release.
- **Create the GitHub environment (`release`) before the first tag.** A job that names a missing environment creates it with no protection. Set the required reviewer and the `v*` tag-only deployment rule first.
- **ClawHub supports GitHub OIDC** (`clawhub package trusted-publisher set`). Once set, a manual publish needs `--manual-override-reason`.
- **ClawHub OIDC accepts only `workflow_dispatch`.** The mint endpoint checks `event_name` against `allowedEvents: ["workflow_dispatch"]` (openclaw/clawhub `convex/lib/githubActionsOidc.ts`). A tag-push token gets 400 (PR #73, run 39059018065), and clawhub 0.23.1 swallows 400/403/404 and falls back to the stored login, so the only error is "Not logged in. Run: clawhub login". The tag push skips the `clawhub` job; publish with `gh workflow run release.yml --ref vX.Y.Z -f dry_run=false -f clawhub_only=true`. `--dry-run` returns before auth, so the verify job cannot rehearse the mint. A dispatch reads `release.yml` from the tag, so only tags from v0.19.1 on have `clawhub_only`. On a full dispatch the `clawhub` job accepts a skipped `pypi` only when `clawhub_only=true`; otherwise a skipped `pypi` means `npm` failed.
- **npm trusted publisher: enable "Allowed actions → npm publish".** Configs created after 2026-09-03 allow only `npm stage publish` by default. With that default the job exchanges its OIDC token and uploads provenance, then `npm publish` fails with `E403 OIDC permission denied for this action`. The error does not name the setting. Open each package's trusted publisher form and tick `npm publish` (three saves, each with the security key).
- **"Pending validation" can last up to 48 hours.** npm shows it after the config is saved and until the first OIDC publish proves it. A valid config can still say "Pending validation" on release day; read the publish log, not the badge.
- **The MCP Registry needs no setup:** OIDC grants `io.github.tidegap/*` (see `mcp-registry-metadata-and-package-readmes.md`).
- **Keep `verify` free of OIDC and environment.** Pull requests run it as a rehearsal; only a `v*` tag ref (a tag push, or a dispatch with `dry_run=false` on the tag) reaches the publish jobs.
- **A release needs three approvals, not one.** GitHub asks for approval once per job that names the environment: `npm` and `pypi` in the tag-push run, `clawhub` in the dispatch run. One approval would need one publish job.
- **`npm publish npm/x.tgz` is not a file path.** npm reads `npm/x.tgz` as the GitHub repo shorthand `github:npm/x.tgz`. Use `./npm/x.tgz`. The dry run used an absolute path, so it did not catch this.
- **The default `run:` shell has no `pipefail`.** `cmd | tee file` passes when `cmd` fails. Put `set -o pipefail` first.
- **The MCP Registry trusts any OIDC token from the repo** (namespace only, no workflow or environment claim). `mcp-registry.yml` therefore fails unless it runs on the tag `v<version>`. Retry: `gh workflow run mcp-registry.yml --ref vX.Y.Z -f version=X.Y.Z`.
- **The first OIDC release must be a new version.** 0.18.0 is already on every registry from the laptop, and tag `v0.18.0` exists. npm shows "Pending validation" until the first OIDC publish.

## Secrets hygiene: browser-agent downloads

The Playwright MCP browser saves downloads into `<repo>/.playwright-mcp/`. A 2FA setup there downloaded the npm recovery codes into the repo folder. The folder is gitignored, but the codes must be moved out of the repo right away (to a password manager), and the file deleted. Brief any browser agent that touches 2FA: no download, or set the output directory outside the repo first.

## Related

- `version-lockstep-check.md` (the old publish-before-merge order is superseded)
- `mcp-registry-metadata-and-package-readmes.md`
- `docs/solutions/workflow-issues/renaming-a-published-multi-package-project.md`
