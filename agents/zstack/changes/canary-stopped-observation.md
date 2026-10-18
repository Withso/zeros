# Preserve stopped compute through storage deletion waits

- Symptom: a successful fixture lifecycle left subsequent canaries refusing
  cleanup throughout a provider storage hold.
- Cause: DELETE threw after the reconciler observed stopped compute, discarding
  that observation and leaving the durable binding at `archiving`. The provider
  can report stopped compute independently of an unfinished or failed snapshot;
  fixtures seeded already stopped missed both the adapter and producer path.
- Rule: retain a positive stopped observation only under the same live delete
  claim, authority and binding. Keep fresh retirement proof, storage reservations
  and physical-erasure gates intact; do not report a partial snapshot as a
  resumable archive. Report retained storage separately from the lifecycle result.
  When claiming also closes a checkpoint gate, carry the authority epoch returned
  by that update so the worker does not reject its own observation.
- Encoded in `playbooks/bug-fix.md`, reconciler and retirement integration tests,
  Actions orchestration tests, and `canary-stopped-observation`.
