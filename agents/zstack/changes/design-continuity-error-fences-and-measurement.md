# Design continuity: retired errors and actual mutation boundaries

- Symptom: an old preparation failure exposed an error after hide/show, an
  owner round trip, a newer selection, or the start of a local edit.
- Cause: successful warm replies checked source/cache generation and active
  demand, but rejected promises escaped before those checks.
- Rule: apply the same ownership fence to successful and failed asynchronous
  replies. A current failure stays actionable; a retired failure cannot become
  the new visit's error. Bound replacement work and stop it for hidden owners.
- Encoded in `design-workspace-revalidation.test.ts`: real cache/engine seams,
  active-failure controls, cold-lane waits, demand changes, owner/hide transitions,
  edits, invalidation/removal, and the existing batch/attempt limits.

- Symptom: a delayed transaction fixture appeared to prove fast style editing,
  although inspector writes had never entered that delayed operation.
- Cause: single-node styles use `design.node.styles`; structural/multi-node
  edits use `design.transaction.apply`. Waiting only for final DOM state also
  missed intermediate creation/inspector gaps.
- Rule: trace the actual producer and record which requests were delayed.
  Sample the intermediate presentation, mark the input event rather than the
  automation call, and preserve both failed and corrected evidence. Treat rAF
  observations as diagnostics, separate from native presentation/CPU budgets.
- Encoded in `scripts/ui-smoke-design-continuity.mjs` and the query-flagged
  workspace harness: bounded request records, rAF state/actual-style sampling,
  exact owner returns, hidden retirement, and pending-style/creation overlap.
  Production profiling reports render work per React commit separately from
  development timings; source identities and raw observations accompany it.

- Measurement pitfalls: an iframe can hand off to a ready cached screenshot,
  and React bailout fibers can retain old profiling durations and PerformedWork
  flags. Count every real frame representation; inspect the production retained
  deck when measuring owner switches; deduplicate render starts across fiber
  alternates. Keep an observation tail after first readiness to catch deferred
  retirement, and record a full requested profiling window. Never classify a
  missing selector or historical render timing as a product regression.
- The standalone browser fixture uses inline srcdoc runtimes. A production
  harness build therefore omits packaged Electron CSP only in the emitted,
  loopback-served harness HTML; it does not alter the application CSP. Preserve
  the failed startup and identify this fixture difference in its report.

- Symptom: a warm fallback frame reloads and briefly disappears on an owner
  return even though its iframe DOM node was retained.
- Cause: disabling its cache read passed a null key and erased the render's
  data, so the iframe navigated to an empty srcDoc and back on reactivation.
- Rule: retained document identity includes its loaded source, not just its
  element. Read an exact cached payload passively while hidden; do not create
  cold cache entries, change LRU order, subscribe or fetch. Keep retirement
  under the existing bounded document owner. Assert no load/srcDoc change in
  warm-return smoke coverage, alongside the physical resource-retirement checks.
- Encoded in `use-design-frame-document.ts`, its real hook/cache presentation
  tests for owner/source boundaries and cache capacity, and the strengthened
  `ui-smoke-design-hidden-documents.mjs` browser regression.
