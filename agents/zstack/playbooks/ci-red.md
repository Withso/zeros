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

- **PR CI:** rerunning only the failed jobs is fine for a flake or infra
  failure. Record that it was a rerun.
- **Release workflows:** never rerun only the failed jobs. Carried producer
  jobs get new IDs and break signed-build provenance. Use a full rerun or a new
  push. A release that started while another deploy was in flight can fail its
  forward-only barrier; the next successful release supersedes it.
- **A flake twice** becomes a deterministic fix PR. Reproduce it under load,
  find the race (often teardown, not the asserted behavior) and fix the
  fixture without weakening the contract.
- **Main red:** the CI incident bot opens a `fix(ci): restore …` PR. A green
  rerun at the same head resolves it; still land the deterministic fix.
