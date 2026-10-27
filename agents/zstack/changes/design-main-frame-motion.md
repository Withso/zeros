# Main-frame motion uses the inspector's root

- **Symptom:** the inspector displayed an outer frame's authored animation, but
  the Motion toolbar was disabled and inspector actions immediately closed the
  timeline.
- **Cause:** Motion required `selectedNodeId`, while an outer frame deliberately
  keeps that field empty and exposes its style target through the runtime's
  frame-root details. Existing browser tests selected child layers only.
- **Rule:** tools that edit node styles must resolve the same target as the
  inspector, including explicit frame roots and document bodies. Keep selection
  eligibility separate from runtime readback readiness, and use the resolved
  target for draft ownership, preview, save and delete.
- **Encoded:** `design-canvas.tsx` and the main-frame/document-body browser cases
  in `scripts/ui-smoke-design-motion-refinements.mjs`. The regression opens from
  every Motion entry point, verifies root-targeted preview and persistence,
  isolates child/frame drafts through selection round trips, and closes on
  deselection. See eval `design-main-frame-motion`.
