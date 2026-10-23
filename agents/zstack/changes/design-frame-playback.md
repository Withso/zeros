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
  Verify control bounds at several zooms with long titles; a missing CSS
  variable can silently remove both size and truncation constraints.
- **Encoded:** `design-runtime-playback.test.ts` covers root, pseudo-element,
  important inline, looping, finite, paused and delayed CSS, SVG, discrete
  display transitions, native controls, click/drop navigation containment,
  reduced motion and teardown. Bridge tests
  cover old-engine negotiation and source-fenced stop events. The Design Motion
  smoke scenario runs canvas playback, keyboard, native-control reset, owner,
  page, hidden-surface, zoom, tile and source/capability-replacement checks.
  The fixture exposes the stores it actually rendered; importing a module URL
  again after hot reload can create an unobserved duplicate store and produce
  misleading lifecycle failures.
