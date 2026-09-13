import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";
import type { DesignOperation } from "@zeros/design-core";
import { designRuntimeLayerLabel } from "./design-layer-label";

type Point = { x: number; y: number };

const NON_FRAME_CONTAINERS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
  "select",
  "option",
  "optgroup",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "colgroup",
  "ul",
  "ol",
  "dl",
]);

/** A designer-facing Frame label alone does not imply an HTML content model
 * that accepts a div (inputs and table rows also receive that generic label). */
export function canInsertDesignFrame(
  parent: DesignRuntimeNodeDetails,
): boolean {
  return (
    designRuntimeLayerLabel(parent) === "Frame" &&
    !NON_FRAME_CONTAINERS.has(parent.tag.toLowerCase()) &&
    parent.styles.display !== "contents"
  );
}

/** Insertion remains in the exact parent's coordinates even when the canvas
 * zooms, ancestors rotate/reflect, or the parent scrolls. */
export function designFrameInsertionOperations(
  parent: DesignRuntimeNodeDetails,
  nodeId: string,
  start: Point,
  end?: Point,
): DesignOperation[] {
  const matrix = parent.childCoordinateSpace;
  if (!matrix)
    throw new Error("The frame's editable coordinates are unavailable.");
  const [a, b, c, d, e, f] = matrix;
  const determinant = a * d - b * c;
  if (Math.abs(determinant) < 0.000001)
    throw new Error("The frame has no drawable area.");
  const local = (point: Point) => ({
    x: (d * (point.x - e) - c * (point.y - f)) / determinant,
    y: (-b * (point.x - e) + a * (point.y - f)) / determinant,
  });
  const from = local(start);
  // A click creates the standard size in the parent's own coordinates; a
  // rotated screen-space diagonal must not turn that square into a thin line.
  const to = end ? local(end) : { x: from.x + 100, y: from.y + 100 };
  const x = Math.round(Math.min(from.x, to.x));
  const y = Math.round(Math.min(from.y, to.y));
  const width = Math.max(1, Math.round(Math.max(from.x, to.x)) - x);
  const height = Math.max(1, Math.round(Math.max(from.y, to.y)) - y);
  if (![x, y, width, height].every(Number.isFinite))
    throw new Error("The frame's drawable bounds are invalid.");
  const flow = ["flex", "inline-flex", "grid", "inline-grid"].includes(
    parent.styles.display ?? "",
  );
  const operations: DesignOperation[] = [];
  if (
    !flow &&
    (!parent.styles.position || parent.styles.position === "static")
  ) {
    operations.push({
      operationId: `container:${nodeId}`,
      type: "node.set-styles",
      nodeId: parent.oid,
      styles: { position: "relative" },
      scope: "auto",
      responsiveContext: "base",
      stateContext: "default",
    });
  }
  // IDs originate in the editor, but keep the fragment boundary safe for callers.
  const escapedId = nodeId
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  operations.push({
    operationId: `insert:${nodeId}`,
    type: "node.set-html",
    nodeId: parent.oid,
    mode: "append",
    html: `<div data-oid="${escapedId}" style="display:block;position:${flow ? "relative" : "absolute"};${flow ? "" : `left:${x}px;top:${y}px;`}width:${width}px;height:${height}px;box-sizing:border-box;flex-shrink:0;"></div>`,
  });
  return operations;
}
