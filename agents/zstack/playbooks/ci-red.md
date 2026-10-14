# Playbook: CI red, flaky test or release failure

## Classify first

| Signal | Likely class |
|---|---|
| The failing test is unrelated to the diff and passes alone or on rerun | Flake (timing or load) |
| A runner or environment message, for example "containment environment not ready" | Infrastructure |
| Unexpanded names such as `tests-vitest (${{ matrix.part }}/4)` | A cancelled duplicate run, often caused by adding a label. Ignore it; the later run counts. |
| CodeQL new alerts | Real. Fix it, even when it is in test code. |
| Assertion in the code you changed | Real |

## Act

- **Cross-package imports:** a value import in a shared schema module can pull
  an engine implementation into the control-plane graph. Run
  `scripts/__tests__/control-plane-scope.test.ts` after changing those imports.
  When the implementation belongs to engine boot, keep the shared dependency
  type-only and inject it there; test absent and rejecting implementations.
  Do not widen the CI input list merely to hide an unintended dependency.
- **PR CI:** rerunning only the failed jobs is fine for a flake or infra
  failure. Record that it was a rerun.
- **Release workflows:** never rerun only the failed jobs. Carried producer
  jobs get new IDs and break signed-build provenance. Use a full rerun or a new
  push. A release that started while another deploy was in flight can fail its
  forward-only barrier; the next successful release supersedes it.
- **Alpha tag/ledger disagreement:** the previous publisher uploads the ledger
  before moving the tag. Read both identities and the prior job outcome before
  proposing a repair. Initial admission may wait only for an already validated
  ancestor mismatch, with a bound and fresh CI/frontiers on retry. Never admit
  unequal identities or manually rewrite publication history to pass a gate.
- **A flake twice** becomes a deterministic fix PR. Reproduce it under load,
  find the race (often teardown, not the asserted behavior) and fix the
  fixture without weakening the contract.
- **Serializable capacity races:** a losing writer can either observe committed capacity or exhaust its
  bounded serialization retries before that commit. Hold both commit schedules and assert their distinct
  errors plus the final capacity bound. Don't rely on database victim selection or accept any error.
- **Database test timeouts:** first trace whether the changed code actually runs in the failing test,
  then reproduce with bounded database transit delay. Large lifecycle or pagination fixtures can
  legitimately exceed the default 5 s test budget. Give only that case a justified bounded timeout,
  keep every assertion and every production deadline, and test callback overlap with held work and
  observed completion, never with a sleep or a manual worker tick.
- **Main red:** the CI incident bot opens a `fix(ci): restore …` PR. A green
  rerun at the same head resolves it; still land the deterministic fix.
- **Cleanup blocking a repair release:** scope the readiness projection to the
  artifact being released. Preserve operational alerts and exact artifact
  qualification. Classify combined lifecycle/rotation signals in one consistent
  read; test cleanup alone, cleanup plus each critical class, unknown reasons
  and unchanged v1 receipt parsing before adjusting the gate. Release tests use
  `--config scripts/release/vitest.config.ts`; confirm the matched file count,
  since a mixed command can pass while a path outside its include list is ignored.
