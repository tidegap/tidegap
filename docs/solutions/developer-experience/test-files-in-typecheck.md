---
title: "pnpm typecheck did not check test files: a second tsconfig per package found 107 errors and three real test bugs"
date: 2026-11-01
category: developer-experience
module: packages/core-ts, packages/cli, packages/mcp-server, packages/openclaw-plugin (tsconfig.test.json, the typecheck script)
problem_type: developer_experience
component: testing
severity: medium
applies_when:
  - "Adding a TypeScript package or changing a package's tsconfig.json or typecheck script"
  - "A test passes although its call does not match the function's type"
  - "Writing a test helper that builds a spec or options object for a core call"
tags: [typescript, typecheck, vitest, tsconfig, rootdir, allowjs, tests, ci-gate]
---

# Test files in `pnpm typecheck`

## Context

Each package's `typecheck` ran its build `tsconfig.json`. That config has `rootDir: ./src` and includes `src` only. Vitest strips types without checking them. So a type error in a test file passed the gate, CI and `preflight`. Batch 27 PR C (#203, plan KTD13) closed the gap.

## Guidance

- **One `tsconfig.test.json` per TypeScript package.** It extends the build config, sets `noEmit`, sets its own `rootDir`, and includes `src` and `test`. The `rootDir` override is required: with the build config's `./src`, every test file fails with TS6059, `noEmit` or not.
- **The `typecheck` script runs both:** `tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json`. CI, `preflight` and the gate already run `pnpm typecheck`, so no workflow changed. A separate `typecheck:tests` script was rejected: three places would each have to call it.
- **`@tidegap/cli` needs two more options.** `rootDir: ".."`, because the channel tests import the fake Telegram server from `core-ts/test/fixtures`. `allowJs` without `checkJs`, so the imports of the page's plain-JS modules resolve and are not checked.
- **Fix the test, not the check.** No `@ts-nocheck` and no new `any` casts. A `@ts-expect-error` needs a reason comment.
- **Prove the check bites.** Append `const mutationProbe: number = "a";` to one test file per package. `pnpm typecheck` must fail with TS2322 in that file. Revert it.

## Why This Matters

The first run found 107 errors in 33 files (#203 PR body, per package). The fixes changed types only, except for three real defects:

- `packages/core-ts/test/budget.test.ts`: `enqueueDue` put the task id inside the provider-call spec, where `enqueueProviderCall` ignores it. The named ids never applied. The id now goes in the defer options.
- `packages/core-ts/test/mixed-ledger-receipts.test.ts`: the signed receipt lacked the required `estimatedCarbonGCo2`, so the test signed a receipt that the production path never builds.
- `packages/cli/src/usage/claude-spend.ts`: `SpendOptions.limits` was typed from the `as const` defaults, so only the default values type-checked as overrides. It now takes any number per limit (a type change only; a test that passed a smaller limit did not type-check).

A test that passes for the wrong reason is worse than no test: it marks the behaviour as covered.

## When to Apply

- A new package: add the test config and the two-step script in the same PR.
- A test with type errors that "still passes": read the error before you cast it away.
- A PR adds a test file before the package has a test config: check that file by hand and say so in the PR body (#209 did).

## Examples

```json
// packages/core-ts/tsconfig.test.json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": true, "rootDir": "." },
  "include": ["src/**/*", "test/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

## Related

- `worktree-environment-setup.md`: run `pnpm build` before `pnpm typecheck` in a new worktree.
