# Repeated local checks must reuse unchanged work

Symptom: on a 16 GB Mac, agents re-running `pnpm typecheck` took 13–18 minutes
and 4 GB per tsc while swapping; `pnpm lint` took 2–4 minutes per run.
Cause: every run re-checked and re-linted the whole program from scratch,
though an agent's edit touches a few files.
Rule: local verification commands keep incremental state outside source
(`node_modules/.cache/zeros-typecheck`, `node_modules/.cache/zeros-eslint`).
Lint caching is safe only while no rule is type-aware. CI's fresh node_modules
still performs full checks.
Measured (this repository, Linux sandbox): typecheck:app 72.6 s / 4.0 GB cold,
8.7 s / 2.0 GB warm, 10.2 s after a one-file edit; lint 42.7 s → 1.5 s warm.
Encoded by: tsconfig.typecheck.json and apps/desktop/electron/tsconfig.typecheck.json
(`incremental`), and the root `lint` script (`--cache --cache-strategy content`).
Proposed target: zstack-verify, local verification cost.
