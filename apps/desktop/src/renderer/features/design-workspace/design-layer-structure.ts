import type { DesignRuntimeTreeNode } from "@zeros/protocol/design-runtime";
import { designLayerParentId } from "./design-layer-tree";
import type { DesignSelectionTarget } from "./design-selected-targets";

export interface DesignStructureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Half a pixel either way still traces the frame's own edge. */
const FRAME_EDGE_TOLERANCE = 0.5;

/** Whether a layer's box earns a dotted structure outline: it must have area
 * (`display: contents` and collapsed boxes have none) and must not be the
 * frame's own edge, which the frame already draws. */
export function designStructureOutlineShown(
  rect: DesignStructureRect | null | undefined,
  frame: { width: number; height: number },
): rect is DesignStructureRect {
  if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return false;
  if (rect.width <= FRAME_EDGE_TOLERANCE || rect.height <= FRAME_EDGE_TOLERANCE) return false;
  return !(
    Math.abs(rect.x) <= FRAME_EDGE_TOLERANCE &&
    Math.abs(rect.y) <= FRAME_EDGE_TOLERANCE &&
    Math.abs(rect.width - frame.width) <= FRAME_EDGE_TOLERANCE &&
    Math.abs(rect.height - frame.height) <= FRAME_EDGE_TOLERANCE
  );
}

/** The one parent a selection's dotted outline names: the primary layer's
 * parent, provided every selected target is a layer of this frame sharing it.
 * Siblings picked together outline their common parent; layers from different
 * parents, or a selection that also holds a frame, outline none. */
export function designSelectionParentId(
  tree: readonly DesignRuntimeTreeNode[],
  targets: readonly DesignSelectionTarget[],
  frame: string,
  primaryNodeId: string | null,
): string | null {
  if (!primaryNodeId) return null;
  const parentId = designLayerParentId(tree, primaryNodeId);
  if (!parentId) return null;
  return targets.every(
    (target) =>
      target.frame === frame &&
      Boolean(target.nodeId) &&
      (target.nodeId === primaryNodeId || designLayerParentId(tree, target.nodeId!) === parentId),
  )
    ? parentId
    : null;
}

/** ⌘ on macOS and Ctrl elsewhere reveal layer structure, matching the
 * deepest-layer click they already make. */
export function designStructureModifierPressed(event: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return event.metaKey || event.ctrlKey;
}

/** The dotted boxes ⌘-hover reveals around a layer: its parent and its direct
 * children. A box another overlay already draws (a selected layer, the
 * selection's own dotted parent) or that the frame edge already traces is
 * left out, so no edge is stroked twice. */
export function designStructureOutlines<
  Parent extends { oid: string; rect: DesignStructureRect },
  Child extends { oid: string; rect: DesignStructureRect },
>(input: {
  parent: Parent | null;
  children: readonly Child[];
  frame: { width: number; height: number };
  excludedNodeIds: readonly string[];
}): { parent: Parent | null; children: Child[] } {
  const shown = (layer: { oid: string; rect: DesignStructureRect }) =>
    !input.excludedNodeIds.includes(layer.oid) && designStructureOutlineShown(layer.rect, input.frame);
  return {
    parent: input.parent && shown(input.parent) ? input.parent : null,
    children: input.children.filter(shown),
  };
}
