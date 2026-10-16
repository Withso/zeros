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
- A destructive tool guarded by a connection URL validates the effective
  target: refuse query parameters (pg applies `?host=` over the URL host),
  accept only loopback IP literals (`127.example.com` is a name), resolve
  `localhost`, and allow-list the database name.

**Concurrency and time**
- Read paths don't take mutation locks. Real mutations keep their locks, CAS
  checks and revocation publication.
- Deadlines are anchored at the start of the observation, so a slow response
  can't extend authority.
- Windows tolerate ordinary clock skew and are compared against documented
  bounds.
- A jittered retry has a minimum delay. Full jitter can draw zero, and a
  zero-delay retry of a failure that arrives without yielding re-enters the
  loop through promise callbacks and starves the event loop.

**Database cost**
- Price every recurring query: CPU per call times calls per second, against
  the database's CPU budget (its vCPU share times 1000 ms/s). On a 1/16-vCPU
  database (62.5 ms/s), a 25 ms query once a second uses 40% of it.
- Background loops are state-aware. Archived and stopped resources are not
  polled at running cadence; derive the next due time from the state.

**Compatibility**
- New wire fields are optional and N/N−1 tested. Persisted keys and
  externally observable identifiers are preserved or migrated explicitly.
- Retired request fields are not sent. Check the current route contract, not
  memory.

**Tests**
- Bug fixes include a regression that fails without the fix.
- No fixed sleeps standing in for contention. Hold the condition until the
  code under test has actually observed it.
- When several sources can wake a loop (hint, poll, retry timer), assert
  structural conditions, not absolute timing floors on `performance.now()`
  deltas: a gate cannot tell a late hint from the first poll.
- Provider-shaped fixtures match the real wire shape. Qualify against a real
  response at least once.
- Replay provider updates through the shared history reducer as well as the
  producer. An emitted replacement can look correct while an immutable consumer
  silently ignores it.

## Output

List findings most severe first. Each one gets a one-line claim, the evidence
and a concrete failure scenario. Then list what was verified as correct, so
the integrator knows the review's scope.
