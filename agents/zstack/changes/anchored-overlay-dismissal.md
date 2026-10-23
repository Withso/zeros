# Anchored overlay dismissal

Symptom: dismissing a dropdown briefly painted the same popup in the top-left
corner. Escape, outside clicks and selection all reproduced it.

Cause: Radix Presence retained the closing popup for its exit animation while
the hover-only trigger became display:none. The live positioner then measured
the hidden anchor at zero and moved the visible popup to (0, 4). Nested portals
and owner replacement share this lifetime mismatch. The previous smoke waited
for animations to finish before reading geometry, so it missed the bad frames.

Rule: anchored overlays stop painting and accepting input when they close.
Keep their entry motion separate from viewport-owned dialog/sheet transitions.
Observe DOM commits and animation frames during dismissal, then verify portal
removal, keyboard focus and immediate reopen. Drive a pointer outside a tooltip's
hover corridor with multiple moves; a single teleport need not exit that corridor.

Two related lifecycle gaps were reproduced while extending the audit:

- DropdownMenu and Popover could focus before Radix installed its document
  Escape listener. Dispatching Escape from that first focus event exposes the
  race without a delay. Share ContextMenu's content fallback, preserve consumer
  cancellation and portal boundaries, and call each guard only once per event.
  Test submenu first focus separately: ContextMenu's parent fallback correctly
  refuses events from a child portal, so that child needs its own fallback.
- A controlled Select could close on owner replacement without releasing its
  native-surface overlay token. Observe open state as well as Radix callbacks;
  verify the aggregate returns to false and the next opening can announce true.

Integration checks: synchronize before paint only in the browser, using a
passive effect for server-rendered primitive tests. A new raw layout effect
caused React's warning stack to evaluate settings ancestors twice. The sidebar
source-picker smoke previously held a closing menu's exit animation to expose
a focus race; it now asserts that the menu is detached before the new picker
takes focus, then verifies late pointer-out cannot reclaim focus.
Select themes through the appearance store and assert the resolved theme after
opening: setting data-theme before a lazy store import silently reverts to the
stored theme and can mislabel dark screenshots as light coverage.

Removing the exit interval also exposed a model-catalog focus bug present on
the base: after closing a row editor, favoriting another row restored search
focus and dismissed the catalog as an outside interaction. Its old smoke read
the still-mounted closing rows before their animation ended. Treat focus on
the owning model search as inside the catalog while preserving pointer-outside
dismissal. Assert data-state=open as well as visibility when an interaction is
required to keep a popup open; retained exit DOM is not evidence of open state.

Encoded in the shared anchored-overlay motion, all six popup primitives,
`docs/ui-interaction-performance.md`, and `scripts/ui-smoke-overlay-dismissal.mjs`.
Coverage includes nested layers, the real repository/model menus, both themes,
reduced motion and Local/organization-local/cloud owner changes. Unit coverage
retains Escape cancellation, portal isolation and once-only guard contracts.
