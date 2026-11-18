import React, { useEffect, useMemo, useState } from "react";

import type {
  DesignRuntimeChildGeometry,
  DesignRuntimeNodeGeometry,
  DesignRuntimeTreeNode,
} from "@zeros/protocol/design-runtime";

import type { DesignCanvasFrameWire } from "../../platform/git";
import { designSelectionBox, designSelectionOverlayFrame, type DesignCanvasRect } from "./design-canvas-math";
import { designStructureOutlines } from "./design-layer-structure";
import { designLayerParentId } from "./design-layer-tree";
import { designSelectionOverlayStyle } from "./design-workspace-overlays";
import { previewDesignNodeGeometry } from "./state/design-selection";
import { useDesignRuntimeStore } from "./state/design-runtime-store";

const EMPTY_TREE: readonly DesignRuntimeTreeNode[] = [];

/** One dotted structure box in frame space. A box with its own transform
 * (rotation, scale) traces that box; children are traced by their bounds. */
export function DesignStructureOutline({
  rect,
  geometry,
  ...data
}: {
  rect: DesignCanvasRect;
  geometry?: Parameters<typeof designSelectionBox>[0];
} & { [attribute: `data-${string}`]: string | undefined }) {
  return (
    <span
      {...data}
      aria-hidden="true"
      className="zd-design-structure-outline zd-design-dashed-box pointer-events-none absolute z-[1]"
      style={
        geometry
          ? designSelectionOverlayStyle(designSelectionOverlayFrame(designSelectionBox(geometry)))
          : { left: rect.x, top: rect.y, width: rect.width, height: rect.height }
      }
    />
  );
}

/** ⌘/Ctrl-hover structure: the hovered layer keeps its solid hover outline,
 * and its parent and direct children are dotted. Geometry is one read per
 * hovered layer; an answer for a layer the pointer has left is discarded. */
export const DesignLayerStructureOverlay = React.memo(function DesignLayerStructureOverlay({
  workspaceId,
  frame,
  excludedNodeIds,
}: {
  workspaceId: string;
  frame: DesignCanvasFrameWire;
  /** Layers another overlay already strokes in this frame. */
  excludedNodeIds: readonly string[];
}) {
  const hoveredNodeId = useDesignRuntimeStore((state) => {
    const workspace = state.byWorkspace[workspaceId];
    return workspace?.hoveredFrame === frame.file ? (workspace.hoveredNodeId ?? null) : null;
  });
  const tree = useDesignRuntimeStore(
    (state) => state.byWorkspace[workspaceId]?.frames[frame.file]?.snapshot?.tree ?? EMPTY_TREE,
  );
  const parentId = useMemo(
    () => (hoveredNodeId ? designLayerParentId(tree, hoveredNodeId) : null),
    [hoveredNodeId, tree],
  );
  const owner = hoveredNodeId
    ? `${frame.file}\u0000${frame.sourceVersion}\u0000${hoveredNodeId}\u0000${parentId ?? ""}`
    : "";
  const [structure, setStructure] = useState<{
    owner: string;
    parent: DesignRuntimeNodeGeometry | null;
    children: readonly DesignRuntimeChildGeometry[];
  }>({ owner: "", parent: null, children: [] });

  useEffect(() => {
    if (!hoveredNodeId) return;
    let cancelled = false;
    const requestOwner = owner;
    void Promise.allSettled([
      previewDesignNodeGeometry({ workspaceId, frame, nodeId: hoveredNodeId, children: true }),
      parentId ? previewDesignNodeGeometry({ workspaceId, frame, nodeId: parentId }) : Promise.resolve(null),
    ]).then(([hovered, parent]) => {
      if (cancelled) return;
      setStructure({
        owner: requestOwner,
        parent: parent.status === "fulfilled" ? parent.value : null,
        children: hovered.status === "fulfilled" ? hovered.value.children : [],
      });
    });
    return () => {
      cancelled = true;
    };
  }, [frame, hoveredNodeId, owner, parentId, workspaceId]);

  if (!hoveredNodeId || structure.owner !== owner) return null;
  const outlines = designStructureOutlines({
    parent: structure.parent,
    children: structure.children,
    frame,
    excludedNodeIds,
  });
  if (!outlines.parent && outlines.children.length === 0) return null;
  return (
    <span data-design-structure-overlay={hoveredNodeId} className="pointer-events-none absolute inset-0 z-[1]" aria-hidden="true">
      {outlines.parent ? (
        <DesignStructureOutline
          data-design-structure-hover-parent={outlines.parent.oid}
          rect={outlines.parent.rect}
          geometry={outlines.parent}
        />
      ) : null}
      {outlines.children.map((child) => (
        <DesignStructureOutline key={child.oid} data-design-structure-child={child.oid} rect={child.rect} />
      ))}
    </span>
  );
});
