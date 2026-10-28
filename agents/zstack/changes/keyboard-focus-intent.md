# Keyboard focus follows navigation and the latest interaction

- Symptom: ordinary typing lit up pointer-focused buttons and category tabs;
  palette typing missed search, and delayed operations interrupted newer edits.
- Cause: Chromium's native `:focus-visible` heuristic treats ordinary keypresses
  as navigation. Raw, descendant and shadow-root styles bypassed the shared
  controls. Deferred callbacks and editor commands retained focus authority
  after the user moved on; a frame could also run before its return control
  mounted.
- Rule: observe deliberate navigation separately from overlay close modality.
  Preserve text editing and composite-widget navigation. Capture focus intent
  before delayed work and recheck input, destination, visibility and owner at
  completion; restore newly mounted controls in their commit.
- Encoding: `focus-navigation.ts`, `deferred-focus.ts`, palette primitives,
  composer/terminal/Review/Design callers, and native review styles.
  `ui-smoke-focus.mjs`, `ui-smoke-code-focus.mjs`,
  `ui-smoke-design-focus.mjs`, attachment, transcript and terminal smoke races, and adjacent
  focus unit suites cover both themes and all supported owner/placement cases.
  `playbooks/ui-design.md` and the design/interaction guides name the browser
  and deferred-work checks.
- Verification lesson: exercise Tab with real key events instead of calling
  `.focus()` and naming it keyboard navigation. Reset the fixture's persisted
  composer draft before each independent attachment case; a successful earlier
  case must not turn the next case's Attach control into Remove.
