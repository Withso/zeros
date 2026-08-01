// ──────────────────────────────────────────────────────────
// Drag-time descendant layout lock
// ──────────────────────────────────────────────────────────
//
// Moving a flex seam necessarily lays out the two flex items. It must not also
// re-wrap a long transcript, diff, iframe deck, and terminal subtree for every
// intermediate shrinking pixel. Marked child surfaces keep their starting
// width as a floor while the outer columns track the pointer, so narrowing
// clips the preserved view. They still stretch normally when their owner grows,
// avoiding an exposed empty strip. Release restores their prior inline state.

export const RESIZE_WIDTH_LOCK_ATTRIBUTE =
  "data-zeros-resize-width-lock" as const;
export const RESIZE_WIDTH_LOCK_SELECTOR =
  `[${RESIZE_WIDTH_LOCK_ATTRIBUTE}]` as const;

interface WidthSnapshot {
  element: HTMLElement;
  width: number;
  previousMinWidth: string;
  previousMinWidthPriority: string;
}

/** Floor every marked descendant at its current border-box width.
 *
 * All geometry is read before the first style write so starting a drag causes
 * at most one layout flush rather than alternating read/write per surface.
 * Cleanup is idempotent because pointerup and lostpointercapture can race. */
export function lockResizeDescendantWidths(root: ParentNode): () => void {
  const elements = Array.from(
    root.querySelectorAll<HTMLElement>(RESIZE_WIDTH_LOCK_SELECTOR),
  );
  const snapshots: WidthSnapshot[] = [];

  for (const element of elements) {
    const width = element.getBoundingClientRect().width;
    if (!Number.isFinite(width) || width <= 0) continue;
    snapshots.push({
      element,
      width,
      previousMinWidth: element.style.getPropertyValue("min-width"),
      previousMinWidthPriority: element.style.getPropertyPriority("min-width"),
    });
  }

  for (const { element, width } of snapshots) {
    element.style.setProperty("min-width", `${width}px`);
  }

  let unlocked = false;
  return () => {
    if (unlocked) return;
    unlocked = true;
    for (const {
      element,
      previousMinWidth,
      previousMinWidthPriority,
    } of snapshots) {
      if (previousMinWidth) {
        element.style.setProperty(
          "min-width",
          previousMinWidth,
          previousMinWidthPriority,
        );
      } else {
        element.style.removeProperty("min-width");
      }
    }
  };
}
