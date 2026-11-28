import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";
import { designLayoutChildBounds } from "./design-layout-children";
import {
  designLayoutActionStyles,
  designLayoutPlacedByParent,
  type DesignLayoutAction,
  type DesignLayoutAxis,
} from "./design-layout-values";

type Styles = Record<string, string | null>;

const positionAt = (
  node: DesignRuntimeNodeDetails,
  axis: DesignLayoutAxis,
  value: number,
): Styles =>
  designLayoutActionStyles(node, { type: "position", axis, value });

/** Alignment and distribution of the free layers in one multi-selection.
 * Layers whose auto-layout parent places them stay untouched. */
export function designLayoutSelectionUpdates(
  nodes: readonly DesignRuntimeNodeDetails[],
  action: DesignLayoutAction,
): Map<string, Styles> {
  const updates = new Map<string, Styles>();
  if (
    !(
      (action.type === "align" || action.type === "distribute") &&
      action.target === "self"
    )
  )
    return updates;
  const selected = nodes.filter(
    (node) =>
      node.visible &&
      node.layout?.parentId &&
      !designLayoutPlacedByParent(node),
  );
  const parentId = selected[0]?.layout?.parentId;
  if (
    selected.length < 2 ||
    !parentId ||
    selected.some((node) => node.layout?.parentId !== parentId)
  )
    return updates;
  const axis = action.axis;
  const boxes = new Map(
    selected.map((node) => [node.oid, designLayoutChildBounds(node)]),
  );
  const merge = (node: DesignRuntimeNodeDetails, value: number) => {
    if (node.layout?.parentId && !node.layout.isContainingBlock)
      updates.set(node.layout.parentId, {
        ...updates.get(node.layout.parentId),
        position: updates.get(node.layout.parentId)?.position ?? "relative",
      });
    const current = node.layout![axis];
    if (Math.round(value) === Math.round(current)) return;
    updates.set(node.oid, {
      ...updates.get(node.oid),
      ...positionAt(node, axis, value),
    });
  };
  if (action.type === "align") {
    const min = Math.min(
      ...selected.map((node) =>
        axis === "x" ? boxes.get(node.oid)!.left : boxes.get(node.oid)!.top,
      ),
    );
    const max = Math.max(
      ...selected.map((node) =>
        axis === "x" ? boxes.get(node.oid)!.right : boxes.get(node.oid)!.bottom,
      ),
    );
    for (const node of selected) {
      const box = boxes.get(node.oid)!;
      const start = axis === "x" ? box.left : box.top;
      const end = axis === "x" ? box.right : box.bottom;
      const target =
        action.value === "start"
          ? min
          : action.value === "end"
            ? max - (end - start)
            : (min + max - (end - start)) / 2;
      merge(node, node.layout![axis] + target - start);
    }
    return updates;
  }
  if (selected.length < 3) return updates;
  const sorted = [...selected].sort((a, b) => {
    const first = boxes.get(a.oid)!;
    const second = boxes.get(b.oid)!;
    return (axis === "x" ? first.left : first.top) -
      (axis === "x" ? second.left : second.top);
  });
  const firstBox = boxes.get(sorted[0]!.oid)!;
  const lastBox = boxes.get(sorted.at(-1)!.oid)!;
  const outerStart = axis === "x" ? firstBox.left : firstBox.top;
  const outerEnd = axis === "x" ? lastBox.right : lastBox.bottom;
  const sizes = sorted.map((node) => {
    const box = boxes.get(node.oid)!;
    return axis === "x" ? box.right - box.left : box.bottom - box.top;
  });
  const gap =
    (outerEnd - outerStart - sizes.reduce((sum, size) => sum + size, 0)) /
    (sorted.length - 1);
  let offset = outerStart;
  for (const [index, node] of sorted.entries()) {
    const box = boxes.get(node.oid)!;
    const start = axis === "x" ? box.left : box.top;
    if (index !== 0 && index !== sorted.length - 1)
      merge(node, node.layout![axis] + offset - start);
    offset += sizes[index]! + gap;
  }
  return updates;
}
