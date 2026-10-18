# The type-check gate runs the native compiler

Symptom: on the owner's Mac a single agent-run `pnpm typecheck` held a 3.96 GB
`tsc` process at 127 % CPU, and several agents type-checking at once pushed the
machine into swap. On this repository's Linux sandbox, `typecheck:app` took
96.9 s / 4.1 GB cold, 12.5 s / 2.1 GB with no change and 15.7 s / 2.2 GB after a
one-line edit.
Cause: `tsc` 5.x checks the 930k-line desktop program on one thread.
Rule: `typecheck:app` and `typecheck:electron` run TypeScript 7 (`tsgo`, from
`@typescript/native-preview`, pinned). Measured on the same sandbox: 17.5 s /
4.6 GB cold, 3.8 s / 1.3 GB with no change and 3.0 s / 1.5 GB after a one-line
edit; `typecheck:electron` 21.2 s → 3.9 s cold. `typescript` 5.9 stays for
editors, ESLint, scripts that import the compiler API and the CI release-script
check, so code must compile under both. The typecheck-only configs disable
declaration output (TypeScript 7 reports declaration-portability errors even
with noEmit) and use their own build-info names, so switching to a branch that
still runs `tsc` 5.x keeps the native cache. The root config no longer sets the
removed `baseUrl`; the engine and Electron bundles are byte-identical without it.
Encoded by: `package.json` typecheck scripts, `tsconfig.typecheck.json`,
`apps/desktop/electron/tsconfig.typecheck.json`, `tsconfig.json`, and the
zstack-verify stale-state note.
