# Keep shortcut search at the panel edge

- **Symptom.** The shortcut reference panel gained a visible title, close
  button and inset search when it adopted standard dialog chrome.
- **Cause.** The dialog smoke grouped the palette with form dialogs and
  required the same header and body spacing for every surface.
- **Rule.** When a palette's approved design starts with search, retain its
  accessible dialog title without a visible header, remove the body's outer
  inset and verify that search reaches the panel edges. Check search focus,
  filtering and Escape dismissal in both themes.
- **Encoded in.** The shortcut-specific assertions in
  `scripts/ui-smoke-project-folder-setup.mjs`; ordinary dialogs retain their
  existing chrome checks.

The Light divider also looked white because the opaque border token was lighter
than the glass after the modal scrim was composited. A separator on glass must
be checked against that composited panel, not the opaque page token. The same
smoke now checks that Light's divider darkens the glass and that both themes use
the requested 14px corners.

The dialog fixture originally opened shortcuts only through a button, so its
smoke could not catch a broken opening chord. It now mounts the real hotkey hook
and checks Command+Option+/ opening and closing over focused search, the displayed
hint, and rejection of the old Command+/ chord in both themes. Keep shortcut
behavior and its catalog hint covered together when changing the binding.
