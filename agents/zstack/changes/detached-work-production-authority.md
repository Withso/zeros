Detached authority needs production-path tests as well as isolated lifetime tests.

- Symptom: a healthy accepted-work helper can still bypass command validation,
  miss the dispatch pump, reuse a terminal native host, or depend on a desktop
  actor while warming context. Cause: unit authority tests stop before the
  production consumers. Rule: enter through the engine command handler and
  trace the exact principal through context, dispatch and positive retirement.
  Encoded in the accepted-work, boot queue and native pump regressions.
- Symptom: ordinary network transit rejects a healthy context or push challenge.
  Cause: comparing independent send/receive clocks as if they started together.
  Rule: clamp received proofs to the original local request budget and queue
  early health challenges at the next shared observation slot. Never extend
  authority from delivery time. Encoded in delayed-context, challenged-health
  and staggered fan-in tests.
- Symptom: a checkpoint start pause retires running work, or a native source
  check blocks account retirement with the opposite lock order. Rule: keep
  start admission separate from active lifetime; a consumer already holding
  the workspace must refuse a contested earlier source lock. Encoded in the
  checkpoint-pause engine test and the real-PostgreSQL retirement contention test.
- Review worktrees need their own workspace dependency links. A shared
  node_modules symlink can silently test another branch's workspace packages.
  Frozen installation restored the correct SDK in the sender correction review.
- Populated-schema upgrade tests also exercise historical runtime writers.
  An unconditional write to a new opt-in column broke legacy transfer seeding.
  Keep the legacy transfer write shape unless the fresh successor offers the
  version; verify the old schema lacks the column and migration preserves the
  disabled default. Current-schema negotiation tests alone missed this path.
