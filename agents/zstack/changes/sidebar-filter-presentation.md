# Sidebar filter presentation

- Symptom: removing the repository reset row left the browser scenario using
  an action the requested menu no longer exposes.
- Cause: the scenario proved reset through that shortcut, without proving that
  unchecking the final repository restores the complete list.
- Rule: when simplifying filter controls, exercise the remaining path back to
  the unfiltered state. Check the active indicator after reload and owner
  switches, and inspect computed search and hover styles in the browser.
- Encoded in `scripts/ui-smoke-sidebar-filters.mjs` (selection, clearing,
  accessible indicator, Dark/Light blue and Local/cloud owner restoration) and
  `scripts/ui-smoke-app-sidebar.mjs` (transparent repository hover).
- Shared UI migration snapshots can also pin a feature's class recipe. Keep
  those expectations aligned with approved visual changes and run the whole
  primitive suite (`shared/ui/primitives/__tests__/surface.test.ts`).

Avoid asserting that a removed Tailwind shadow computes to the literal `none`:
`shadow-none` can produce a stack of transparent, zero-size shadows. Inspect
the rendered geometry and both themes instead of depending on that serialization.

The fresh Amazon Linux host also lacked `make` and a C++ compiler, which stopped
native dependency installation before the test tools were linked. Install
`make` and `gcc-c++`, then rerun the frozen install before diagnosing test
failures as product regressions.
