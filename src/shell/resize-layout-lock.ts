// ──────────────────────────────────────────────────────────
// Drag-time descendant layout lock
// ──────────────────────────────────────────────────────────
//
// Moving a flex seam necessarily lays out the two flex items. It must not also
// re-wrap a long transcript, diff, iframe deck, and terminal subtree for every
// intermediate pixel. Marked child surfaces keep their exact starting width
// while the outer columns track the pointer; overflow clips the preserved view.
// Releasing the returned callback restores their prior inline state, allowing
// one final layout at the committed width.

export const RESIZE_WIDTH_LOCK_ATTRIBUTE =
  "data-zeros-resize-width-lock" as const;
export const RESIZE_WIDTH_LOCK_SELECTOR =
  `[${RESIZE_WIDTH_LOCK_ATTRIBUTE}]` as const;

interface WidthSnapshot {
  element: HTMLElement;
  width: number;
  previousValue: string;
  previousPriority: string;
}

/** Freeze every marked descendant at its current border-box width.
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
      previousValue: element.style.getPropertyValue("width"),
      previousPriority: element.style.getPropertyPriority("width"),
    });
  }

  for (const { element, width } of snapshots) {
    element.style.setProperty("width", `${width}px`);
  }

  let unlocked = false;
  return () => {
    if (unlocked) return;
    unlocked = true;
    for (const { element, previousValue, previousPriority } of snapshots) {
      if (previousValue) {
        element.style.setProperty(
          "width",
          previousValue,
          previousPriority,
        );
      } else {
        element.style.removeProperty("width");
      }
    }
  };
}
