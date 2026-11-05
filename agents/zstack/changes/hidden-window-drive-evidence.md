# Hidden windows pause toasts and reads

Target: `skills/zstack-drive` (reading live evidence).

- **Symptom.** Driving the Local app over CDP, MCP editor toasts stacked and
  never closed, and the composer Tools popup stayed on "Loading tools…" for
  minutes. Both looked like product bugs.
- **Cause.** The driven window sat behind another app, so its document
  reported `document.hidden`. sonner 2.0.7 pauses toast timers while hidden
  and applies dismissals in `requestAnimationFrame`, which a hidden document
  does not run, and passive reads (`useRecoveringRead`) deliberately stop
  while hidden. CDP `Page.bringToFront` does not change this, and an
  AppleScript System Events call can hang on an automation prompt.
- **Rule.** Before reporting a toast, spinner or read that lingers in a driven
  window, read `document.visibilityState`. Bring the instance forward with
  `open -b <its CFBundleIdentifier>`, confirm no second main process started,
  and check again. Count live toasts
  (`[data-sonner-toast]:not([data-removed="true"])`) by message in a visible
  window or a harness with a paused clock, not from screenshots. Choose a
  model with the keyboard (Enter on the highlighted option): a click at an
  option's centre can hit its "Set as default" control and change the
  profile's default model.
- **Encoded in.** `mcp-server-editor.test.ts` counts live toasts under a
  paused clock (eval case `mcp-editor-empty-row-and-repeat-toasts`).
