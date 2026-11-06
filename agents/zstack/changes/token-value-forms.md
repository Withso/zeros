# A token in a new value form needs the token identity test

**Symptom.** The merge-conflict colours were the first `hsl()` tokens with an
alpha. `pnpm check:ui` and `pnpm design:docs` passed locally, but the CI Vitest
lane failed in `scripts/__tests__/design-system-tokens.test.ts` with
"--conflict-current is not a supported color literal".

**Cause.** The generator already wrote `hsl(H S% L% / A)`, but the shared
palette reader (`scripts/design-system/token-palette.mjs`) and the test's
independent check only parsed `hsl()` without alpha. Neither gate reads every
token, and the "whole test directories you touched" rule missed the test,
because token sources live in `styles/tokens/` while their tests live in
`scripts/__tests__/`.

**Rule.** After any change to `styles/tokens/` or `styles/zeros-tokens.css`,
also run `scripts/__tests__/design-system-tokens.test.ts`. The first token in a
new value form is new input for every reader of the palette.

**Encoded in.** The test now covers `hsl()` with alpha in the reader and in
the identity check. Target: the tokens row of
`agents/zstack/skills/zstack-verify/SKILL.md`.
