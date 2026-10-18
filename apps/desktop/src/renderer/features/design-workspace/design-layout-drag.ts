import type {
  DesignRuntimeNodeDetails,
  DesignRuntimeNodeMove,
} from "@zeros/protocol/design-runtime";
import { canInsertDesignFrame } from "./design-frame-insertion";
import { borderSize, cssSize, designLayoutMode } from "./design-layout-values";
import {
  DESIGN_REPARENT_HYSTERESIS_PIXELS,
  designNodeRelocation,
  designParentDelta,
  designRelocatedBorderStyles,
} from "./design-movement-geometry";
import {
  designRelocationStyles,
  type DesignRelocation,
} from "@zeros/protocol/design-relocation";
import {
  designSelectionBox,
  designSelectionBoxCorners,
} from "./design-canvas-math";

interface Point {
  x: number;
  y: number;
}
export interface DesignLayoutDrop extends DesignRuntimeNodeMove {
  relocation?: DesignRelocation;
  styles: Record<string, string | null>;
  indicator?: { x: number; y: number; width: number; height: number };
}

/** Resolve intent against the gesture's frozen geometry. Reflow during a drag
 * must not move hit-test boundaries underneath a stationary pointer. */
export function designLayoutDrop(
  node: DesignRuntimeNodeDetails,
  targets: readonly DesignRuntimeNodeDetails[],
  point: Point,
  origin: Point,
): DesignLayoutDrop | null {
  return createDesignLayoutDropResolver(node, targets)(point, origin);
}

/** Build ancestry, stacking, and flow order once per gesture. Pointer samples
 * only perform hit testing and a linear nearest-slot search. */
export function createDesignLayoutDropResolver(
  node: DesignRuntimeNodeDetails,
  targets: readonly DesignRuntimeNodeDetails[],
  options?: { zoom: () => number; preserveFreePosition?: boolean },
): (point: Point, origin: Point) => DesignLayoutDrop | null {
  const byId = new Map(targets.map((target) => [target.oid, target]));
  const byParent = new Map<string, DesignRuntimeNodeDetails[]>();
  for (const target of targets) {
    const parentId = target.layout?.parentId;
    if (!parentId) continue;
    const siblings = byParent.get(parentId) ?? [];
    siblings.push(target);
    byParent.set(parentId, siblings);
  }
  const flowChildren = new Map(
    [...byParent].map(([id, siblings]) => [
      id,
      siblings
        .filter(
          (child) =>
            child.oid !== node.oid &&
            child.visible &&
            !["absolute", "fixed"].includes(child.styles.position ?? ""),
        )
        .sort(
          (a, b) => Number(a.styles.order || 0) - Number(b.styles.order || 0),
        ),
    ]),
  );
  const contains = (
    target: DesignRuntimeNodeDetails,
    point: Point,
    inset = 0,
  ) => {
    if (target.borderCoordinateSpace === null) return false;
    if (target.borderCoordinateSpace && target.box) {
      const [a, b, c, d, e, f] = target.borderCoordinateSpace;
      const determinant = a * d - b * c;
      if (Math.abs(determinant) < 0.000001) return false;
      const x = (d * (point.x - e) - c * (point.y - f)) / determinant;
      const y = (-b * (point.x - e) + a * (point.y - f)) / determinant;
      const insetX = (inset * Math.hypot(d, c)) / Math.abs(determinant);
      const insetY = (inset * Math.hypot(b, a)) / Math.abs(determinant);
      return (
        x >= insetX &&
        y >= insetY &&
        x <= target.box.width - insetX &&
        y <= target.box.height - insetY
      );
    }
    const rect = target.rect;
    return (
      point.x >= rect.x + inset &&
      point.y >= rect.y + inset &&
      point.x <= rect.x + rect.width - inset &&
      point.y <= rect.y + rect.height - inset
    );
  };
  const below = (target: DesignRuntimeNodeDetails) => {
    const visited = new Set<string>();
    let current: DesignRuntimeNodeDetails | undefined = target;
    while (current && !visited.has(current.oid)) {
      if (current.oid === node.oid) return true;
      visited.add(current.oid);
      current = byId.get(current.layout?.parentId ?? "");
    }
    return false;
  };
  const original = byId.get(node.layout?.parentId ?? "");
  let currentParent = original;
  const parents = targets
    .filter(
      (target) =>
        target.visible &&
        !below(target) &&
        !(
          node.relocationContext &&
          options?.preserveFreePosition &&
          target !== original &&
          target.tag !== "body" &&
          target.styles.position === "static"
        ) &&
        (canInsertDesignFrame(target) || target.tag === "body"),
    )
    .sort(
      (a, b) =>
        a.rect.width * a.rect.height - b.rect.width * b.rect.height ||
        (a.tag === "body"
          ? 1
          : b.tag === "body"
            ? -1
            : targets.indexOf(b) - targets.indexOf(a)),
    );
  return (point, origin) => {
    const anchor = options
      ? {
          x: origin.x + node.rect.width / 2,
          y: origin.y + node.rect.height / 2,
        }
      : point;
    const hysteresis = options
      ? DESIGN_REPARENT_HYSTERESIS_PIXELS / options.zoom()
      : 0;
    // Crossing a sibling in a flow means insertion. It must not accidentally
    // create a new nesting level just because that sibling is itself a frame.
    const parent =
      original &&
      (!options || node.styles.position !== "absolute") &&
      designLayoutMode(original.styles.display ?? "") !== "none" &&
      contains(original, anchor, -hysteresis)
        ? original
        : parents.find((target) => {
            if (
              node.styles["--zeros-layout-origin-flow"] === "1" &&
              designLayoutMode(target.styles.display ?? "") !== "none"
            )
              return contains(target, point);
            if (
              !contains(
                target,
                anchor,
                target === currentParent ? -hysteresis : hysteresis,
              )
            )
              return false;
            if (!options || target === currentParent) return true;
            return designSelectionBoxCorners(designSelectionBox(node)).every(
              (corner) =>
                contains(target, {
                  x: corner.x + origin.x - node.rect.x,
                  y: corner.y + origin.y - node.rect.y,
                }),
            );
          });
    currentParent = parent;
    if (!parent) return null;
    const sameParent = parent.oid === node.layout?.parentId;
    const flow =
      (sameParent || options?.preserveFreePosition) &&
      node.styles.position === "absolute"
        ? "none"
        : designLayoutMode(parent.styles.display ?? "");
    const styles: Record<string, string | null> = {
      position: flow === "none" ? "absolute" : "relative",
      left: "auto",
      top: "auto",
      right: "auto",
      bottom: "auto",
    };
    if (flow !== "none" && node.styles["--zeros-layout-origin-flow"] === "1")
      styles["--zeros-layout-origin-flow"] = null;
    if (
      flow === "none" &&
      !sameParent &&
      original &&
      designLayoutMode(original.styles.display ?? "") !== "none" &&
      node.styles.position !== "absolute"
    )
      styles["--zeros-layout-origin-flow"] = "1";
    if (parent.oid !== node.layout?.parentId)
      Object.assign(styles, {
        width: cssSize(node, "x", borderSize(node, "x")),
        height: cssSize(node, "y", borderSize(node, "y")),
        "flex-grow": "0",
        "flex-shrink": "0",
        "flex-basis": "auto",
        "align-self": "auto",
        "justify-self": "auto",
      });
    if (flow === "none") {
      const margin = {
        x: parseFloat(node.styles.marginLeft ?? "0") || 0,
        y: parseFloat(node.styles.marginTop ?? "0") || 0,
      };
      const delta = { x: origin.x - node.rect.x, y: origin.y - node.rect.y };
      const [a, b, c, d, e, f] = parent.childCoordinateSpace ?? [
        1,
        0,
        0,
        1,
        parent.rect.x,
        parent.rect.y,
      ];
      const determinant = a * d - b * c;
      if (Math.abs(determinant) < 0.000001) return null;
      styles.left = `${Math.round((d * (origin.x - e) - c * (origin.y - f)) / determinant - (parseFloat(node.styles.marginLeft ?? "0") || 0))}px`;
      styles.top = `${Math.round((-b * (origin.x - e) + a * (origin.y - f)) / determinant - (parseFloat(node.styles.marginTop ?? "0") || 0))}px`;
      if (
        node.borderCoordinateSpace === null ||
        node.parentCoordinateSpace === null
      )
        throw new Error(
          "This layer has unsupported or non-invertible coordinates and cannot be moved safely.",
        );
      if (sameParent && node.parentCoordinateSpace && node.layout) {
        const local = designParentDelta(node.parentCoordinateSpace, delta);
        const left = parseFloat(node.styles.left ?? "");
        const top = parseFloat(node.styles.top ?? "");
        styles.left = `${(Number.isFinite(left) ? left : node.layout.x - margin.x) + local.x}px`;
        styles.top = `${(Number.isFinite(top) ? top : node.layout.y - margin.y) + local.y}px`;
      } else if (node.borderCoordinateSpace && parent.childCoordinateSpace) {
        Object.assign(
          styles,
          designRelocatedBorderStyles({
            border: node.borderCoordinateSpace,
            parent: parent.childCoordinateSpace,
            delta,
            margin,
          }),
        );
      }
      const siblings = byParent.get(parent.oid) ?? [];
      const beforeId = sameParent
        ? (siblings[siblings.findIndex((target) => target.oid === node.oid) + 1]
            ?.oid ?? null)
        : null;
      if (!sameParent && node.relocationContext) {
        if (!parent.childCoordinateSpace)
          throw new Error(
            "The destination's editable coordinates are unavailable.",
          );
        const relocation = designNodeRelocation(
          node,
          origin,
          parent.childCoordinateSpace,
        );
        return {
          nodeId: node.oid,
          parentId: parent.oid,
          beforeId,
          relocation,
          styles: designRelocationStyles(relocation),
        };
      }
      return { nodeId: node.oid, parentId: parent.oid, beforeId, styles };
    }
    const children = flowChildren.get(parent.oid) ?? [];
    const column =
      flow === "flex" &&
      (parent.styles.flexDirection ?? "row").startsWith("column");
    const reverse =
      flow === "flex" &&
      (parent.styles.flexDirection ?? "").endsWith("reverse");
    const rtl = parent.styles.direction === "rtl";
    const flipped = reverse !== (!column && rtl);
    const wrapped =
      flow === "grid" || (parent.styles.flexWrap ?? "nowrap") !== "nowrap";
    const center = (child: DesignRuntimeNodeDetails) => ({
      x: child.rect.x + child.rect.width / 2,
      y: child.rect.y + child.rect.height / 2,
    });
    const distance = (child: DesignRuntimeNodeDetails) => {
      const mid = center(child);
      if (!wrapped) return Math.abs(column ? point.y - mid.y : point.x - mid.x);
      const dx = Math.max(
        child.rect.x - point.x,
        0,
        point.x - child.rect.x - child.rect.width,
      );
      const dy = Math.max(
        child.rect.y - point.y,
        0,
        point.y - child.rect.y - child.rect.height,
      );
      return (
        Math.hypot(dx, dy) +
        Math.hypot(point.x - mid.x, point.y - mid.y) / 10000
      );
    };
    let nearest: DesignRuntimeNodeDetails | undefined;
    let nearestDistance = Infinity;
    for (const child of children) {
      const candidateDistance = distance(child);
      if (candidateDistance < nearestDistance) {
        nearest = child;
        nearestDistance = candidateDistance;
      }
    }
    let beforeId: string | null = null;
    let indicator: DesignLayoutDrop["indicator"];
    if (nearest) {
      const mid = center(nearest);
      const after = (column ? point.y > mid.y : point.x > mid.x) !== flipped;
      beforeId = after
        ? (children[children.indexOf(nearest) + 1]?.oid ?? null)
        : nearest.oid;
      const rect = nearest.rect;
      const end = after !== flipped;
      indicator = column
        ? {
            x: rect.x,
            y: rect.y + (end ? rect.height : 0),
            width: rect.width,
            height: 0,
          }
        : {
            x: rect.x + (end ? rect.width : 0),
            y: rect.y,
            width: 0,
            height: rect.height,
          };
      // CSS order still participates in the cascade. Match the destination rank
      // so DOM insertion is effective without rewriting unrelated siblings.
      styles.order = nearest.styles.order || "0";
    }
    if (flow === "grid") {
      for (const axis of ["Column", "Row"]) {
        const start = node.styles[`grid${axis}Start`] ?? "";
        const end = node.styles[`grid${axis}End`] ?? "";
        const span = /span\s+([1-9]\d*)/.exec(`${start} ${end}`)?.[1];
        const explicit = Number(end) - Number(start);
        styles[`grid-${axis.toLowerCase()}`] = span
          ? `span ${span}`
          : Number.isInteger(explicit) && explicit > 1
            ? `span ${explicit}`
            : "auto";
      }
    }
    return {
      nodeId: node.oid,
      parentId: parent.oid,
      beforeId,
      styles,
      indicator,
    };
  };
}
