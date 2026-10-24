# Recovery semantics in a shared provider method must be opt-in

- **Symptom.** Making `saveSnapshot` inspect an existing named result before
  saving fixed retention retries, but could mark a new Computer build successful
  while keeping an older disk with the same name.
- **Cause.** Retention's persisted operation name identifies a retry. A build
  version such as `-v1` can repeat after a development database reset while
  Boat still holds the old snapshot. The shared method conflated those cases.
- **Rule.** Trace every caller before changing shared provider semantics. Make
  recovery of a prior result explicit for callers with a durable operation
  identity; preserve the existing behavior for other callers.
- **Encoded in.** The stale-name case in
  `apps/control-plane/src/cloud/boat.test.ts`: `saveSnapshot` always submits
  the current disk. The retention opt-in was removed with retention itself
  when checkpoints moved to object storage. Guidance is in
  `skills/zstack-verify/SKILL.md`.
