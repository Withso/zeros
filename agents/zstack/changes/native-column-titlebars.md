# Native column titlebars

- Symptom: the workspace name row ignored macOS titlebar double-clicks, and
  the other column headers emulated only a subset of the system preferences.
  Cause: the current workspace header had no drag region; older headers used
  renderer gesture listeners, including an effect that missed a header mounted
  after setup. Rule: trace the currently rendered header and use Electron's
  native drag region for window chrome, with explicit exclusions for controls.
  Encoded in `workspace-header.test.ts` and `native-window-chrome.test.ts`.
- Native hit regions consume input before renderer overlays receive it. Keep
  outside-click dismissal while interactive overlays are open, including the
  conditionally mounted composer image preview with no Radix `data-state`.
  Closed, hidden and inert retained overlays must not change hit testing.
  Encoded in the Chromium computed-style regressions in
  `native-window-chrome.test.ts` and the shared platform stylesheet.
- Browser-synthetic clicks do not test AppKit. Verify the production header
  markup and styles with native mouse events on macOS, using process-only
  preference overrides for Zoom, Fill, Minimize and Do Nothing. Let the native
  zoom animation settle before sending the next gesture: published final bounds
  alone do not mean AppKit is accepting another double-click yet.
