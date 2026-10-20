# Design group selection smoke save boundary

- Symptom: Shift-click intermittently retained both selected layers after two
  fill edits, despite the visible fill values already matching the assertions.
- Cause: the smoke observed optimistic pixels. The submitted save could promote
  the source between pointer-down and pointer-up, correctly retiring that
  gesture under the canvas's source and runtime revision guards.
- Rule: join the prior edit and confirm the displayed selection's runtime
  generation before sending the next gesture. A longer assertion wait cannot
  recover an input that the owning lifetime has already retired.
- Encoded in `scripts/ui-smoke-design-group-selection.mjs` and its retained
  synchronization tests. Readiness shares one five-second budget; failures send
  no pointer input, and Shift is released even when the click fails. The original
  exact remaining-layer browser assertion and all product guards stay unchanged.
- Verification uses a held real fill transaction under Chromium CPU throttling,
  with a control that releases the same transaction before pointer-down. An
  ordinary loaded pass is recorded separately from the scheduled regression.
