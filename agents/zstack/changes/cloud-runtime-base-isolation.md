# Isolate base registration from ordinary Computer admission

- Symptom: registering a new base can make ordinary Computer builds fail while
  that base's runtime is still unqualified.
- Cause: newest-base discovery happens before qualification lookup; qualification
  and registration are separate operations. Pinning only the claim adapter also
  leaves observation and image production selecting a different base.
- Rule: zstack-review follows an optional admission policy through the locked
  owner row, observer and every producer. Explicit targets refuse rather than
  fall back; saved pins retain their original authority. Test absence, promotion,
  rollback, revocation waits and A-to-B-to-A organization changes independently.
- Encoded in the six PostgreSQL groups in `runtime-base-rollout.integration.test.ts`,
  the real worker-factory controls, strict configuration tests and the seeded
  `seeded-runtime-base-rollout` eval. Runtime-image tests also retain independent
  target progress, failed-candidate fairness and bounded per-base retention across
  successive releases. A missing immutable digest is a fixture error, not a red.
