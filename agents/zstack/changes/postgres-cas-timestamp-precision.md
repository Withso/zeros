# Compare timestamp tokens at the precision that survives the round trip

- **Symptom.** A retention candidate read from PostgreSQL failed its own
  compare-and-set check even though no other writer changed the workspace.
- **Cause.** PostgreSQL retained microseconds in `stopped_at`; the driver's
  JavaScript `Date` and its ISO string retained only milliseconds. Comparing
  the round-tripped value directly with the original timestamp never matched
  rows with a sub-millisecond component.
- **Rule.** Match the precision of the serialized generation token, or carry
  an exact database revision when finer distinctions matter. For the existing
  millisecond stop token, compare `date_trunc('milliseconds', stopped_at)`;
  keep the state, sandbox and snapshot predicates that reject stale work.
- **Encoded in.** `CloudV2Store.beginRetention` and the retention claim/stale
  receipt cases in `apps/control-plane/src/cloud/store.integration.test.ts`.
  Guidance is in `skills/zstack-verify/SKILL.md`.
