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

- **Database fixture disk pressure:** check free space and inodes after ENOSPC
  before interpreting downstream failures. Reuse the worker's Postgres instance;
  stop obsolete disposable clusters before removing their data directories.
  Preserve the interrupted run as environment evidence, then rerun the gates.
- **Git fixture isolation:** before any Git-bearing check, remove `GIT_DIR`,
  `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`,
  `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_COMMON_DIR` and
  `GIT_CEILING_DIRECTORIES` from the runner and fixture subprocess environments.
  `cwd` alone does not isolate Git. Create fixture repositories in fresh temporary
  directories; reproduce inherited routing only against another disposable
  repository. Never route a test through the shared checkout's Git metadata.
- **Cross-package imports:** a value import in a shared schema module can pull
  an engine implementation into the control-plane graph. Run
  `scripts/__tests__/control-plane-scope.test.ts` after changing those imports.
  When the implementation belongs to engine boot, keep the shared dependency
  type-only and inject it there; test absent and rejecting implementations.
  Do not widen the CI input list merely to hide an unintended dependency.
- **Lifecycle fixture drift:** a test calling a class lifecycle method on a
  partial object must retain the real prototype helpers. Keep injected service
  failures and every cleanup assertion; new diagnostics must not replace the
  original aggregate error. Run the failed-cleanup suite alongside retirement
  tests, including Local and cloud logging behavior.
- **PR CI:** rerunning only the failed jobs is fine for a flake or infra
  failure. Record that it was a rerun.
- **Read-only corruption fixtures:** temporarily permit fixture writes, restore
  the original mode in `finally`, and keep the byte length unchanged when testing
  a digest mismatch. Assert the closed failure code. On Linux, a nonzero UID can
  still hold filesystem-bypass capabilities; reproduce permission failures with
  inherited, ambient and bounding capabilities dropped, not just another UID.
- **Pinned documentation inventories:** adding a guide under a directory with
  an exact file allowlist also changes its layout contract. Run
  `scripts/__tests__/repository-layout.test.ts` explicitly, update the owning
  index and preserve existing entries. Docs lint and an interrupted full-root
  run do not verify that inventory boundary.
- **Permission-sensitive suites on a shared host:** the Dev environment and
  auth-profile suites refuse group-writable state. Under a `0002` umask they
  fail with "private, user-owned files". Rerun them with `umask 022`, which
  matches CI, before suspecting the diff.
- **Release workflows:** never rerun only the failed jobs. Carried producer
  jobs get new IDs and break signed-build provenance. Use a full rerun or a new
  push. A release that started while another deploy was in flight can fail its
  forward-only barrier; the next successful release supersedes it.
- **Alpha release edit 5xx:** retry only the identical metadata edit for the
  exact repository release object, within the publication lock and original
  job lifetime. Keep the bound, cancellation and closed diagnostics; never
  broaden this to creation, assets or tag writes. Execute the actual workflow
  step against asserted synthetic executables to verify upload/tag ordering.
- **Alpha tag/ledger disagreement:** the previous publisher uploads the ledger
  before moving the tag. Read both identities and the prior job outcome before
  proposing a repair. Initial admission may wait only for an already validated
  ancestor mismatch, with a bound and fresh CI/frontiers on retry. Never admit
  unequal identities or manually rewrite publication history to pass a gate.
- **A flake twice** becomes a deterministic fix PR. Reproduce it under load,
  find the race (often teardown, not the asserted behavior) and fix the
  fixture without weakening the contract.
  Portable cgroup fixtures must sample real births and owned groups without
  depending on unrelated host cgroup metadata that they replace with fake IO.
  Capture the closed kernel state before changing a process reader: a dead X
  task can retain its birth after group/session fields are cleared. Validate
  live identities strictly, and wait for a complete census across real exits.
  A busy launch wrapper is not command readiness: hold the launch gap, then
  await the actual workload's acknowledgement before testing owner handoff.
  An empty mutation queue does not prove that a gesture awaiting preview or
  admission has completed. Hold that earlier boundary and join the original
  retained gesture before asserting either a save or a refusal; unrelated
  inspector reads are not evidence that the gesture was admitted.
- **Shared test helpers:** enumerate and run every direct and transitive importer,
  including callers reached through other fixture helpers, before READY. Keep
  fault injection explicit when replacing a reader: incomplete or unavailable
  observations must still refuse an empty proof in the consuming tests.
- **Serializable context races:** a losing writer can reuse the committed context,
  observe committed capacity, or exhaust its bounded retries before the winner
  commits. Hold both COMMIT schedules separately from the first INSERT barrier;
  assert each exact outcome, the stored identity/capacity bound and each caller's
  original deadline. Uniqueness does not promise both calls succeed. Don't rely
  on database victim selection, accept any error or widen production retries.
- **Native journal process races:** initialize each handle before racing CAS
  writes. A bounded lock refusal is a distinct losing outcome, not process EOF
  or a successful conflict. Retain exactly one confirmed winner, its exact
  stored custody, and a stale-revision check from the loser. Hold real locks
  through open/write refusal, preserve unexpected child failures with bounded
  stderr diagnostics, and never widen production busy limits to stabilize CI.
- **Database test timeouts:** first trace whether the changed code actually runs in the failing test,
  then reproduce with bounded database transit delay. Large lifecycle or pagination fixtures can
  legitimately exceed the default 5 s test budget. Give only that case a justified bounded timeout,
  keep every assertion and every production deadline, and test callback overlap with held work and
  observed completion, never with a sleep or a manual worker tick.
  Migration cases that execute the whole SQL ladder pay every migration transaction, even when
  their final assertion is small. Reuse the ladder's explicit per-case budget for a reproduced
  timeout; retain the real empty/populated upgrade and ledger-permission assertions.
  Classify test-only budget fixes as timing scenarios: fixed-test replay overlays would erase
  the failing timeout in the parent.
- **Main red:** the CI incident bot opens a `fix(ci): restore …` PR. A green
  rerun at the same head resolves it; still land the deterministic fix.
- **Cleanup blocking a repair release:** scope the readiness projection to the
  artifact being released. Preserve operational alerts and exact artifact
  qualification. Classify combined lifecycle/rotation signals in one consistent
  read; test cleanup alone, cleanup plus each critical class, unknown reasons
  and unchanged v1 receipt parsing before adjusting the gate. Release tests use
  `--config scripts/release/vitest.config.ts`; confirm the matched file count,
  since a mixed command can pass while a path outside its include list is ignored.
