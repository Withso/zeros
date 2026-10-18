# Canvas selection and composer references

- Symptom: removing a selected frame reference made the same frame impossible
  to attach again, and multi-selection sent only the primary node. Cause: the
  composer suppressed an identity indefinitely and read the inspector's
  single-frame projection as the selection. Rule: retain a unique, primary-first
  canonical target collection; distinguish explicit selection events from
  refreshes; group only the UI, not submitted references. Encoded in
  `design-selection-collection.test.ts`, `composer-design-frame.test.ts`,
  `design-frame-attachment.test.ts` and the real-pointer selection reference smoke.
- Symptom: a dismissed parked draft could reveal another live selection after
  Send or a cold workspace restore. Cause: clearing its null pin released
  suppression without a new explicit selection. Rule: preserve explicit removal
  through send/clear and first owner observation; consume only the submitted
  selection epoch. Legacy drafts need the same capture-time fence. Encoded in
  the composer unit suite and the cold-restore browser scenario.
- Symptom: a restored parked draft could not clear its linked selection after
  restart. Cause: runtime intent and owner epochs survived in draft JSON but
  not in restored canvas state. Rule: persist frozen source identity and editing
  intent, never runtime epochs; keep in-session fences separate from the saved
  draft; prepared-workspace writers must retain that same saved snapshot.
  Encoded in cold-restore Send/removal and prepared-send regressions.
- Symptom: an away-and-back page response could match the same semantic key;
  a bounded runtime tree could also appear to prove a target was deleted.
  Cause: ownership lacked a transition revision and absence was treated as
  authoritative. Rule: fence confirmed owner transitions without retiring the
  first directory bind; prune missing nodes only from a complete exact-source
  tree. Encoded in the collection, detail-race and selection workflow suites.
- Symptom: a foreign workspace owner was rejected by the store but still
  published a null engine selection. Cause: collection workflows checked the
  owner's freshness without comparing its workspace. Rule: reject a foreign
  owner before runtime or bridge work, not only at the final store update.
  Encoded in three red-to-green selection workflow regressions.
- Symptom: cloud reference images failed even though the underlying frame
  capture worked. Cause: the nested reference, actor policy and context route
  each still assumed Local-only capture. Rule: qualify every owning boundary
  before removing a placement guard. Encoded in real synthetic cloud worker
  round trips, foreign-owner refusals and Local routing regression tests.
- Reference and mutation semantics differ: explicitly selected parents and
  children stay in the payload. Geometry consumes a separate topmost-target
  projection so an ancestor is moved once. The collection is bounded by the
  existing shared selection limit; no second persisted selection model exists.
- Browser coverage must preserve the caller's storage and viewport: a synthetic
  directory left behind by a shared-page scenario can retire the next fixture's
  selection. The held-marquee race starts inside a frame now that an outer
  marquee selects scene frames without runtime element reads; its stale-result
  assertion remains unchanged.
