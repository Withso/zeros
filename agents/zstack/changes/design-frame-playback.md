# Frame playback needs an explicit document lifetime

- **Symptom:** canvas frames intentionally cancelled authored animations and
  exposed no browser playback control. Merely permitting future animations
  would not restart already-cancelled CSSAnimation objects.
- **Cause:** editing, timeline preview and interactive whole-document playback
  have different lifetimes. A retained iframe or static resolution tile can
  keep running or obscure animation after the visible mode changes.
- **Rule:** qualify playback in the real browser through negotiated runtime
  methods, source/session fencing and the actual canvas. Restart authored
  timelines without leaving style overrides, preserve authored timing and
  reduced-motion behavior, and restore the saved editing document on exit.
  Keep hidden documents inert and stop on owner, page, source, engine capability
  and editing changes.
  Include the workspace folder in the iframe document identity too. Otherwise
  a folder round trip can retain an old stylesheet-restoration promise and
  leave saved editing stuck preparing, even when the frame bytes are unchanged.
  Revalidate a bounded number of times when a same-document revision advances
  during geometry confirmation. Retain source/session guards and publish only
  a consistent read; a late theme acknowledgement must not latch a permanent
  editing failure. The smoke forces this revision change before asserting
  readiness and unchanged source.
  Verify control bounds at several zooms with long titles; a missing CSS
  variable can silently remove both size and truncation constraints.
- **Encoded:** `design-runtime-playback.test.ts` covers root, pseudo-element,
  important inline, looping, finite, paused and delayed CSS, SVG, discrete
  display transitions, native controls, click/drop navigation containment,
  reduced motion and teardown. Bridge tests
  cover old-engine negotiation and source-fenced stop events. The Design Motion
  smoke scenario runs canvas playback, keyboard, native-control reset, owner,
  page, hidden-surface, zoom, tile and source/capability-replacement checks.
  It also runs the saved-editing folder-replacement race before playback.
  The fixture exposes the stores it actually rendered; importing a module URL
  again after hot reload can create an unobserved duplicate store and produce
  misleading lifecycle failures.
  Include capture contracts when verifying runtime changes: a substring count
  of `pauseAnimations()` also matches `unpauseAnimations()`. Match the method
  boundary so the single-definition invariant remains meaningful.
