# Auto layout preserves authored compositions

- Symptom: converting a CSS artboard to Auto layout left only its background
  visible; its text and selection bounds moved below the clipped viewport.
- Cause: the conversion normalized every direct child to relative positioning
  and measured pixel dimensions. A full-frame absolute background became the
  first flex child. Parent setup also introduced containing blocks during
  ordinary layout changes, and nested selections could overwrite child
  positioning depending on selection order.
- Rule: distinguish existing flow content from free drawings and overlays.
  Preserve absolute decoration beside normal flow, fixed layers, backgrounds
  pinned on every edge, and responsive sizing. Reuse the direct-only flow-origin
  marker when freezing children so repeated toggles preserve participation.
  Keep existing positioning anchors; when freezing would reanchor an overlay,
  restore native block flow. Apply container setup before child placement and
  make an already-selected layout a no-op.
- Encoded in `design-auto-layout-values.test.ts`, the real Chromium/runtime/
  source-adapter `design-auto-layout-rendering.test.ts`, and
  `ui-smoke-design-layered-layout.mjs`, included in the existing Auto layout
  smoke scenario. The tests retain the drawn-child behavior and cover source
  reload, exact-source undo/redo, overlays, responsive dimensions, entrance
  animations, Play/Stop, layer rename, hidden children, nested selections and
  repeated layout toggles.
- A screenshot alone cannot distinguish animation opacity from displaced
  geometry. Inspect the authored source and browser bounds, then verify the
  repaired file at its saved viewport. Never repair every matching document
  automatically; re-read the particular file the user identified and preserve
  its stable IDs and concurrent edits.
- The serial smoke run also exposed fixture leakage: the picture scenario
  persisted a resolved directory before a legacy Motion fixture omitted that
  identity. The saved-editing guard correctly refused the mismatched owner.
  `ui-smoke-design-pictures.mjs` now keeps its persistence/reload checks in an
  isolated browser context. Keep owner guards intact when fixing test setup;
  verify the original serial sequence, not only each scenario alone.

The replay entry is prepared in the task receipt and can be pinned to the real
fix revision when this uncommitted change is published. A fabricated `fixedBy`
or a pending entry in the strict corpus would make the verification misleading.
