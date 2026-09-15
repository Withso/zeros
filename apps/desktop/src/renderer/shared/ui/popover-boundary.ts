// ──────────────────────────────────────────────────────────
// Popover boundary — "which column am I in?" for dropdown lists
// ──────────────────────────────────────────────────────────
//
// A dropdown list (Select popover) must never overlay a NEIGHBORING column:
// a picker at the left edge of the workbench must not spill over the chat
// pane, a picker in the design inspector must not spill over the canvas.
// Radix only knows about the viewport, so each layout column stamps
// `data-popover-boundary` on its root and the Select resolves the nearest
// one from its trigger at open time and hands it to Radix as the
// `collisionBoundary`. floating-ui then intersects that element with the
// viewport, so BOTH constraints hold at once:
//
//   • default placement is end-aligned (right edge on the trigger's right
//     edge — pickers overwhelmingly sit on the right of their row);
//   • when that would cross the column's LEFT edge, the list shifts right
//     until it fits — at a left-edge trigger it reads as start-aligned;
//   • when the WINDOW is the tighter constraint (narrow/responsive), the
//     viewport wins exactly as before.
//
// Stamp the attribute on layout columns only (panes, sidebars, the settings
// reading column, dialogs) — never on cards or rows, or a list would get
// squeezed by its own container. No stamp in the ancestry = viewport only.
// ──────────────────────────────────────────────────────────

export const POPOVER_BOUNDARY_ATTR = "data-popover-boundary";

/** Spread onto a layout column's root: `<section {...popoverBoundaryProps}>`. */
export const popoverBoundaryProps = { [POPOVER_BOUNDARY_ATTR]: "" } as const;

/** The nearest stamped column above `element`, or null (→ viewport only). */
export function resolvePopoverBoundary(
  element: Element | null | undefined,
): Element | null {
  return element?.closest(`[${POPOVER_BOUNDARY_ATTR}]`) ?? null;
}
