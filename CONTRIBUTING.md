# Contributing to Tidegap

Thank you for considering a contribution. Tidegap is a small, carefully
scoped project: a carbon-aware scheduler for agentic-AI workloads, a
matching Model Context Protocol server, and a future spec proposal
for upstream MCP. Contributions in any of those three areas, plus
documentation and integrations, are welcome.

## Before you write code

If your change is small (one-line bug fix, typo, test addition) just
send the PR.

If your change is larger (new feature, API change, new provider
adapter, anything in the spec proposal layer) please **open an issue
first**. We want to discuss the shape before you invest time. The
24-week roadmap is in [`ROADMAP.md`](./ROADMAP.md); the success metrics in
section 8 reflect what we're aiming for in the v0.x line. Anything
outside that scope is welcome to discuss but may be deferred.

## Development setup

```bash
git clone https://github.com/tidegap/tidegap.git
cd Tidegap
pnpm install
pnpm build
pnpm test     # 18/18 should pass
```

Requirements: Node 20+, pnpm 9+.

`pnpm preflight` (see step 4 below) also runs `ruff check` and `pytest`
against `packages/core-py`, which needs its own virtualenv — pnpm does
not create one for you. From `packages/core-py`, run
`python3.11 -m venv .venv && .venv/bin/pip install -e '.[dev]'` once;
the `dev` extra pulls in `ruff`, `pytest`, `pytest-asyncio`, and the
`anthropic`/`openai` SDKs the adapter tests mock against.

## Workflow

1. Fork the repository.
2. Branch from `main` — name the branch after the area
   (`feat/anthropic-batch`, `fix/scheduler-timer-overflow`,
   `docs/spec/priority-field`).
3. Write the change. Add or update tests so they cover the new
   behavior.
4. Run `pnpm preflight` locally — wraps `pnpm typecheck && pnpm test
   && pnpm lint:py` (the last runs `ruff check` + `pytest` against
   `packages/core-py`). Make sure everything is green. The Python
   lint step is critical: CI runs ruff against `core-py` too, and a
   missed `RUF022` was the cause of the v0.10.0 main-branch CI red.
5. Commit. Use a clear subject; mention the package in scope where
   applicable (`feat(core): enforce carbonBudgetG in scheduler`).
6. Open a PR against `main`. Describe what changed and why, link
   any related issue.

CI will run the same `typecheck → build → test` matrix on Node 20
and 22; PRs need it green before merge.

## Code style

- TypeScript strict mode, `noUncheckedIndexedAccess`,
  `noImplicitOverride` (already configured in
  `tsconfig.base.json`).
- Prefer named exports.
- Prefer `Promise<T>` over `async` for public types; use `async` in
  bodies where it helps readability.
- Comments answer *why*, not *what*. Don't restate the code.
- No emojis in source or docs unless a specific user-facing surface
  explicitly calls for them.
- American English in code, comments, and documentation. Oxford
  comma.

## Tests

- `vitest` for both core and mcp-server. Tests live next to the
  package in `test/`.
- Aim for meaningful tests, not coverage-fishing. The reviewer who
  audited v0.1 explicitly called out that the 9 core-ts tests are
  *meaningful, not just structural* — keep that bar.
- New public-API surface needs at least one happy-path test plus
  one failure-path test (rejection, error type, etc.).

## Documentation

- Update `CHANGELOG.md` under `[Unreleased]` for any user-visible
  change.
- If you change the public API of `@tidegap/core` or `@tidegap/mcp`,
  update the relevant package README.
- If you add a new example integration, add a `README.md` to its
  folder.

## Releases

Tidegap follows [Semantic Versioning](https://semver.org). Releases
publish from GitHub Actions (`.github/workflows/release.yml`) by OIDC
trusted publishing: npm (with provenance), then PyPI and the MCP
Registry on the tag push, then ClawHub from a dispatch on the tag. No
registry token lives on a laptop or in GitHub secrets.

1. Release-prep PR: bump every file `pnpm check:versions` lists, date
   the CHANGELOG heading (`## [X.Y.Z] — YYYY-MM-DD`), update the README
   status line. Review it, wait for CI to pass, merge.
2. Wait for the CI run on the merge commit on `main` to pass, then
   tag that commit and push the tag:
   `git pull && git tag -a vX.Y.Z -m vX.Y.Z <merge sha> && git push origin vX.Y.Z`.
   `verify` waits up to 20 min for that CI run. If CI fails or takes
   longer, `verify` fails; re-run the failed jobs when CI is green.
3. Approve the `release` deployment twice in the Actions run: GitHub
   asks once per job that names the environment, so npm, then PyPI.
   The MCP Registry job needs no approval.
4. Publish ClawHub, and approve it once:
   `gh workflow run release.yml --ref vX.Y.Z -f dry_run=false -f clawhub_only=true`.
   ClawHub mints its trusted-publishing token only for a
   `workflow_dispatch` OIDC token, so the tag push skips the ClawHub job.
   Dispatch after the tag-push run finishes: both runs share one
   concurrency group, and a second pending run cancels the first.
   Keep `clawhub_only=true`: without it the MCP Registry step runs
   again and fails on the published version. The dispatch reads
   `release.yml` from the tag, so tags before v0.19.1 have no
   `clawhub_only` input; ClawHub 0.19.0 was not published.
5. The workflow checks the tag against the lockstep version, checks
   that the commit is on `main` and that CI passed on it, then
   publishes. Check the run summary.
6. Optional: write the GitHub Release notes from the CHANGELOG section.

Rehearsal (build and dry run only, nothing is published):
`gh workflow run release.yml --ref main`. Retry the MCP Registry step
alone, on the release tag ref:
`gh workflow run mcp-registry.yml --ref vX.Y.Z -f version=X.Y.Z`.
Use "Re-run failed jobs" on a failed run: npm, PyPI and ClawHub skip
versions already published. The MCP Registry step does not skip, so
do not re-run it after it passed.

To bump a release tool: for ClawHub, change the version in
`.github/release-tools/clawhub/package.json` and regenerate its lock
(`npm install --package-lock-only --ignore-scripts` in that directory);
for `mcp-publisher`, change `VERSION` and `SHA256` in
`scripts/install-mcp-publisher.sh` from the release's checksums file.
A change under `.github/release-tools/` gets a human read of the
lockfile diff before merge.

## Security

If you discover a security issue (especially around the MCP server's
handling of untrusted input or the Electricity Maps API key), please
report it privately by email rather than in a public issue. See
`SECURITY.md` (forthcoming) for the disclosure policy.

## License

By contributing you agree that your contribution will be licensed
under the Apache License 2.0, the same license as the project.
