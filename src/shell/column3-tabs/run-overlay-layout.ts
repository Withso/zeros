// ──────────────────────────────────────────────────────────
// Run-overlay hit-testing — which layer may receive pointer events
// ──────────────────────────────────────────────────────────
//
// The Run sub-tab stacks two things in one `position: relative` box: the run's
// TerminalSessionView, and an overlay carrying the Stop / Rerun cluster. Every
// child is `absolute inset-0` and NOTHING sets a z-index, so paint and
// hit-testing fall back to DOM order — and the overlay wrapper is rendered
// last, i.e. on top of the terminal.
//
// It was `pointer-events-auto` while active. That is an invisible, full-pane
// hit target: wheel events never reached the xterm viewport (a run log could
// not be scrolled, running or finished), and neither did clicks or drag-select,
// so the pane could not be focused or copied from either. Only the buttons
// worked, because they sit in their own sub-tree.
//
// The rule, extracted here so it is asserted rather than remembered:
// a full-pane layer over the terminal is transparent to the pointer; only a
// layer that IS the content (the no-session empty state, which has no terminal
// beneath it) may take events across its whole rect.
// ──────────────────────────────────────────────────────────

/** Tailwind classes for the per-action overlay wrapper — the always-mounted
 *  full-pane layer that sits above the run terminal.
 *
 *  `active` must mean "this sub-tab is the visible one AND the panel is
 *  expanded", not just "this sub-tab is selected". `visible` sets
 *  `visibility: visible`, which UNDOES the panel body's `invisible` — and the
 *  body's collapse animates over ~300ms, so an overlay that only tracks the
 *  sub-tab paints its Stop/Rerun cluster (or a whole "Start …" empty state) alone
 *  on an empty panel for that window, after its terminal has already gone. Every
 *  sibling layer in this stack gates on all three conditions. */
export function runOverlayWrapperClass(active: boolean): string {
  return `pointer-events-none absolute inset-0 ${active ? "visible" : "invisible"}`;
}

/** True when `className` describes a layer that would swallow pointer events
 *  across the whole pane. Used by the regression test — any full-cover layer in
 *  this stack must be `pointer-events-none` unless it replaces the terminal.
 *
 *  "Full cover" has to recognise every spelling Tailwind offers, not just
 *  `inset-0`. The point of this helper is to FAIL when someone reintroduces the
 *  bug, and a check that knows one spelling passes happily while the pane is dead
 *  again — `absolute inset-y-0 inset-x-0` and `absolute size-full` are both in
 *  use elsewhere in terminal-tab.tsx, so they are not hypothetical. */
export function coversPaneForPointer(className: string): boolean {
  const c = new Set(className.split(/\s+/).filter(Boolean));
  const spansY =
    c.has("inset-0") ||
    c.has("inset-y-0") ||
    (c.has("top-0") && c.has("bottom-0")) ||
    c.has("size-full") ||
    c.has("h-full");
  const spansX =
    c.has("inset-0") ||
    c.has("inset-x-0") ||
    (c.has("left-0") && c.has("right-0")) ||
    c.has("size-full") ||
    c.has("w-full");
  return (
    (c.has("absolute") || c.has("fixed")) &&
    spansY &&
    spansX &&
    !c.has("pointer-events-none")
  );
}
