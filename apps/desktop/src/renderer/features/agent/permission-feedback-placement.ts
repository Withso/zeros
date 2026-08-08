export type PermissionFeedbackPlacement = "right" | "top";

export interface PermissionFeedbackGeometry {
  triggerRight: number;
  feedbackWidth: number;
  boundaryRight: number;
  gapPx?: number;
}

/** Permission feedback prefers the icon's right side. It only moves above
 * when the full label (plus its visual gap) would collide with the toolbar's
 * right-side actions or outer edge. Unknown geometry keeps the requested
 * right-side default; the next ResizeObserver delivery can refine it. */
export function resolvePermissionFeedbackPlacement({
  triggerRight,
  feedbackWidth,
  boundaryRight,
  gapPx = 4,
}: PermissionFeedbackGeometry): PermissionFeedbackPlacement {
  if (
    !Number.isFinite(triggerRight) ||
    !Number.isFinite(feedbackWidth) ||
    feedbackWidth < 0 ||
    !Number.isFinite(boundaryRight) ||
    !Number.isFinite(gapPx) ||
    gapPx < 0
  ) {
    return "right";
  }

  return triggerRight + gapPx + feedbackWidth <= boundaryRight
    ? "right"
    : "top";
}
