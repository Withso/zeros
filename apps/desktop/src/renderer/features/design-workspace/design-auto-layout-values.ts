import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";
import {
  borderSize,
  cssSize,
  designLayoutMode,
  type DesignLayoutAxis,
} from "./design-layout-values";
import { readDesignComputedStyle } from "./design-style-values";

export type DesignAutoLayoutFlow = "none" | "row" | "column" | "grid";
export type DesignSizingMode = "fixed" | "hug" | "fill" | "custom";
type Styles = Record<string, string | null>;
const style = (node: DesignRuntimeNodeDetails, property: string) =>
  readDesignComputedStyle(node.styles, property);
const mainAxis = (node: DesignRuntimeNodeDetails): DesignLayoutAxis =>
  node.layout?.parentFlexDirection?.startsWith("column") ? "y" : "x";

/** Resizing menus reflect the content that can actually be hugged. */
export function canHugDesignContents(node: DesignRuntimeNodeDetails): boolean {
  return (node.childrenLayout?.count ?? 0) > 0;
}

export function canFillDesignContainer(
  node: DesignRuntimeNodeDetails,
): boolean {
  return Boolean(
    node.layout?.parentId &&
    designLayoutMode(node.layout.parentDisplay) !== "none" &&
    !["absolute", "fixed"].includes(style(node, "position")),
  );
}

export function designSizingMode(
  node: DesignRuntimeNodeDetails,
  axis: DesignLayoutAxis,
): DesignSizingMode {
  const property = axis === "x" ? "width" : "height";
  const value =
    (axis === "x" ? node.layout?.widthValue : node.layout?.heightValue) ||
    style(node, property);
  const parentMode = designLayoutMode(node.layout?.parentDisplay ?? "");
  if (canFillDesignContainer(node)) {
    if (
      parentMode === "flex" &&
      mainAxis(node) === axis &&
      Number(style(node, "flex-grow")) > 0
    )
      return "fill";
    const self =
      parentMode === "grid" && axis === "x" ? "justify-self" : "align-self";
    const parentAlignment =
      self === "justify-self"
        ? node.layout?.parentJustifyItems
        : node.layout?.parentAlignItems;
    const alignment = style(node, self) || "auto";
    if (
      value === "auto" &&
      (parentMode === "grid" || mainAxis(node) !== axis) &&
      (alignment === "stretch" ||
        (alignment === "auto" &&
          ["stretch", "normal"].includes(parentAlignment ?? "stretch")))
    )
      return "fill";
  }
  if (["max-content", "min-content", "fit-content"].includes(value))
    return "hug";
  if (value === "auto")
    return axis === "y" ||
      canFillDesignContainer(node) ||
      style(node, "display").startsWith("inline")
      ? "hug"
      : "custom";
  return /^\d*\.?\d+px$/.test(value) ? "fixed" : "custom";
}

/** Ordinary CSS carries sizing intent; the runtime supplies unresolved sizes
 * alongside geometry so a 120px measurement does not erase Hug or Fill. */
export function designSizingStyles(
  node: DesignRuntimeNodeDetails,
  axis: DesignLayoutAxis,
  mode: Exclude<DesignSizingMode, "custom">,
): Styles {
  const property = axis === "x" ? "width" : "height";
  const parentMode = designLayoutMode(node.layout?.parentDisplay ?? "");
  const main =
    canFillDesignContainer(node) &&
    parentMode === "flex" &&
    mainAxis(node) === axis;
  if (mode === "fill" && !canFillDesignContainer(node))
    throw new Error("Fill container needs a layer in an auto layout frame.");
  const result: Styles = {
    [property]:
      mode === "fixed"
        ? cssSize(node, axis, borderSize(node, axis))
        : mode === "hug"
          ? "max-content"
          : "auto",
  };
  if (main)
    Object.assign(result, {
      "flex-grow": mode === "fill" ? "1" : "0",
      "flex-shrink": mode === "fill" ? "1" : "0",
      "flex-basis": mode === "fill" ? "0px" : "auto",
    });
  if (mode === "fill" && !main)
    result[
      parentMode === "grid" && axis === "x" ? "justify-self" : "align-self"
    ] = "stretch";
  // Explicit user limits remain in force. Only release the implicit flex/grid
  // minimum, which otherwise lets long text push past its available space.
  if (
    mode === "fill" &&
    (!style(node, `min-${property}`) ||
      style(node, `min-${property}`) === "auto")
  )
    result[`min-${property}`] = "0px";
  return result;
}

const intrinsicSize = (
  node: DesignRuntimeNodeDetails,
  axis: DesignLayoutAxis,
) =>
  ["max-content", "min-content", "fit-content"].includes(
    (axis === "x" ? node.layout?.widthValue : node.layout?.heightValue) ?? "",
  );

export function hasDesignIntrinsicSize(
  node: DesignRuntimeNodeDetails,
): boolean {
  return intrinsicSize(node, "x") || intrinsicSize(node, "y");
}

/** Canvas viewport bounds follow explicitly authored Hug dimensions. Ordinary
 * document auto sizes keep their existing viewport contract. */
export function designHugFrameSize(
  node: DesignRuntimeNodeDetails,
  frame: { width: number; height: number },
): { width: number; height: number } {
  // Match the Design API's supported canvas dimension range.
  const size = (axis: DesignLayoutAxis) =>
    Math.max(1, Math.min(16_384, Math.ceil(borderSize(node, axis))));
  return {
    width: intrinsicSize(node, "x") ? size("x") : frame.width,
    height: intrinsicSize(node, "y") ? size("y") : frame.height,
  };
}

export function designAutoLayoutFlow(
  node: DesignRuntimeNodeDetails,
): DesignAutoLayoutFlow {
  const mode = designLayoutMode(style(node, "display"));
  return mode === "flex"
    ? style(node, "flex-direction").startsWith("column")
      ? "column"
      : "row"
    : mode;
}

export function designAutoLayoutFlowStyles(
  node: DesignRuntimeNodeDetails,
  flow: DesignAutoLayoutFlow,
): Styles {
  if (flow === "none") return { display: "block" };
  const mode = designLayoutMode(style(node, "display"));
  const result: Styles = { display: flow === "grid" ? "grid" : "flex" };
  if (flow !== "grid") result["flex-direction"] = flow;
  if (mode === "none")
    Object.assign(result, {
      "align-items": "flex-start",
      "justify-content": "flex-start",
    });
  if (
    flow === "grid" &&
    (!style(node, "grid-template-columns") ||
      style(node, "grid-template-columns") === "none")
  )
    result["grid-template-columns"] = "repeat(2, minmax(0, 1fr))";
  return result;
}

export function designAutoLayoutUpdates(
  parents: readonly DesignRuntimeNodeDetails[],
  children: readonly DesignRuntimeNodeDetails[],
  flow: DesignAutoLayoutFlow,
): Map<string, Styles> {
  const result = new Map<string, Styles>();
  for (const parent of parents) {
    const oldMode = designLayoutMode(style(parent, "display"));
    const styles = designAutoLayoutFlowStyles(parent, flow);
    if (!style(parent, "position") || style(parent, "position") === "static")
      styles.position = "relative";
    if (flow === "none" && oldMode !== "none") {
      styles.width = cssSize(parent, "x", borderSize(parent, "x"));
      styles.height = cssSize(parent, "y", borderSize(parent, "y"));
    }
    result.set(parent.oid, { ...result.get(parent.oid), ...styles });
    for (const child of children.filter(
      (entry) => entry.layout?.parentId === parent.oid,
    )) {
      const positioned = ["absolute", "fixed"].includes(
        style(child, "position"),
      );
      if (
        (oldMode === "none" && flow !== "none") ||
        (oldMode !== "none" && flow === "none" && !positioned)
      ) {
        result.set(child.oid, {
          ...result.get(child.oid),
          position: flow === "none" ? "absolute" : "relative",
          left:
            flow === "none"
              ? `${child.layout!.x - (parseFloat(style(child, "margin-left")) || 0)}px`
              : "auto",
          top:
            flow === "none"
              ? `${child.layout!.y - (parseFloat(style(child, "margin-top")) || 0)}px`
              : "auto",
          right: "auto",
          bottom: "auto",
          width: cssSize(child, "x", borderSize(child, "x")),
          height: cssSize(child, "y", borderSize(child, "y")),
          "flex-grow": "0",
          "flex-shrink": "0",
          "flex-basis": "auto",
          "--zeros-layout-x": null,
          "--zeros-layout-y": null,
        });
      } else if (oldMode !== "none" && flow !== "none" && !positioned) {
        const next = {
          ...child,
          layout: {
            ...child.layout!,
            parentDisplay: flow === "grid" ? "grid" : "flex",
            parentFlexDirection: flow === "grid" ? "row" : flow,
          },
        };
        const sizing: Styles = {};
        if (flow === "grid")
          Object.assign(sizing, {
            "flex-grow": "0",
            "flex-shrink": "0",
            "flex-basis": "auto",
          });
        for (const axis of ["x", "y"] as const) {
          const intent = designSizingMode(child, axis);
          if (intent !== "custom")
            Object.assign(sizing, designSizingStyles(next, axis, intent));
        }
        result.set(child.oid, { ...result.get(child.oid), ...sizing });
      }
    }
  }
  return result;
}

const alignmentIndex = (value: string, reverse = false) => {
  const index =
    value === "center"
      ? 1
      : ["end", "flex-end", "right"].includes(value)
        ? 2
        : 0;
  return reverse ? 2 - index : index;
};
export function designAutoLayoutAlignment(node: DesignRuntimeNodeDetails) {
  const grid = designLayoutMode(style(node, "display")) === "grid";
  const column = style(node, "flex-direction").startsWith("column");
  const reversed =
    style(node, "flex-direction").endsWith("reverse") !==
    (style(node, "direction") === "rtl" && !column);
  const auto = !grid && style(node, "justify-content").startsWith("space-");
  const main = alignmentIndex(style(node, "justify-content"), reversed);
  const cross = alignmentIndex(
    style(node, "align-items"),
    column && style(node, "direction") === "rtl",
  );
  return {
    x: grid
      ? alignmentIndex(
          style(node, "justify-items"),
          style(node, "direction") === "rtl",
        )
      : column
        ? cross
        : main,
    y: grid
      ? alignmentIndex(style(node, "align-items"))
      : column
        ? main
        : cross,
    auto,
    column,
    grid,
  };
}

export function designAutoLayoutAlignmentStyles(
  node: DesignRuntimeNodeDetails,
  x: number,
  y: number,
): Record<string, string> {
  const { grid, column, auto } = designAutoLayoutAlignment(node);
  const rtl = style(node, "direction") === "rtl";
  const values = grid
    ? ["start", "center", "end"]
    : ["flex-start", "center", "flex-end"];
  if (grid)
    return {
      "justify-items": values[rtl ? 2 - x : x]!,
      "align-items": values[y]!,
    };
  const reverse =
    style(node, "flex-direction").endsWith("reverse") !== (rtl && !column);
  const main = column ? y : x;
  const cross = column ? x : y;
  return {
    ...(auto ? {} : { "justify-content": values[reverse ? 2 - main : main]! }),
    "align-items": values[column && rtl ? 2 - cross : cross]!,
  };
}

export function designGridTrackCount(value: string): number {
  if (!value || value === "none") return 1;
  const repeated = /^repeat\(\s*(\d+)\s*,/.exec(value);
  if (repeated) return Number(repeated[1]);
  return Math.max(
    1,
    (
      value.replace(/\[[^\]]*\]/g, "").match(/(?:[^\s()]+\([^)]*\)|[^\s]+)/g) ??
      []
    ).length,
  );
}
