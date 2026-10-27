import type { DesignRuntimeTreeNode } from "@zeros/protocol/design-runtime";
import type { DesignCanvasFrameWire } from "../../platform/bridge/design-bridge";
import { designFrameRowDiscloses, flattenDesignLayerTree, type FlatDesignLayer } from "./design-layer-tree";
import { designPresentedFrame, type DesignFrameView } from "./state/design-frame-view";
import { EMPTY_DESIGN_FRAME_DISCLOSURE, type DesignFrameDisclosure } from "./state/design-layer-disclosure";

/** The panel is one tree: every frame contributes its row, and an open frame
 * contributes the layer rows below it. Keeping them in one fixed-height list is
 * what lets several frames stand open while virtualization, keyboard travel,
 * and the selection block keep working across frame boundaries. */
export type DesignPanelRow =
  | {
      kind: "frame";
      key: string;
      frame: DesignFrameView;
      expanded: boolean;
      discloses: boolean;
    }
  | {
      kind: "layer";
      key: string;
      frame: DesignCanvasFrameWire;
      layer: FlatDesignLayer;
      expanded: boolean;
    }
  | { kind: "pending"; key: string; frame: DesignFrameView };

/** Row identity is frame-scoped: two frames may legitimately author the same
 * node id, and both can be on screen at once. */
export function frameRowKey(file: string): string {
  return `frame:${file}`;
}

export function layerRowKey(file: string, nodeId: string): string {
  return `layer:${file}:${nodeId}`;
}

/** A frame revalidating its source keeps presenting its last confirmed
 * generation's tree; layer actions carry that generation, whose writes the
 * engine still checks. Only a frame with layers and no tree waits. */
export function designLayerPanelRows(input: {
  frames: readonly DesignFrameView[];
  treesByFile: Readonly<Record<string, readonly DesignRuntimeTreeNode[]>>;
  disclosures: Readonly<Record<string, DesignFrameDisclosure>>;
}): DesignPanelRow[] {
  const rows: DesignPanelRow[] = [];
  for (const frame of input.frames) {
    const presented = designPresentedFrame(frame);
    const tree = presented ? input.treesByFile[frame.file] : undefined;
    const disclosure =
      input.disclosures[frame.file] ?? EMPTY_DESIGN_FRAME_DISCLOSURE;
    const discloses = designFrameRowDiscloses(tree, presented ?? frame);
    rows.push({
      kind: "frame",
      key: frameRowKey(frame.file),
      frame,
      expanded: disclosure.treeExpanded,
      discloses,
    });
    if (!disclosure.treeExpanded || !discloses) continue;
    if (!tree || !presented) {
      rows.push({ kind: "pending", key: `pending:${frame.file}`, frame });
      continue;
    }
    const expandedNodeIds = new Set(disclosure.expandedNodeIds);
    for (const layer of flattenDesignLayerTree(tree, { expandedNodeIds })) {
      rows.push({
        kind: "layer",
        key: layerRowKey(frame.file, layer.node.oid),
        frame: presented,
        layer,
        expanded: layer.hasChildren && expandedNodeIds.has(layer.node.oid),
      });
    }
  }
  return rows;
}
