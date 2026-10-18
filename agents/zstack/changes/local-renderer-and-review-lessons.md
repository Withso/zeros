# Renderer performance validation and what an independent review still caught

Symptom: render-budget tests passed while a reply could still land above an
earlier recorded user row, a shared Git snapshot could hand a destructive guard
an observation older than a file on disk, and a throttled timer chain could stop
for good. Each of these escaped the authors' own suites and was found only by a
fresh-context review that reproduced it against the base.
Cause: performance changes were tested for the work they remove, not for the
ordering, freshness and liveness contracts the removed work used to provide.

Rules:
- A partial or early flush keeps per-owner arrival order: take only each owner's
  leading run of batchable updates; an earlier non-batchable update for the same
  owner holds everything after it.
- A shared read may serve badges and summaries, but a read that guards a
  destructive operation (Reset --hard, Clean) or answers "what is on disk now"
  never joins an observation that started before the caller asked. After an
  invalidation, start the next generation at once instead of queueing behind the
  old one's readers.
- A self-rearming timer chain re-arms on every early-return path, and its own
  tick is never throttled by the wall clock it scheduled from.
- Replacing a watcher backend replicates every exclusion the old backend applied
  through its options (private state, temp saves, nested tool worktrees), not
  only the shared ignore list.
- Never open untrusted PATH candidates synchronously; recognize helpers with
  `stat` (directory, exact size). CodeQL also reports any numeric-flag or
  read-only open on tmp-derived paths as an insecure temporary file.
- Render counters skip bailed-out child lists and reused fibers; every render
  budget also asserts the latest painted text, dispatch counts as well as
  commits, and closure growth across rounds (no-op functional setState calls
  retain updater closures until the next render).
- Normalize before comparing no-op session writes, and keep transcript
  serialization off hot scalar patches.
- Focus and visibility events share an in-flight read; cancelling a hidden
  trailing refresh preserves exact-key staleness; request successors pass the
  same activity gate as the polling timers. Surface activation is not window
  focus.
- Native readiness does not prove Local ownership: test cloud-scoped chat IDs
  with a physical cwd.
- Data warming lives outside Suspense, and the chosen warm or lazy component is
  latched so cold resolution does not remount it.
- Production harnesses that extract a callback into a VM context must be given
  the callback's new dependencies.

Encoded by: `local-change-freshness`, `credential-shim-recursion` (FIFO case),
`agent-notification-flush` (fast-path ordering), `updater-check-cadence`
(clock-skew chain) and `watch-host` (native exclusions) regressions, plus the
renderer harnesses under `apps/desktop/src/renderer/harnesses/`.
Proposed target: zstack-review checklist (ordering, freshness and liveness of
removed work) and playbooks/bug-fix.md.
