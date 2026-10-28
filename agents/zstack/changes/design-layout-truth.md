# Keep the canvas true to the layer's CSS while it moves and nests

- Symptom: after nesting a frame by drag, the inspector read X 0, Y 0 while the
  layer was drawn elsewhere; turning on vertical, start-aligned auto layout kept
  the children far from the top-left edge; distance labels described that
  offset; a frame's Clip content read unchecked although the canvas clipped it.
  Dragging a child, its selection box stayed behind the layer; dragged out of
  its frame, only an empty box followed the pointer. Nesting a frame also
  selected the page's first frame and moved the camera to it.
- Cause: relocation saved the drop position as a transform translate beside a
  box at 0, 0, and every flow conversion cleared left/top but never that
  translate. The drag box repainted only when a runtime reply matched the
  newest pointer sample, which never happens during motion. The drag image only
  reused pixels cached for the exact generation. The transfer published its
  follow-selection after the snapshot that removed the dragged frame, so page
  binding pruned the selection first and the camera revealed its fallback.
- Rule: position is left/top; a transform holds only the pose. Any conversion
  into a flow (auto layout on, flow drop, cross-frame drop) drops a relocation
  offset, recognized only by its own signature, never an authored transform.
  Paint a gesture's prediction on every sample and let the measurement settle it
  at rest; a reply that answers an older sample must not be the only paint.
  Publish a selection that follows a structural write in the same step as the
  snapshot, and move the camera only for explicit selections. A frame is its own
  document: its own layer always clips at the frame's edges.
- Encoded in: `packages/protocol/src/design-relocation.ts`
  (`designRelocationStyles`, `designRelocationFlowStyles`), engine
  `relocation-source.ts` / `frame-lifecycle.ts`, renderer
  `design-layout-values.ts`, `design-auto-layout-values.ts`,
  `design-layout-drag.ts`, `design-layout-drag-gesture.ts`,
  `design-drag-presentation.ts`, `design-layout-transfer.ts`; regressions in
  their Vitest suites and the nesting, nested-offsets, free-drag-sync,
  drag-out-pixels and scrub-ordering UI smokes.
