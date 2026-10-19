# Bound automatic qualification before filtering history

- Symptom: approving a new base made background qualification walk historical
  releases, allocating another disposable VM after each finished run.
- Cause: the selector removed qualified and terminal runtimes before taking the
  newest candidate. Each tick therefore exposed an older release; a failed head
  was treated as permission to fall back.
- Rule: choose a bounded release window before inspecting qualification or run
  history. A failed newest release blocks automatic fallback on the same base
  compatibility. Preserve existing queued work, forced retries and cleanup.
- Encoded in `runtime-qualification-window.integration.test.ts`: a real
  PostgreSQL history of 151 releases drives the worker and counts adapter
  creates, with failure, prior qualification, moving-window, compatibility and
  explicit-queue controls. The `runtime-qualification-release-window` eval keeps
  the six original selector assertions as regressions.
