# Cloud restart presentation and authority

- Symptom: restarting on a cloud workspace returned to Local and lost the saved
  destination while the organization and workspace lists loaded.
- Cause: first auth installation used account-retirement cleanup, cloud metadata
  caches had no production owner/restore wiring, and cold membership became a
  confirmed empty catalog. The aggregate reader also silently stopped after
  sixteen organizations.
- Rule: restore presentation from main's stored identity before waiting for a
  bearer. Keep cached membership separate from authoritative `/v1/me`; only a
  complete observation can prove omission. Test the mounted lifecycle and real
  stores through reload, account/backend replacement, sign-out and A → B → A.
- Encoded in `cloud-startup-lifecycle.test.ts`, `account-presentation.test.ts`,
  `cloud-workspace-catalog-reads.test.ts`, the database-backed multi-membership
  `/v1/me` test, and the real organization-switcher browser smoke. The snapshot
  checks include corrupt envelopes, byte/row bounds, large logos, exact scoped
  native IDs, deletion and preservation of Local navigation.
- Review follow-up: identity publication must retire the previous bearer first;
  a failed old resync cannot clear a new session or restore an account while
  native sign-out is pending. Held IPC regressions in `stored-identity.test.ts`
  and `auth-provider-identity.test.ts` cover those races.
- A complete organization-scoped observation can prove a row was removed before
  the global catalog is confirmed. Pass that exact removal evidence to live chat
  and navigation cleanup (`cloud-catalog-removal.test.ts`).
- Long menus must measure their constrained height before the initial selected
  row scroll. Keep the one-shot observer through roving-focus ref replacement,
  disconnect after scrolling or unmount, and verify focus and viewport visibility
  in the real browser (`scripts/ui-smoke-personal.mjs`).
- Review caught a stale disk envelope after an oversized replacement. Invalidate
  the old snapshot when the new one cannot fit; exercise actual catalog and chat
  writers after removing the previously persisted row.
- Run whole adjacent test directories: a hand-picked selection missed the
  lifecycle-invalidation harness after its effect changed. Test fixtures imported
  by the control plane must stay within its existing CI input scope; keep the CP
  generator in its integration test instead of importing a desktop fixture.
- Organization navigation is another owner-scoped selection. Persist bounded
  workspace/chat memories, observe real store navigation, and restore with the
  existing atomic action without creating a wake intent. Test the actual sidebar
  round trip and reload, plus Local/organization-local/cloud isolation, account
  and backend replacement, membership loss, and deletion in
  `organization-navigation.test.ts`.
- A navigation observer alone can miss an already-open target while its catalog
  is cold. Record the outgoing owner against current metadata in the switch
  callback too; retain the regression where metadata arrives without another
  workspace or chat selection.
- Transcript follow-up: a cache is presentation, never send/queue/edit authority.
  Exercise the real ChatView/provider with every network/native promise held at
  first paint, plus stable row/DOM references and draft retention after edits
  and deletions (`ui-smoke-cloud-transcript-paint.mjs`, both themes).
- Router provenance must survive provider reattachment when the exact same
  window survives. A lagging mirror cannot replace a known worker tail; a partial
  or invalid empty window cannot erase cached history. These regressions live in
  `transcript-bind-presentation.test.ts` and `cloud-transcript-hydrate.test.ts`.
- Async generation fences alone do not cover a failed disk purge followed by a
  renderer restart. Rotate a durable lifetime before purge, serialize mutations,
  and hold reads, index loads and writes across account A → B → A. Keep a failed
  purge/restart regression in `cloud-transcript-cache.test.ts`.
- Generalizing a cache must preserve the existing placement's behavior, not
  only its record namespace. Review caught reduced Local budgets, doubled size
  accounting, stricter decoding and lost pending writes. Keep Local's original
  character units, lazy index load, decoder and writes through memory eviction;
  give cloud an explicit additive budget through constructor options. The
  separate `local-transcript-cache-compatibility.test.ts` covers those contracts
  without changing the original Local tests. Cloud alone bounds pending captures
  through held I/O/release and validates nested rows, oversized replacements and
  same-length edits in `cloud-transcript-cache.test.ts`.
- Size truncation must not prevent mirror catch-up or let a matching prefix
  stand in for original content. Preserve a bounded original-row signature with
  provisional worker presentation. Carry the existing cloud `turnOpening`
  through hydration and reconcile prompt-only edits even when tail rows match;
  cover both cases in the cloud hydrate and real router tests.
