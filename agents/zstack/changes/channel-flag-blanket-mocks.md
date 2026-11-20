# A new dev/alpha channel flag is on in every existing renderer test

**Symptom.** Adding `unified-workspaces` (dev and alpha) silently turned the new
layout on in older suites: Vitest runs the renderer as the dev channel, and
suites that mock `isFeatureEnabled: () => state.allowed` enable every flag at
once. Suites that encoded today's owner rules then failed, or passed while
exercising the new branches without asserting them.

**Cause.** `CHANNEL` resolves to `dev` under Vitest, and value-based mocks
answer for every feature name.

**Rule.** Gate a new layout at one owning helper or prop. Suites that pin
today's behavior mock `isFeatureEnabled` by name with the new flag off; the
new behavior gets its own `*-unified` (flag-on) tests. `pnpm test:ui-smoke`
also runs dev, so a flagged UI change must update or extend its smoke
scenario in the same change.

**Target.** `gotchas.md` (renderer flags).
