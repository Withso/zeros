# Follow-up steering and background queue ownership

- Reopened Claude/Codex chats disabled Send now → adoption restored the runtime
  route without initialization metadata, and catalog refresh skipped missing
  metadata → restore capabilities for the exact adopted owner and treat missing
  support as unknown → `refresh-agent-model-catalog.test.ts` and the real queue
  browser smoke exercise reopening all three providers.
- Queue dispatched after Claude's foreground result while background work
  continued → enqueue/drain tested foreground status alone and buffered task
  snapshots behind animation frames → use native process work in both gates,
  publish work snapshots synchronously, and release after the final report →
  `queue-workflow.test.ts` and `ui-smoke-subscription.mjs` cover retained work.
- Cloud Send now skipped deferred draft preparation → only FIFO dispatch
  encoded attachments → prepare the selected row before native steering and
  fence every await against Stop, account, workspace and execution replacement →
  `queue-workflow.test.ts` preserves payload and cancellation ownership.
- Delayed workflow snapshots could hold or release a replacement's queue →
  workflow routing accepted a stable chat id without checking its execution →
  fence every live-work snapshot before using it for queue admission →
  `sessions-store-background-tasks.test.ts` covers stale native workflow updates.
- Isolated callback harnesses failed after adding shared dependencies → AST
  extraction does not carry imports into its VM → supply the real helper in
  each affected harness and run all send-path suites → the cloud wake,
  runtime-upgrade and turn-failure suites retain their existing assertions.
- A browser background regression initially emitted on the native UI bus →
  agent control events belong to the RuntimeClient bridge → fixtures must
  publish provider-shaped messages through the production subscription →
  `harness-subscription.tsx` and its background queue browser assertion.
