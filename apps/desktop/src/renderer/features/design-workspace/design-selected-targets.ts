import type { DesignRuntimeTreeNode } from "@zeros/protocol/design-runtime";
import type { DesignCanvasRect } from "./design-canvas-math";

export interface DesignSelectionTarget {
  readonly frame: string;
  readonly nodeId?: string;
}

export function designSelectionTargetKey(target: DesignSelectionTarget): string {
  return JSON.stringify([target.frame, target.nodeId ?? null]);
}

export function designSelectionFitRects(
  targets: readonly DesignSelectionTarget[],
  frames: readonly (DesignCanvasRect & { file: string })[],
  read: (file: string, nodeId: string) => DesignCanvasRect | undefined,
): DesignCanvasRect[] {
  const rects: DesignCanvasRect[] = [];
  for (const target of targets) {
    const frame = frames.find(item => item.file === target.frame);
    if (!frame) return [];
    if (!target.nodeId) rects.push(frame);
    else {
      const rect = read(frame.file, target.nodeId);
      if (!rect) return [];
      rects.push({ ...rect, x: rect.x + frame.x, y: rect.y + frame.y });
    }
  }
  return rects;
}

export function designSelectionMutationTargets(
  targets: readonly DesignSelectionTarget[],
  treesByFrame: ReadonlyMap<string, readonly DesignRuntimeTreeNode[]>,
): DesignSelectionTarget[] {
  const frames = new Set(targets.filter(target => !target.nodeId).map(target => target.frame));
  const selected = new Set(targets.map(designSelectionTargetKey));
  const descendants = new Set<string>();
  for (const [frame, tree] of treesByFrame) {
    const visit = (nodes: readonly DesignRuntimeTreeNode[], selectedAncestor: boolean) => {
      for (const node of nodes) {
        const key = designSelectionTargetKey({ frame, nodeId: node.oid });
        if (selectedAncestor) descendants.add(key);
        visit(node.children, selectedAncestor || selected.has(key));
      }
    };
    visit(tree, false);
  }
  return targets.filter(target => !target.nodeId || (!frames.has(target.frame) && !descendants.has(designSelectionTargetKey(target))));
}
