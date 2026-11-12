import type { DesignCanvasItemSummary } from "@zeros/protocol/design-canvas-items";

const EMPTY: readonly DesignCanvasItemSummary[] = [];

export function sameDesignCanvasItem(left: DesignCanvasItemSummary, right: DesignCanvasItemSummary): boolean {
  if (left === right) return true;
  if (left.id !== right.id || left.kind !== right.kind || left.x !== right.x || left.y !== right.y || left.width !== right.width) return false;
  if (left.kind === "section") return right.kind === "section" && left.text === right.text;
  if (left.kind === "note") return right.kind === "note" && left.height === right.height && left.text === right.text;
  return right.kind === "link" && left.target === right.target && left.title === right.title && left.missing === right.missing;
}

/** A page's items with every unchanged item kept by reference; the previous
 * array itself when nothing changed, so memoized item views stay put. */
export function stableDesignCanvasItems(
  previous: readonly DesignCanvasItemSummary[] | undefined,
  next: readonly DesignCanvasItemSummary[] | undefined,
): DesignCanvasItemSummary[] | undefined {
  if (!next?.length) return undefined;
  if (!previous?.length) return next as DesignCanvasItemSummary[];
  const byId = new Map(previous.map((item) => [item.id, item]));
  let changed = previous.length !== next.length;
  const stable = next.map((item, index) => {
    const prior = byId.get(item.id);
    if (prior && sameDesignCanvasItem(prior, item)) {
      if (previous[index] !== prior) changed = true;
      return prior;
    }
    changed = true;
    return item;
  });
  return changed ? stable : (previous as DesignCanvasItemSummary[]);
}

/** The items a page draws, never undefined. */
export function designPageItems(page: { items?: DesignCanvasItemSummary[] } | undefined): readonly DesignCanvasItemSummary[] {
  return page?.items ?? EMPTY;
}
