import type { PaneNode } from "../../state/chat-panes";

/** How a pane meets its neighbours now that split panes draw no seam line
 *  (2026-11-06). The chrome behind the panes is bg1, which is also the focused
 *  pane's fill, so every effect below is invisible against the focused pane. */
export interface PaneEdges {
  /** Another pane sits beside this top corner, so the corner rounds. Corners
   *  on the window's outer edges stay square. */
  roundTopLeft: boolean;
  roundTopRight: boolean;
  /** Another pane sits below, so this one dissolves into the chrome over its
   *  last 8px: a stacked seam is a soft valley, never a line. */
  fadeBottom: boolean;
  /** Where an unfocused pane borders another unfocused pane along that side,
   *  both dissolve into the chrome along the shared stretch. A stretch against
   *  the focused pane stays plain. */
  fadeLeft: readonly PaneSpan[];
  fadeRight: readonly PaneSpan[];
}

/** A stretch of a pane's side, as fractions of the pane's height from its top. */
export interface PaneSpan {
  start: number;
  end: number;
}

const NO_SPANS: readonly PaneSpan[] = Object.freeze([]);

export const NO_PANE_EDGES: PaneEdges = Object.freeze({
  roundTopLeft: false,
  roundTopRight: false,
  fadeBottom: false,
  fadeLeft: NO_SPANS,
  fadeRight: NO_SPANS,
});

/** A leaf's share of the pane surface, in 0..1 on each axis. */
interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const EPSILON = 1e-6;

/** Every leaf's edges, keyed by pane id. Side neighbours come from the split
 *  ratios, so an uneven grid only parts the stretches where panes touch. */
export function paneEdges(root: PaneNode, focusedPaneId: string): Map<string, PaneEdges> {
  const boxes = new Map<string, Box>();
  const place = (node: PaneNode, box: Box) => {
    if (node.type === "leaf") {
      boxes.set(node.id, box);
      return;
    }
    const ratio = Math.min(Math.max(node.ratio, 0), 1);
    if (node.direction === "row") {
      const x = box.x0 + (box.x1 - box.x0) * ratio;
      place(node.first, { ...box, x1: x });
      place(node.second, { ...box, x0: x });
    } else {
      const y = box.y0 + (box.y1 - box.y0) * ratio;
      place(node.first, { ...box, y1: y });
      place(node.second, { ...box, y0: y });
    }
  };
  place(root, { x0: 0, y0: 0, x1: 1, y1: 1 });

  const quietSpans = (id: string, box: Box, side: "left" | "right"): readonly PaneSpan[] => {
    if (id === focusedPaneId) return NO_SPANS;
    const edge = side === "left" ? box.x0 : box.x1;
    const height = box.y1 - box.y0;
    const spans: PaneSpan[] = [];
    for (const [other, o] of boxes) {
      if (other === id || other === focusedPaneId) continue;
      if (Math.abs((side === "left" ? o.x1 : o.x0) - edge) >= EPSILON) continue;
      const top = Math.max(box.y0, o.y0);
      const bottom = Math.min(box.y1, o.y1);
      if (bottom - top <= EPSILON) continue;
      spans.push({ start: (top - box.y0) / height, end: (bottom - box.y0) / height });
    }
    if (spans.length === 0) return NO_SPANS;
    // Two unfocused neighbours stacked along one side make one stretch.
    spans.sort((a, b) => a.start - b.start);
    const merged: PaneSpan[] = [spans[0]];
    for (const span of spans.slice(1)) {
      const last = merged[merged.length - 1];
      if (span.start - last.end < EPSILON) last.end = Math.max(last.end, span.end);
      else merged.push(span);
    }
    return merged;
  };

  const result = new Map<string, PaneEdges>();
  for (const [id, box] of boxes) {
    const edges: PaneEdges = {
      roundTopLeft: box.x0 > EPSILON,
      roundTopRight: box.x1 < 1 - EPSILON,
      fadeBottom: box.y1 < 1 - EPSILON,
      fadeLeft: quietSpans(id, box, "left"),
      fadeRight: quietSpans(id, box, "right"),
    };
    const plain =
      !edges.roundTopLeft && !edges.roundTopRight && !edges.fadeBottom &&
      edges.fadeLeft.length === 0 && edges.fadeRight.length === 0;
    result.set(id, plain ? NO_PANE_EDGES : edges);
  }
  return result;
}
