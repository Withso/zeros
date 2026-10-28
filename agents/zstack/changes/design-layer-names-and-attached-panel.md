Design layer names and attached properties panel

- Symptom: Layers hid authored names behind type labels; an accessibility label
  also masked data-name in the runtime. Cause: presentation reused the type
  classifier and name inference ranked aria-label first. Rule: keep authored
  names separate from type/capability classification and accessibility metadata.
  Encoded in design-layer-label.test.ts, design-runtime.test.ts and the real
  source transaction/undo test in design-web's adapter.test.ts.
- Symptom: moving the panel into a content wrapper left Motion behind during a
  held width drag. Cause: its derived CSS width variable still resolved on an
  ancestor, before the live value published on the new wrapper. Rule: resolve
  dependent geometry variables at the same owner that receives live updates;
  check geometry while the pointer is held, as well as after release. Encoded
  in ui-smoke-design-floating-chrome-edges.mjs.
- Symptom: width fixtures kept the default width, and a large-frame drag
  started below the viewport after adding the toolbar. Cause: fixtures used
  the previous CSS owner and available canvas height. Rule: assert the actual
  rendered width and that pointer gestures start inside the visible canvas.
  Encoded in ui-smoke-design-layout-children.mjs and
  ui-smoke-design-inline-tools.mjs; layout width fixtures use the canvas area.
- Rename browser coverage exercises Enter/blur exactly once, Escape, empty
  names, source rejection, stable IDs and accessibility, hidden surfaces and
  A → B → A owners. Inline inputs live in non-button treeitems so native text
  editing does not create nested interactive buttons or run tree shortcuts.
