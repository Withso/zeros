# Engine edits need the whole typecheck

**Symptom.** Retiring `git.resolveConflict` removed `GIT_REVIEW_MUTATIONS`,
but `engine/change-events.ts` still read it. `pnpm typecheck:app` passed;
37 tests failed later in the run.

**Cause.** Engine sources compile under `typecheck:electron`, not the app
project, so an app-only typecheck never saw the dangling import.

**Rule.** After editing anything under `apps/desktop/src/engine/` (or a
protocol export the engine imports), run the full `pnpm typecheck`, not a
single project, before the adjacent suites.

**Encoded in.** The root `typecheck` script, which runs both projects.
Target: `agents/zstack/skills/zstack-verify/SKILL.md`.
