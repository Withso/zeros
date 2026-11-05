# Hidden windows hold toasts

Target: `skills/zstack-drive` (reading live evidence).

- **Symptom.** Driving the Local app over CDP, MCP editor toasts stacked and
  never closed, which looked like a product toast bug.
- **Cause.** The driven window's document reported `document.hidden`.
  sonner 2.0.7 pauses toast timers while the document is hidden and applies
  dismissals in `requestAnimationFrame`, which a hidden document does not
  run. Product toasts that do stack come from distinct toast ids instead.
- **Rule.** Before reporting toasts that stack or linger in a driven window,
  read `document.visibilityState`. Count live toasts
  (`[data-sonner-toast]:not([data-removed="true"])`) by their message in a
  visible window or a harness with a paused clock, not from screenshots.
- **Encoded in.** `mcp-server-editor.test.ts` counts live toasts under a
  paused clock (eval case `mcp-editor-empty-row-and-repeat-toasts`).
