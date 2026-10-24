# Keep provider intent through Stop and deletion

- **Symptom.** A snapshot save or restore allocation could finish after Stop
  or deletion, leaving a provider resource that the workspace row no longer
  knew to clean up. A lost provider reply made the same race harder to see.
- **Cause.** The requested lifecycle state was treated as proof that an
  outstanding remote operation had never taken effect.
- **Rule.** Persist the operation identity, pending intent and deadline before
  provider I/O. Preserve them across Stop and deletion, reconcile ambiguous
  replies with the same idempotency key, and record the recovered resource
  before retiring it. Do not hold a database transaction across provider I/O.
- **Encoded in.** Checkpoint restores: `restore_pending` is recorded before the
  replacement VM is created under a checkpoint-derived key, and
  `CloudV2Store.replaceSandbox` records it in any live state. Covered by the
  lost-reply, Stop and deletion cases in
  `apps/control-plane/src/cloud/lifecycle.test.ts` and
  `store.integration.test.ts`. Guidance is in `skills/zstack-verify/SKILL.md`.
