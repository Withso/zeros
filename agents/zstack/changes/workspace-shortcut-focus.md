# Navigation shortcuts follow their visible owners

- **Symptom.** Message shortcuts included assistant replies and measured sticky
  prompt bubbles; the sidebar and tab strips had no matching navigation keys.
- **Cause.** The keyboard handler had its own scroll algorithm, separate from
  the user-message rail's selection, short-message spacer and layout correction.
  Composer/editor listeners and portaled pane bodies also own key events.
- **Rule.** Reuse the surface's ordered projection and selection action. Capture
  navigation before editors consume it, follow native DOM focus through portals,
  yield to overlays, and reject a prior owner's list before its effect updates.
  User-message shortcuts use the checkpoint rail's navigation handle, not sticky
  bubble geometry. Inspect shortcut symbols on platforms without macOS fonts.
- **Encoded in.** `scroll-measurement-dispatch.test.ts` covers keyboard/pointer
  checkpoint pinning for Local and cloud presentation; the workspace hotkey
  suite covers exact positions, bounds, modifiers, overlays and owner retirement.
  `ui-smoke-workspace-shortcuts.mjs` uses the real sidebar, composer, tab strips
  and rail across sort modes, split panes and Local/cloud owner round trips.
  Kbd renders accessible symbols as sized icons and is inspected in both themes.

The browser fixture must provide the wire-shaped status and directory results
for every side tab the navigation can activate. A mock sufficient for the
sidebar alone cannot verify the full workbench. Chromium is installed before
running the browser-backed adjacent suites; the prerequisite failure remains
in the local receipt.

SSR assertions for icon-backed shortcut chips compare the canonical `Kbd`
markup and assert that replica actions expose no chips. Do not strip HTML with
a regular expression to inspect its text: CodeQL reports that pattern as
incomplete sanitization, including when it only appears in a test assertion.
