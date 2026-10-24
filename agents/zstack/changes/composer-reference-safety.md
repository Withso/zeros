# Composer reference controls and suggestion lifetime

- Symptom: clicking a Create file reference could create a workspace and send
  the draft. Cause: a nested control inherited form submission behavior and
  source navigation had no Create boundary. Rule: reference controls declare
  their button type, source opening is explicit, and only the Create submitter
  or the editor's intentional shortcut submits. Encoded in the Create browser
  regression, including a submit event without a submitter.
- Symptom: quick pill removal could make Undo erase both insertion and removal.
  Cause: both actions shared a ProseMirror history group. Rule: close the history
  group before explicit pill removal. Encoded in the same browser regression.
- Symptom: a dismissed suggestion menu would not reopen for another query.
  Cause: React hid the menu while the editor's suggestion plugin remained
  active. Rule: dismiss both lifetimes together, including hidden/scope changes.
  Encoded in the shared composer smoke for Escape, reopen and hide/reveal.
- Symptom: a skill selected before filesystem discovery stayed unopenable.
  Cause: the pill captured an absent source once. Rule: resolve unknown sources
  from the captured provider's exact workspace catalog without changing the
  draft or retargeting a captured source. Encoded in the held-discovery browser
  regression with a provider switch and return.
- Symptom: source discovery could publish malformed responses, mix runtime
  ownership or expose files outside a skill library. Cause: discovery was
  treated as unkeyed optional data, and previewing raw source expands its use.
  Rule: validate responses, share bounded exact-key reads, retain confirmed
  snapshots on failure, and read sources through checked descriptors confined
  to each runtime's library. Encoded in skill catalog/source, native scanner and
  standalone cloud-worker suites. Missing cloud support never falls back to
  the device library.
- Symptom: a stopped cloud composer still issued skill discovery, which the
  retained relay can interpret as work. Cause: mounting the shared composer
  performed a runtime read without checking lifecycle readiness. Rule: gate
  background discovery on the existing running-state predicate and resume
  when that state is published. Encoded in the non-running-state unit matrix
  and the stopped-to-running browser regression.
- Verification surprise: the worker restart test copied a temporary session
  file while its atomic rename removed it. Waiting for the outcome request
  did not wait for the durable report. Flush the fixture's worker before
  copying its restart snapshot; the existing prompt-inbox regression retains
  the original execution and Stop assertions.
- Verification surprise: the mention smoke clicked a harness control to
  simulate a background file change, then expected the new nonmodal popup to
  remain open. Separate background updates from outside clicks: retain the
  live-query refresh assertion, explicitly verify dismissal and reopening,
  and reopen against each owner before checking A → B → A results. Assert the
  current selected-row state rather than matching its hover-only class.
- Follow-up: caret menus belonged only to Create, but the shared popup changed
  workspace chats too. Make placement an explicit surface option with workspace
  behavior as the default. Browser regressions assert both anchors, popup width,
  viewport bounds and focus for Local, organization-local and cloud composers.
- Follow-up: recovered Create drafts were invisible from the sidebar. Derive a
  per-owner presence count from the existing store and publish only empty/nonempty
  transitions. Test project/placement aggregation, reload, owner switching,
  pending-project adoption, whitespace, pill-only drafts and creation outcomes.
- Verification detail: shared Button and sidebar SVG rules can override icon
  width/height attributes. Give the Book and pencil explicit semantic size
  classes and assert their computed 12px dimensions in the browser. After reload,
  wait for the fixture's ready control before calling its setup hooks.
- Visual refinement: All / Commands / Skills category highlights use 14px
  corners derived from the existing 8px and 6px radius steps. Keep this geometry
  in the shared slash picker so Create and workspace menus agree; verify the
  browser-computed radius in both themes without changing global tab styling.
- Review cleanup: picker rows inherit hover and selection fills from the shared
  floating Surface. This keeps surface ownership in its existing primitive and
  avoids adding feature-file exceptions to the global UI checker.
- CI review: Local skill discovery checked a path's metadata before opening it.
  Open once with no-follow/non-blocking flags, validate the held descriptor,
  and match its identity to the contained path before reading and publishing.
  The IPC regressions cover an atomic in-library update and a parent-directory
  swap outside the library, including restoration before validation and file
  descriptor cleanup. Swapping again between `realpath` and `stat` can spoof
  pathname identity, so Linux checks `/proc/self/fd` and Darwin opens with
  `O_NOFOLLOW_ANY`; a real-entry regression exercises both validation windows.
  Preview reads use an AbortSignal across both asynchronous
  boundaries so retiring a preview cannot publish after Markdown loads.

Evidence: `scripts/ui-smoke-composer-suggestions.mjs`,
`scripts/ui-smoke-create-drafts.mjs`, `scripts/ui-smoke-mentions.mjs`, and the adjacent
composer clipboard/accent, skill catalog, source navigation and scanner tests.
Local Personal, organization-local and cloud composer paths share the browser
matrix. The browser uses mocked transports; it is not native Mac or live VM proof.
