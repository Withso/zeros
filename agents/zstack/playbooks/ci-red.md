# Playbook: CI red, flaky test or release failure

## Classify first

| Signal | Likely class |
|---|---|
| The failing test is unrelated to the diff and passes alone or on rerun | Flake (timing or load) |
| A runner or environment message, for example "containment environment not ready" | Infrastructure |
| Unexpanded names such as `tests-vitest (${{ matrix.part }}/4)`, or roll-ups that fail with "Invalid … selection/result" | A run cancelled because a label or ready state changed. Ignore it; the newest run for the head counts. |
| CodeQL new alerts | Real. Fix it, even when it is in test code. |
| Assertion in the code you changed | Real |

## Rule out the environment

- Diagnose the earliest fixture-admission failure before inferring a semantic
  conflict. Check free space and inodes after ENOSPC, the umask (`022` in CI),
  capabilities (this sandbox bypasses file modes), the Node major and missing
  host tools. `agents/zstack/gotchas.md` lists the known ones.
- Before any Git-bearing check, remove `GIT_DIR`, `GIT_WORK_TREE`,
  `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`,
  `GIT_COMMON_DIR` and `GIT_CEILING_DIRECTORIES` from runner and fixture
  environments: `cwd` alone does not isolate Git. Never route a test through
  the shared checkout's metadata.
- Compare a failing gate's policy revision with the workflow producing its
  input: PR CI loads some readers from the trusted base, so rerunning an old
  event keeps its old policy.

## Act

- **PR CI:** rerunning only the failed jobs is fine for a flake or infra
  failure. Record that it was a rerun.
- **A flake twice** becomes a deterministic fix PR. Reproduce it under load,
  find the race (often teardown, not the asserted behavior) and fix the
  fixture without weakening the contract: hold the real boundary, wait for the
  actual workload's acknowledgement, and never widen production limits to
  stabilize CI (principle 14).
- **Serializable races:** a losing writer can exhaust bounded retries before
  the winner commits. Hold both COMMIT schedules separately and assert each
  exact outcome; don't accept any error or widen production retries.
- **Database test timeouts:** first trace whether the changed code runs in the
  failing test, then reproduce with bounded database transit delay. Give only
  that case a justified budget (migration-ladder cases share the ladder's
  30-second budget) and keep every assertion and production deadline.
- **Shared test helpers:** run every direct and transitive importer before
  READY. Lifecycle doubles must include newly owned services and keep every
  cleanup assertion; a value import in a shared schema can pull an engine
  implementation into the control-plane graph
  (`scripts/__tests__/control-plane-scope.test.ts`). A suite that imports
  another package's sources needs that package installed in its CI job.
- **Workflow entry points:** run each changed entry with its actual interpreter
  and loader in a fresh child with no inherited secrets or Git routing. Values
  hidden before the runner logs its environment belong in Actions secrets.
- **Pixel comparisons:** reproduce the runner's font rasterization before
  changing a tolerance; use grayscale text (`--disable-lcd-text`) for both
  references and leave application rendering unchanged.
- **Read-only corruption fixtures:** temporarily permit writes, restore the mode
  in `finally`, keep the byte length when testing a digest mismatch, and assert
  the closed failure code.
- **Pinned inventories:** a new guide under an audited directory changes its
  layout contract; run `scripts/__tests__/repository-layout.test.ts` and update
  the owning index.

## Releases and main

- **Release workflows:** never rerun only the failed jobs; carried producer jobs
  break signed-build provenance. Use a full rerun or a new push. A release that
  started while another deploy was in flight can fail its forward-only barrier;
  the next successful release supersedes it.
- **Alpha release edit 5xx:** retry only the identical metadata edit for the
  exact release object, within the publication lock and original job lifetime.
- **Alpha tag/ledger disagreement:** the publisher uploads the ledger before
  moving the tag. Read both identities and the prior job outcome before
  proposing a repair; never rewrite publication history to pass a gate.
- **Main red:** the CI incident bot opens a `fix(ci): restore …` PR. A green
  rerun at the same head resolves it; still land the deterministic fix.
- **Audit-only main red:** compare the advisory's published and updated times
  with the last green main run before blaming a PR. Repair the root and
  control-plane graphs, never override a pinned provider runtime across a major
  without reading its use, and bound each exception in
  `scripts/__tests__/audit-exceptions.test.ts`. A production-only audit misses
  build and test tools and the standalone lockfiles; audit each graph.
- **Dependency automation:** check the Renovate Dependency Dashboard's last
  update and the runtime radar mode before waiting for a bot PR. Push
  `pnpm licenses:generate` output to bot PRs or supersede them. Triage Electron
  advisories as production even though the `--prod` audit skips them.
- **Cleanup blocking a repair release:** scope the readiness projection to the
  artifact being released, keep operational alerts, and test cleanup alone and
  beside each critical class before adjusting the gate.
