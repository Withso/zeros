# Cloud turn feedback and retirement

- Symptom: a durable cloud bubble appeared before its working indicator; the
  footer and Stop feedback waited for receipt or cancellation retirement.
- Cause: one lifecycle flag served both immediate presentation and authority.
  Native completion could not override an accepted receipt, and Stop awaited
  migration and journal/network work before changing the UI.
- Rule: publish the head bubble and existing pending-turn owner atomically
  after the journal commit. Record exact client start/end facts separately from
  immutable retry bytes, cancellation operations and delivery epochs. Preserve
  the original start through reload and freeze the ending at native completion
  or the Stop click. Native outcomes may correct optimistic Stop; late text and
  unrelated receipts cannot restart it or retire a successor.
- Encoded in `cloud-prompt-runtime.test.ts`, `cloud-turn-feedback.test.ts`,
  `cloud-stop-lifecycle.test.ts` and the real composer/outbox browser smoke
  `ui-smoke-cloud-turn-feedback.mjs` in both themes. Hold journal, HTTPS,
  receipt and native boundaries separately; assert the first actual frame.
- Review lessons: preserve legacy-turn ownership when durable delivery is
  enabled mid-turn; keep a stopped queued head distinct from a retained old
  foreground ID; never clear a new pending owner from old-receipt cleanup.
  Native outcomes preserve the Stop operation ID and true provider failures.
  Unchanged old terminal facts must retain store references. Optional journal
  presentation metadata is validated independently of the saved retry payload.
- Keep safety predicates on native activity when visual feedback ends, including
  independent background work. Failure to save a possibly successful Stop is
  unconfirmed, not a refusal. Retry an acknowledged cancellation by its exact
  message and authoritative cancellation custody; optional presentation cannot
  authorize a new epoch. Retrying the original private fence preserves later
  queued sends (`sessions-store-agent-working.test.ts`, channel/runtime tests).
- Review caught the sent prompt still sitting in the composer while HTTPS was
  held, although the bubble and indicator were immediate. Private commit and
  remote acceptance need separate callbacks: release only the unchanged
  submitted editor/draft after the journal publishes, once, and retain it on a
  failed write. Assert the emptied composer in the first bubble frame, plus
  newer typing during the commit and reply windows (`cloud-composer-wake.test.ts`,
  `cloud-prompt-runtime.test.ts`, and the same browser smoke).
