# Alpha publication overlap

- Symptom: a candidate's initial barrier stopped on a tag/ledger mismatch even
  though the older publisher finished successfully moments later.
- Cause: ledger upload precedes rolling-tag movement, and independent read-only
  admission can observe that intermediate state.
- Rule: inspect both identities and publication outcome; only a validated
  ancestor mismatch can wait within a bound. Retry all frontiers and CI before
  admission, and leave persistent or unsafe states closed.
- Encoded in `playbooks/ci-red.md`, eval `alpha-publication-overlap`, and the
  real-frontier CLI regressions in `scripts/release/alpha-admission-overlap.test.ts`.
