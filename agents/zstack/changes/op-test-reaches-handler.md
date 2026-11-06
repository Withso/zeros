# A new op needs a test that reaches its handler

**Symptom.** `gh.prRerunFailed` shipped calling a name the engine's git barrel
didn't export. Its validation tests passed, because each threw before the call;
only a narrow typecheck caught it (2026-11-06).

**Cause.** Vitest transforms without type-checking, so a missing export imports
as `undefined` and fails only when called.

**Rule.** Give each new workspace op one test that reaches its handler with
valid input, and type-check the changed files before committing. Where the full
`pnpm typecheck` runs out of memory, a tsconfig listing only the changed files
plus the `.d.ts` files is enough.

**Encoded in.** `service.test.ts` ("hands a full head to the GitHub re-run").
Target: `gotchas.md` (verification).
