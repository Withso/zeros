# Document control geometry

Moving document controls from a toolbar to a floating island changes the
space available to Fit. Reserve clearance in the measured content box and
scroll area, and show the actual rendered percentage in Fit mode.

The shared controls and `scripts/ui-smoke-document-previews.mjs` cover bottom
positioning, both themes, narrow and wide-short panes, bounded navigation and
hidden views across Local, organization-local and cloud owners.

A visual review caught clearance expressed with Design-only `--space-<step>`
variables: the app uses Tailwind's `--spacing` unit, so the declaration was
invalid. Narrow panes still passed because width limited the fitted page.
Assert that the whole fitted page clears the island when height limits it too;
CSS policy passing alone does not prove a custom property resolves at runtime.
