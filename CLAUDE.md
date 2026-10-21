# Tidegap

Carbon-aware scheduling for agentic AI workflows. Tidegap runs non-urgent LLM tasks at the cleanest grid hour before a deadline (72-hour forecast, 31 regions), routes long deadlines through provider Batch APIs, and writes a signed carbon receipt per task to a local SQLite ledger (`tidegap verify`). Public repo `tidegap/tidegap`, Apache-2.0, pnpm workspace (Node >=20, pnpm 9).

## Where things live

- `packages/core-ts` (`@tidegap/core`): scheduler, feeds, ledger. `packages/core-py` (`tidegap` on PyPI): Python twin, must stay in parity.
- `packages/cli` (`@tidegap/cli`): CLI, daemon, local UI server `src/ui/server.ts` (+ `api.ts`, `events.ts`, `settings.ts`), static UI in `packages/cli/ui` (plain JS and CSS, no framework).
- `packages/mcp-server` (`@tidegap/mcp`), `packages/openclaw-plugin`, `packages/claude-code-plugin` (commands, hooks, skills; markdown only).
- `apps/web`: Next.js site on Vercel. Docs sources in `apps/web/content/docs`.
- `apps/macos`: SwiftPM `TidegapKit` (logic and tests) plus the Xcode app. `apps/extension`: browser extension.
- `scripts/`: generators and checks. `scripts/qa/`: QA harness. `compat/`: shims for the old package names.
- `docs/solutions/` (learnings, by topic), `docs/spec/` (`ui-client-api.md` is the UI HTTP API contract), `docs/plans/` (current programs, newest last), `CHANGELOG.md`.

## The gate

Run from the repo root:

```
pnpm build && pnpm typecheck && pnpm gen:tests:check && pnpm gen:docs:check && node scripts/qa/docs-drift.mjs
```

- Unit tests: `pnpm --filter <name> test` (`@tidegap/core`, `@tidegap/cli`, `@tidegap/mcp`, `@vitalini/tidegap`) or `pnpm test` for all packages; `pnpm --filter ./apps/web test` for the site.
- Python: `cd packages/core-py && .venv/bin/python -m pytest` (and `.venv/bin/ruff check .`). A new worktree needs its own venv: `docs/solutions/developer-experience/worktree-environment-setup.md`.
- Swift: `cd apps/macos/TidegapKit && swift test`. The tests use Swift Testing; the XCTest line "Executed 0 tests" is a false alarm. Trust `Test run with N tests ... passed`.
- QA flows: `pnpm qa <area>` where area is `cli | telegram | channels | mcp | release | docs | ui | all`. Add `--prefix <p>` to name the run. `ui` drives a real browser: run it alone, never beside another stream. `all` runs it last.
- Full pre-release set: `pnpm preflight`.

## Generated files

Never hand-edit these:

- README test-count markers (`<!-- tests:start -->` block) and `apps/web/src/lib/tests.generated.ts`: `pnpm gen:tests`.
- `apps/web/src/lib/docs.generated.ts`, `apps/web/public/llms-full.txt`: `pnpm gen:docs`.
- Also generated: data tables (`pnpm gen:data`), brand assets (`pnpm gen:brand`), images (`pnpm gen:images`).

Merge conflict in a generated file: take main's version, run the generator, commit. See `docs/solutions/workflow-issues/generated-test-counts-merge-conflict.md`.

## Hard rules

- QA and tests use an isolated `HOME`. Never read or write the developer's real `~/.tidegap`, `~/.claude` or `~/.config/tidegap`. `scripts/qa/env.mjs` builds the sandbox.
- Never print a token or secret. Channel secrets live in the secrets file; see `docs/solutions/best-practices/channels-one-step-connect-secrets-file-and-atomic-lock.md` and `docs/solutions/best-practices/channels-url-policy-and-child-process-rules.md`.
- Never commit key material (keys, certificates, tokens). Generate test certificates at test time.
- `CHANGELOG.md`: add entries under the open `[Unreleased]` heading only.
- A feature PR never bumps versions and never cuts a release. `pnpm check:versions` enforces version lockstep.
- Public repo: no local paths, owner names, account or token names, or scratch notes in committed files. See `docs/solutions/workflow-issues/public-repo-hygiene.md`.
- Tests that signal processes or use fake time: see `docs/solutions/developer-experience/deterministic-process-kill-tests.md` and `docs/solutions/logic-errors/time-of-day-bugs-and-fake-time-sweeps.md`.

## Look here first

- `docs/solutions/` has five topic folders: `best-practices`, `developer-experience`, `logic-errors`, `tooling-decisions`, `workflow-issues`. Grep it before investigating.
- UI or desktop client work: `docs/spec/ui-client-api.md`, then `docs/solutions/best-practices/loopback-web-ui-hardening.md`.
- Current programs: `docs/plans/` (latest dates).
- Each package has a `README.md`; docs-drift checks the claims in them against the code.

## Git conventions

- Branch off `main`; worktrees go in `.worktrees/<branch>` (gitignored).
- Conventional Commits: `feat(web): ...`, `fix(macos): ...`, `docs(solutions): ...`, `chore: ...`, `test(web): ...`, `refactor(...)`. Merge commits are `Merge pull request #N from tidegap/<branch>`.
- Run git with `git -c core.editor=true -c sequence.editor=true` so no editor opens. Write the message to a file with a unique name and pass `-F`.
- Fold review fixes into the commit they belong to: `docs/solutions/developer-experience/folding-review-fixes-into-commits.md`.
- Never use `--delete-branch` on a stacked PR base: `docs/solutions/workflow-issues/stacked-prs-and-delete-branch.md`.
