# Design viewport and image residency

- Symptom: distant Design frames kept their complete React surfaces even with
  two live documents. Cause: the canvas mapped the entire snapshot and its
  camera store settled only after input stopped. Rule: query current camera
  demand at animation-frame cadence, publish only membership changes, and keep
  interaction geometry independent of DOM lifetime. Encoded in
  `design-frame-residency.test.ts` and `ui-smoke-design-residency.mjs`, including
  held pan and group movement with an offscreen selected member.
- Symptom: compressed picture budgets admitted unbounded decoded pixels.
  Cause: Blob entries charged zero decoded bytes and component lifetime owned
  display pins. Rule: reserve image pixels before decode, include replacement
  overlap, release hidden and skipped React publications, and distinguish
  encoded retention from display ownership. Encoded in `design-preview-cache`,
  `design-image-residency` and `design-frame-previews` tests. The 256-frame
  overview regression requires a sufficient smaller raster instead of turning
  budget refusals into missing pictures.
- Symptom: count-limited engine screenshots could retain hundreds of MiB.
  Cause: per-image and entry limits lacked an aggregate retained-data budget.
  Rule: account replacement, LRU reads and owner retirement together, preserve
  explicit export success, and retain only immutable known fields. Encoded in
  `engine/design/__tests__/screenshots.test.ts`.
- Symptom: a late render or encoder could replace the current disk generation
  or restore pictures after workspace removal. Rule: check owner lifetime,
  source generation and production eligibility after each async boundary,
  including persistence; mark work complete only after accepting its result.
  Same-generation resolution reuse is allowed through a zoom change. Encoded
  in `design-frame-previews.test.ts`, with held render/encode promises and
  owner, visibility and removal round trips.
- Symptom: many source updates could prepare incoming documents together.
  Rule: retain admission until the buffer actually detaches or is promoted,
  not merely until cancellation or handshake. Encoded in
  `design-document-replacements.test.ts`. This rule does not claim to fix the
  separate native/in-frame capture cancellation protocol.
- Review caught a regression where admission interpreted a history commit's
  transient runtime/snapshot mismatch as a new reload, losing saved in-document
  generations. Derive replacement intent when the authoritative generation
  changes; reserve and mount it separately. `ui-smoke-design-layout-gestures`
  retains the edited element across rapid history confirmation and requires
  immediate redo while persistence is held. Both the original-renderer control
  and the corrected path pass; the initial admission implementation fails.
- Evidence boundary: browser component counters and JS heap cannot qualify
  native protocol retention, physical memory, GPU cost or Mac energy use. The
  native baseline refuses a non-Mac host, non-Electron endpoint or srcDoc-only
  fixture. Native measurements remain required before performance claims.
- Review caught native-document accounting retaining a charge after protocol
  recovery switched the same buffer to srcDoc. Count the actual document route,
  not the availability of its capability. The frame-recovery browser scenario
  compares counters with mounted protocol buffers before handshake, after
  fallback and after native reconnection.
