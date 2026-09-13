import {
  DESIGN_LAYOUT_CHILD_LIMIT,
  type DesignRuntimeChildrenLayout,
  type DesignRuntimeNodeDetails,
} from "@zeros/protocol/design-runtime";
import { DESIGN_TRANSACTION_MAX_OPERATIONS } from "@zeros/design-core";
import {
  borderSize,
  cssSize,
  designLayoutActionStyles,
  designLayoutConstraint,
  designLayoutTransform,
  type DesignLayoutAction,
  type DesignLayoutAxis,
} from "./design-layout-values";
import { designTransformLinear } from "./design-canvas-math";
import { readDesignComputedStyle } from "./design-style-values";

type Styles = Record<string, string | null>;
const style = (node: DesignRuntimeNodeDetails, key: string) =>
  readDesignComputedStyle(node.styles, key);
const number = (node: DesignRuntimeNodeDetails, key: string) =>
  Number.parseFloat(style(node, key)) || 0;
const px = (value: number) => `${Math.round(value) || 0}px`;
export type DesignLayoutChildAction = Extract<
  DesignLayoutAction,
  { type: "align" | "constraint" | "center" | "distribute" | "resize-fit" }
>;
export const isDesignLayoutChildAction = (
  action: DesignLayoutAction,
): action is DesignLayoutChildAction =>
  ["align", "constraint", "center", "distribute", "resize-fit"].includes(
    action.type,
  );

export function designLayoutChildrenSummary(
  parents: readonly DesignRuntimeNodeDetails[],
): DesignRuntimeChildrenLayout {
  const result: DesignRuntimeChildrenLayout = {
    count: 0,
    nodeIds: [],
    x: "start",
    y: "start",
    truncated: false,
  };
  let containers = 0;
  for (const parent of parents) {
    const children = parent.childrenLayout;
    if (!children) continue;
    result.count += children.count;
    result.truncated ||= children.truncated;
    if (children.nodeIds.length === 0) continue;
    for (const axis of ["x", "y"] as const)
      result[axis] =
        containers === 0
          ? children[axis]
          : result[axis] === children[axis]
            ? result[axis]
            : "mixed";
    result.nodeIds.push(...children.nodeIds);
    containers++;
  }
  result.nodeIds = [...new Set(result.nodeIds)];
  result.truncated ||=
    result.nodeIds.length + containers > DESIGN_TRANSACTION_MAX_OPERATIONS;
  if (result.truncated) result.x = result.y = "mixed";
  return result;
}

/** Local painted bounds include a child's own rotation, scale and pivot. An
 * ancestor transform never changes the size of this container's layout box. */
function childBounds(node: DesignRuntimeNodeDetails) {
  const transform = designLayoutTransform(node);
  const [a, b, c, d] = designTransformLinear(transform);
  const width = borderSize(node, "x"),
    height = borderSize(node, "y");
  const origin = style(node, "transform-origin")
    .split(/\s+/)
    .map(Number.parseFloat);
  const ox = Number.isFinite(origin[0]) ? origin[0]! : width / 2;
  const oy = Number.isFinite(origin[1]) ? origin[1]! : height / 2;
  const points = [
    [0, 0],
    [width, 0],
    [0, height],
    [width, height],
  ].map(([x, y]) => ({
    x: node.layout!.x + ox + a * (x! - ox) + c * (y! - oy) + transform.x,
    y: node.layout!.y + oy + b * (x! - ox) + d * (y! - oy) + transform.y,
  }));
  return {
    left: Math.min(...points.map((p) => p.x)),
    top: Math.min(...points.map((p) => p.y)),
    right: Math.max(...points.map((p) => p.x)),
    bottom: Math.max(...points.map((p) => p.y)),
  };
}

/** A single atomic transaction owns all direct children and parent setup. */
export function designLayoutChildUpdates(
  parents: readonly DesignRuntimeNodeDetails[],
  children: readonly DesignRuntimeNodeDetails[],
  action: DesignLayoutChildAction,
): Map<string, Styles> {
  if (designLayoutChildrenSummary(parents).truncated)
    throw new Error("Select a smaller frame to arrange its children together.");
  const updates = new Map<string, Styles>();
  const merge = (oid: string, patch: Styles) => {
    if (Object.keys(patch).length)
      updates.set(oid, { ...updates.get(oid), ...patch });
  };
  const byParent = new Map<string, DesignRuntimeNodeDetails[]>();
  for (const child of children) {
    if (
      !child.visible ||
      !child.layout?.parentId ||
      style(child, "display") === "contents"
    )
      continue;
    const list = byParent.get(child.layout.parentId) ?? [];
    list.push(child);
    byParent.set(child.layout.parentId, list);
  }
  // Prepare every container before child patches, including nested selections.
  // Otherwise a later parent setup can overwrite its own alignment as a child.
  for (const parent of parents) {
    const group = byParent.get(parent.oid) ?? [];
    if (
      group.length === 0 ||
      (action.type === "distribute" && group.length < 3)
    )
      continue;
    if (group.length > DESIGN_LAYOUT_CHILD_LIMIT)
      throw new Error(
        "Select a smaller frame to arrange its children together.",
      );
    const setup: Styles = {};
    if (group.some((child) => !child.layout!.isContainingBlock))
      setup.position =
        style(parent, "position") === "static"
          ? "relative"
          : style(parent, "position") || "relative";
    if (
      group.some(
        (child) => !["absolute", "fixed"].includes(style(child, "position")),
      )
    ) {
      setup.width = cssSize(parent, "x", borderSize(parent, "x"));
      setup.height = cssSize(parent, "y", borderSize(parent, "y"));
    }
    merge(parent.oid, setup);
  }
  for (const parent of parents) {
    const group = byParent.get(parent.oid) ?? [];
    if (
      group.length === 0 ||
      (action.type === "distribute" && group.length < 3)
    )
      continue;
    if (action.type === "resize-fit") {
      const bounds = group.map(childBounds);
      const dx = Math.floor(
        Math.min(
          0,
          ...bounds.map((box) => box.left - number(parent, "padding-left")),
        ),
      );
      const dy = Math.floor(
        Math.min(
          0,
          ...bounds.map((box) => box.top - number(parent, "padding-top")),
        ),
      );
      const width = Math.max(
        1,
        Math.ceil(
          Math.max(...bounds.map((box) => box.right)) -
            dx +
            number(parent, "padding-right"),
        ),
      );
      const height = Math.max(
        1,
        Math.ceil(
          Math.max(...bounds.map((box) => box.bottom)) -
            dy +
            number(parent, "padding-bottom"),
        ),
      );
      merge(parent.oid, {
        width: cssSize(
          parent,
          "x",
          width +
            number(parent, "border-left-width") +
            number(parent, "border-right-width"),
        ),
        height: cssSize(
          parent,
          "y",
          height +
            number(parent, "border-top-width") +
            number(parent, "border-bottom-width"),
        ),
        "min-width": "0px",
        "min-height": "0px",
        "max-width": "none",
        "max-height": "none",
      });
      for (const child of group) {
        let resized = {
          ...child,
          layout: {
            ...child.layout!,
            x: child.layout!.x - dx,
            y: child.layout!.y - dy,
            parentWidth: width,
            parentHeight: height,
          },
        };
        for (const axis of ["x", "y"] as const) {
          // Fit preserves each child's measured size; a stretch pin is restored
          // with new paired insets after the container has its fitted size.
          const patch = designLayoutActionStyles(resized, {
            type: "constraint",
            axis,
            value: designLayoutConstraint(child, axis),
          });
          merge(child.oid, patch);
          resized = {
            ...resized,
            layout: { ...resized.layout, isContainingBlock: true },
            styles: { ...resized.styles, ...patch } as Record<string, string>,
          };
        }
      }
    } else if (action.type === "distribute") {
      const axis: DesignLayoutAxis = action.axis;
      const sorted = [...group].sort(
        (a, b) => a.layout![axis] - b.layout![axis],
      );
      const start = sorted[0]!.layout![axis];
      const end = Math.max(
        ...sorted.map((child) => child.layout![axis] + borderSize(child, axis)),
      );
      const gap =
        (end -
          start -
          sorted.reduce((size, child) => size + borderSize(child, axis), 0)) /
        (sorted.length - 1);
      let offset = start;
      for (const child of sorted) {
        merge(child.oid, {
          ...designLayoutActionStyles(child, {
            type: "constraint",
            axis,
            value: "start",
          }),
          [axis === "x" ? "left" : "top"]: px(
            offset - number(child, axis === "x" ? "margin-left" : "margin-top"),
          ),
        });
        offset += borderSize(child, axis) + gap;
      }
    } else {
      for (const child of group)
        merge(child.oid, designLayoutActionStyles(child, action));
    }
  }
  if (updates.size > DESIGN_TRANSACTION_MAX_OPERATIONS)
    throw new Error("Select a smaller frame to arrange its children together.");
  return updates;
}

export function designLayoutResizedFrame(
  parent: DesignRuntimeNodeDetails,
  styles: Styles,
) {
  return {
    width: Math.max(
      1,
      Math.round(
        Number.parseFloat(styles.width!) +
          borderSize(parent, "x") -
          number(parent, "width"),
      ),
    ),
    height: Math.max(
      1,
      Math.round(
        Number.parseFloat(styles.height!) +
          borderSize(parent, "y") -
          number(parent, "height"),
      ),
    ),
  };
}
