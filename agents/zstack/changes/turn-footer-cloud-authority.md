# Turn footer authority across placements

- Symptom: sharing the Local footer UI did not produce cloud turn changes.
  Cause: the worker refused turn history, and its mirrored transcript had no
  disk-authoritative file summary. Rule: trace each placement's real data path
  before assuming a shared component provides feature parity. Encoded in
  `apps/cloud-worker/src/workspace/__tests__/turns.test.ts`,
  `apps/cloud-worker/src/__tests__/turn-recording.test.ts` and
  `scripts/ui-smoke-turn-changes.mjs` for all three providers and placements.
- Symptom: an older imported prompt erased a completed cloud turn's files.
  Cause: whole-row replacement accepted the stale mirrored summary. Rule:
  reconstruct worker-owned summary fields from the authoritative turn record
  at the import boundary; do not accept unrecorded snapshot claims. Encoded
  in the stale-import/restart regression in `turns.test.ts`.
- Symptom: keyboard focus fell back to the document when Show more disappeared.
  Cause: expansion removed the focused button. Rule: hand focus to the first
  revealed row on keyboard expansion. Encoded in the footer browser smoke.
- Review reproduced a late background edit lost during terminal capture, a
  missing workspace refresh after that capture, refs surviving chat deletion,
  and oversized historical patches failing instead of returning metadata.
  Hold the first capture while background completion arrives, assert a scoped
  refresh after persistence, verify deletion preserves the other chat's refs,
  and test both single and aggregate byte limits. These checks live in
  `turn-recording.test.ts` and `turns.test.ts` above.
- Chat deletion also invalidates the exact workspace's history picker, not just
  its conversation list. The worker relay regression verifies that publication.
- Process diagnostics must show executable names rather than complete command
  lines: host-injected authentication arguments can otherwise enter tool output.
