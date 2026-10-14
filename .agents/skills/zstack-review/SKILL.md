---
name: zstack-review
description: "Independently review a Zeros diff against the repository's invariants: Local and cloud placements, owner switching, stale responses, exact-key state, security boundaries, locks and time windows, compatibility and test determinism. Verify every finding before reporting it."
---

<!-- GENERATED from agents/zstack/skills/zstack-review/SKILL.md by scripts/design-system/build-design-docs.mjs. Edit it there, then run `pnpm design:docs`. -->

# zstack-review

Review the complete diff, then each test against the behavior it claims to
cover. A finding needs evidence, either a file and line plus a concrete
failing input, or a reproduction. Drop anything you can't substantiate.

## Checklist

**Placements and state** (`RULES.md` §8 and the `zeros-workspaces` skill)
- Local Personal, organization-local and cloud owners all behave correctly.
  Switching A → B → A never shows another owner's data, and late responses
  are fenced.
- Keyed server state keeps the last confirmed exact-key snapshot while
  revalidating. Retained hidden surfaces stay inert: no polling, shortcuts or
  measurement.

**Security**
- No credential appears in logs, arguments, test output, receipts or URLs that
  are shown.
- File checks open the file once (`O_NOFOLLOW`) and validate that descriptor.
  Never `stat` a path and then read it by path; CodeQL flags this even in
  tests.
- Authentication changes don't relax a check that ordinary users rely on. A
  test-only path stays gated, pinned, audited and absent on other channels.
- SQL is parameterized and RLS context is transaction-local.

**Concurrency and time**
- Read paths don't take mutation locks. Real mutations keep their locks, CAS
  checks and revocation publication.
- Deadlines are anchored at the start of the observation, so a slow response
  can't extend authority.
- Windows tolerate ordinary clock skew and are compared against documented
  bounds.

**Compatibility**
- New wire fields are optional and N/N−1 tested. Persisted keys and
  externally observable identifiers are preserved or migrated explicitly.
- Retired request fields are not sent. Check the current route contract, not
  memory.

**Tests**
- Bug fixes include a regression that fails without the fix.
- No fixed sleeps standing in for contention. Hold the condition until the
  code under test has actually observed it.
- Provider-shaped fixtures match the real wire shape. Qualify against a real
  response at least once.

## Output

List findings most severe first. Each one gets a one-line claim, the evidence
and a concrete failure scenario. Then list what was verified as correct, so
the integrator knows the review's scope.
