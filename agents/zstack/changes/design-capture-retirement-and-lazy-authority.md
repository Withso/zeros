# Design capture retirement and lazy source authority

- Symptom: rejecting a cancelled capture admitted another render while the
  first still owned decoder or encoder work. Cause: consumer lifetime stood
  in for resource cleanup, and native exports and iframe captures had separate
  guards. Rule: share native admission, retain it through terminal cleanup and
  refuse further capture when cleanup proof is lost. Encoded in the capture
  service, native admission, frame runtime and scheduler tests, including
  cancel-during-encoding and wrong-WebContents release.
- Symptom: a cancelled request could run again after terminal history pressure
  or a repeated late POST. Cause: cancellation was treated like an evictable
  successful completion. Rule: retain cancellation records until the original
  absolute deadline; expired metadata must not extend the request's authority.
  Encoded in `preview-jobs.test.ts` and `capture-service.test.ts` with held
  cleanup and bounded-history pressure.
- Symptom: lazy navigation could detach a layer dropped over an unloaded frame,
  reveal the wrong Layers selection or accept an old runtime's geometry.
  Cause: prepared frames were also the navigation catalog. Rule: metadata owns
  discovery and semantic selection; only exact prepared source authorizes
  edits. Fence async drop measurement and write admission by directory,
  preparation epoch and runtime generation even when retained bytes match.
  Frame deselection, empty-canvas activation and fit-selection also use the
  metadata path while preparation is held. Encoded in navigation, preparation,
  selection and layout-transfer regressions and the 256-description browser
  scenario, with real pointer input and explicit canvas focus for hotkeys.
- Symptom: hidden runtimes retained expensive documents indefinitely, while a
  simple retirement timer could lose an IME draft or unresolved text commit.
  Rule: account protected editing leases separately from bounded optional
  warmth; retire source/projection references as well as DOM. Encoded in
  hidden-document/cache tests and twenty browser hide/return cycles, plus
  held IME and delayed-commit scenarios.
- Symptom: a native performance fixture claimed image workload while its SVG
  references were unsupported and stripped. Rule: verify fixture resources
  survive real source preparation and decode before measuring their cost.
  Encoded in `scripts/__tests__/design-performance-fixture.test.ts`.
- Symptom: exact-frame audit readback rejected supported inspection-limit
  warnings, and lazy settlement retained old limit rows alongside fresh ones.
  Cause: renderer validation and replacement covered only three of the five
  runtime warning kinds. Rule: cover every supported kind in readback and
  retirement tests while preserving exact frame/generation validation.
  Encoded in `design-preparation-bridge.test.ts` and
  `design-workspace-cache.test.ts`, including cleared audits and other-frame
  and source-lint preservation.
- Evidence boundary: a Mac process launch is not a qualification result, and
  browser protocol stand-ins cannot prove native document retirement or total
  physical memory. Preserve missing native readback as unverified; retain the
  exact command, source hashes and report rather than inferring a pass.
