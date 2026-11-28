import type { DesignRuntimeNodeDetails, DesignRuntimeNodeInsert, DesignRuntimeTreeNode } from "@zeros/protocol/design-runtime";
import type { DesignOperation } from "@zeros/design-core";
import { designIntrinsicPlacementStyles } from "@zeros/protocol/design-relocation";
import { borderSize, cssSize, designIntrinsicSizing, designLayoutConstraint, designLayoutMode } from "./design-layout-values";
import { designComponentPartOf, designComponentSlotOf } from "@zeros/protocol/design-runtime";
import { designRuntimeLayerLabel } from "./design-layer-label";

type Point = { x: number; y: number };

/** Shift+A on one frame that holds layers and does not flow yet lays that
 * frame out in place, as Figma does; any other selection is wrapped in a new
 * flow. */
export function designShiftAConvertsInPlace(nodes: readonly (DesignRuntimeNodeDetails | null | undefined)[]): boolean {
  const node = nodes.length === 1 ? nodes[0] : null;
  return Boolean(node && (node.childrenLayout?.count ?? 0) > 0 && designLayoutMode(node.styles.display) === "none" &&
    designRuntimeLayerLabel({ tag: node.tag, text: node.text, textEditable: node.textEditable }) === "Frame");
}

export function designWrapInFlow(parent: DesignRuntimeNodeDetails, nodes: readonly DesignRuntimeNodeDetails[], id: string): DesignOperation[] {
  if (!nodes.length || !/^[A-Za-z0-9_-]{1,128}$/.test(id) ||
    (!canInsertDesignFrame(parent) && parent.tag !== "body") || nodes.some(n => n.layout?.parentId !== parent.oid ||
      !n.layout || !Number.isFinite(n.layout.x) || !Number.isFinite(n.layout.y) || designComponentPartOf(n.oid) || n.shadow))
    throw new Error("Select editable layers with the same parent to wrap in flow.");
  const pos = nodes.map(n => ({ n, x: n.layout!.x, y: n.layout!.y, w: borderSize(n, "x"), h: borderSize(n, "y") }));
  const left = Math.min(...pos.map(n => n.x)), top = Math.min(...pos.map(n => n.y));
  const column = Math.max(...pos.map(n => n.y)) - top > Math.max(...pos.map(n => n.x)) - left;
  pos.sort((a, b) => column ? a.y - b.y : a.x - b.x);
  const gaps = pos.slice(1).map((v, i) => column ? v.y - pos[i]!.y - pos[i]!.h : v.x - pos[i]!.x - pos[i]!.w);
  const gap = gaps.length ? Math.max(0, Math.round(gaps.reduce((a,b) => a+b, 0) / gaps.length)) : 0;
  // Layers that still reserve their space (block or flex flow alike) hand
  // that slot to the wrapper; only an all-free selection stays free.
  const inFlow = !nodes.every(n => n.styles.position === "absolute" || n.styles.position === "fixed");
  const gridOrFlex = ["flex", "inline-flex", "grid", "inline-grid"].includes(parent.styles.display ?? "");
  // Block flow stacks in source order, so the wrapper takes the slot of the
  // layer drawn first; a flex or grid order may differ from what is drawn.
  const slot = gridOrFlex ? nodes[0]! : pos[0]!.n;
  // A static parent is not the wrapper's containing block. Positioning it
  // would re-anchor its other overlays, so the wrapper is placed in the
  // ancestor space a free selected layer already uses.
  const staticParent = !inFlow && parent.styles.position === "static" && parent.tag !== "body";
  const anchored = staticParent ? nodes.find(n => n.styles.position === "absolute" && !n.layout!.isContainingBlock) : undefined;
  const shift = (offset: string | undefined, margin: string | undefined, at: number) => {
    const value = Number.parseFloat(offset ?? "");
    return Number.isFinite(value) ? value + (Number.parseFloat(margin ?? "") || 0) - at : null;
  };
  const dx = anchored ? shift(anchored.styles.left, anchored.styles.marginLeft, anchored.layout!.x) : null;
  const dy = anchored ? shift(anchored.styles.top, anchored.styles.marginTop, anchored.layout!.y) : null;
  const reanchors = staticParent && (dx === null || dy === null);
  const placement = inFlow ? "position:relative;"
    : `position:absolute;left:${Math.round(left + (reanchors ? 0 : dx ?? 0))}px;top:${Math.round(top + (reanchors ? 0 : dy ?? 0))}px;`;
  const style = `${placement}display:flex;flex-direction:${column ? "column" : "row"};gap:${gap}px;align-items:flex-start;width:max-content;height:max-content;`;
  const ops: DesignOperation[] = [];
  const update = (nodeId: string, styles: Record<string, string>) => ops.push({ type: "node.set-styles", operationId: crypto.randomUUID(),
    nodeId, styles, scope: "inline", responsiveContext: "base", stateContext: "default" });
  if (reanchors) update(parent.oid, { position: "relative" });
  ops.push({ type: "node.set-html", operationId: crypto.randomUUID(), nodeId: parent.oid, mode: "append", html: `<div data-oid="${id}" style="${style}"></div>` },
    { type: "node.move", operationId: crypto.randomUUID(), nodeId: id, parentId: parent.oid, beforeId: slot.oid });
  for (const { n, w, h } of pos) {
    ops.push({ type: "node.move", operationId: crypto.randomUUID(), nodeId: n.oid, parentId: id, beforeId: null });
    update(n.oid, { position: "relative", left: "auto", top: "auto", right: "auto", bottom: "auto", order: "0", flex: "0 0 auto",
      width: cssSize(n, "x", w), height: cssSize(n, "y", h), ...designIntrinsicPlacementStyles(designIntrinsicSizing(n)) });
  }
  return ops;
}

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
  // An instance's layers are its main's; only a slot the main marks takes
  // the instance's own.
  if (designComponentSlotOf(parent.oid) !== null) return parent.styles.display !== "contents";
  if (designComponentPartOf(parent.oid) !== null || parent.tag.toLowerCase().startsWith("zd-")) return false;
  return (
    designRuntimeLayerLabel(parent) === "Frame" &&
    !NON_FRAME_CONTAINERS.has(parent.tag.toLowerCase()) &&
    parent.styles.display !== "contents"
  );
}

/** What the canvas asks a frame's runtime to find the frame a drawn layer
 * joins. */
export interface DesignDrawParentRuntime {
  supports?(method: string): boolean;
  getElementAtLoc(x: number, y: number, options: { mode: "deepest" }): Promise<DesignRuntimeNodeDetails | null>;
  getComponentPartAtLoc?(x: number, y: number, hostNodeId: string): Promise<DesignRuntimeNodeDetails | null>;
  getNodeDetails(nodeId: string): Promise<DesignRuntimeNodeDetails | null>;
}

/** The nearest drawable frame under a point. Hit testing stops at an
 * instance, so over one the part under the point is asked for: a slot it
 * sits in takes the layer, and otherwise the layer goes beside the instance.
 * Text and images are passed for their nearest frame, never entered. */
export async function designDrawParentAt(runtime: DesignDrawParentRuntime, point: Point): Promise<DesignRuntimeNodeDetails | null> {
  let parent = await runtime.getElementAtLoc(point.x, point.y, { mode: "deepest" });
  if (parent?.tag.toLowerCase().startsWith("zd-") && runtime.supports?.("getComponentPartAtLoc") && runtime.getComponentPartAtLoc) {
    const host = parent;
    let part = await runtime.getComponentPartAtLoc(point.x, point.y, host.oid);
    for (let depth = 0; part && !canInsertDesignFrame(part) && part.oid !== host.oid && depth < 32; depth++) {
      part = part.layout?.parentId ? await runtime.getNodeDetails(part.layout.parentId) : null;
    }
    if (part && canInsertDesignFrame(part)) return part;
  }
  for (let depth = 0; parent && !canInsertDesignFrame(parent) && depth < 32; depth++) {
    parent = parent.layout?.parentId ? await runtime.getNodeDetails(parent.layout.parentId) : null;
  }
  return parent;
}

function designChildCoordinateSpaceInverse(
  parent: DesignRuntimeNodeDetails,
): { matrix: [number, number, number, number, number, number]; determinant: number } {
  const matrix = parent.childCoordinateSpace;
  if (!matrix)
    throw new Error("The frame's editable coordinates are unavailable.");
  const [a, b, c, d] = matrix;
  const determinant = a * d - b * c;
  if (Math.abs(determinant) < 0.000001)
    throw new Error("The frame has no drawable area.");
  return { matrix: matrix as [number, number, number, number, number, number], determinant };
}

export function designPointInChildCoordinateSpace(
  parent: DesignRuntimeNodeDetails,
  point: Point,
): Point {
  const { matrix, determinant } = designChildCoordinateSpaceInverse(parent);
  const [a, b, c, d, e, f] = matrix;
  return {
    x: (d * (point.x - e) - c * (point.y - f)) / determinant,
    y: (-b * (point.x - e) + a * (point.y - f)) / determinant,
  };
}

export function designVectorInChildCoordinateSpace(
  parent: DesignRuntimeNodeDetails,
  vector: Point,
): Point {
  const { matrix, determinant } = designChildCoordinateSpaceInverse(parent);
  const [a, b, c, d] = matrix;
  return {
    x: (d * vector.x - c * vector.y) / determinant,
    y: (-b * vector.x + a * vector.y) / determinant,
  };
}

/** Insertion remains in the exact parent's coordinates even when the canvas
 * zooms, ancestors rotate/reflect, or the parent scrolls. */
export function designFrameInsertionOperations(
  parent: DesignRuntimeNodeDetails,
  nodeId: string,
  start: Point,
  end?: Point,
): DesignOperation[] {
  return designFrameInsertion(parent, nodeId, start, end).operations;
}

/** The transaction plus its structured twin: the live runtime paints and later
 * adopts exactly the element this source edit appends, so a drawn child never
 * waits for a document reload. */
export function designFrameInsertion(
  parent: DesignRuntimeNodeDetails,
  nodeId: string,
  start: Point,
  end?: Point,
): {
  operations: DesignOperation[];
  insert: DesignRuntimeNodeInsert;
  parentStyles: Record<string, string> | null;
  /** The new frame's box in the parent's coordinates. */
  bounds: { x: number; y: number; width: number; height: number };
} {
  const local = (point: Point) => designPointInChildCoordinateSpace(parent, point);
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
  // A slot's frame is the main's to style, so a layer drawn into one
  // joins its flow rather than asking it to be positioned.
  const flow = designComponentSlotOf(parent.oid) !== null || ["flex", "inline-flex", "grid", "inline-grid"].includes(
    parent.styles.display ?? "",
  );
  const operations: DesignOperation[] = [];
  const parentStyles =
    !flow && (!parent.styles.position || parent.styles.position === "static")
      ? { position: "relative" }
      : null;
  if (parentStyles) {
    operations.push({
      operationId: `container:${nodeId}`,
      type: "node.set-styles",
      nodeId: parent.oid,
      styles: parentStyles,
      scope: "auto",
      responsiveContext: "base",
      stateContext: "default",
    });
  }
  // IDs originate in the editor, but keep the fragment boundary safe for callers.
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(nodeId))
    throw new Error("The new frame needs a stable layer id.");
  // check:ui ignore-next -- authored canvas frame color, independent of the editor theme.
  const style = `display:block;position:${flow ? "relative" : "absolute"};${flow ? "" : `left:${x}px;top:${y}px;`}width:${width}px;height:${height}px;box-sizing:border-box;flex-shrink:0;background-color:#ffffff;opacity:1;`;
  operations.push({
    operationId: `insert:${nodeId}`,
    type: "node.set-html",
    nodeId: parent.oid,
    mode: "append",
    html: `<div data-oid="${nodeId}" style="${style}"></div>`,
  });
  return {
    operations,
    insert: { nodeId, parentId: parent.oid, beforeId: null, tag: "div", style },
    parentStyles,
    bounds: { x, y, width, height },
  };
}

/** The direct children of a layer in a runtime tree. A frame root the tree
 * does not list itself (the document body) owns the tree's top level. */
export function designTreeChildIds(tree: readonly DesignRuntimeTreeNode[], parentId: string, rootId?: string | null): string[] {
  const stack = [...tree];
  for (let node = stack.pop(); node; node = stack.pop()) {
    if (node.oid === parentId) return node.children.map(child => child.oid);
    stack.push(...node.children);
  }
  return parentId === rootId ? tree.map(node => node.oid) : [];
}

/** Layers a drawn frame fully encloses become its children, as in Figma, each
 * keeping its place on the canvas. Only free (absolute), untransformed layers
 * of a parent without auto layout qualify; anything else stays where it is. */
export function designDrawnFrameWrapOperations(
  parent: DesignRuntimeNodeDetails,
  nodeId: string,
  bounds: { x: number; y: number; width: number; height: number },
  children: readonly (DesignRuntimeNodeDetails | null)[],
): DesignOperation[] {
  if (designComponentSlotOf(parent.oid) !== null ||
    ["flex", "inline-flex", "grid", "inline-grid"].includes(parent.styles.display ?? "")) return [];
  const operations: DesignOperation[] = [];
  for (const child of children) {
    const layout = child?.layout;
    if (!child || !layout || layout.parentId !== parent.oid || child.oid === nodeId || child.shadow ||
      designComponentPartOf(child.oid) !== null || child.styles.position !== "absolute" ||
      ["transform", "rotate", "scale", "translate"].some(key => (child.styles[key] ?? "none") !== "none") ||
      !Number.isFinite(layout.x) || !Number.isFinite(layout.y)) continue;
    const width = borderSize(child, "x"), height = borderSize(child, "y");
    // A percentage resolves against the containing block, which becomes the
    // drawn frame, and a stretched layer's size comes from the far inset this
    // clears: either keeps its measured size instead.
    const percent = (value: string | undefined) => /%\s*$/.test(value ?? "");
    const stretched = (axis: "x" | "y") => designLayoutConstraint(child, axis) === "stretch";
    const kept = {
      ...(percent(layout.widthValue) || stretched("x") ? { width: cssSize(child, "x", width) } : {}),
      ...(percent(layout.heightValue) || stretched("y") ? { height: cssSize(child, "y", height) } : {}),
      ...(stretched("x") ? { "--zeros-layout-x": null } : {}),
      ...(stretched("y") ? { "--zeros-layout-y": null } : {}),
    };
    if (layout.x < bounds.x || layout.y < bounds.y ||
      layout.x + width > bounds.x + bounds.width || layout.y + height > bounds.y + bounds.height) continue;
    operations.push(
      { type: "node.move", operationId: `wrap-move:${child.oid}`, nodeId: child.oid, parentId: nodeId, beforeId: null },
      { type: "node.set-styles", operationId: `wrap-place:${child.oid}`, nodeId: child.oid, scope: "inline",
        responsiveContext: "base", stateContext: "default",
        styles: { left: `${Math.round(layout.x - bounds.x - (Number.parseFloat(child.styles.marginLeft ?? "") || 0))}px`,
          top: `${Math.round(layout.y - bounds.y - (Number.parseFloat(child.styles.marginTop ?? "") || 0))}px`, right: "auto", bottom: "auto", ...kept } },
    );
  }
  return operations;
}
