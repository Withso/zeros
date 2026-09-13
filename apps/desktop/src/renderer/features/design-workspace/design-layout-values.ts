import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";
import { parseDesignTransform } from "./design-effect-values";
import { designTransformLinear } from "./design-canvas-math";
import {
  parseDesignStyleNumericParts,
  readDesignComputedStyle,
} from "./design-style-values";

export type DesignLayoutAxis = "x" | "y";
export type DesignLayoutConstraint = "start" | "center" | "end" | "stretch";
export type DesignLayoutAction =
  | { type: "reset"; property: string }
  | { type: "clip" }
  | { type: "center" }
  | { type: "rotate"; delta: number }
  | { type: "rotation"; value: number }
  | { type: "flip"; axis: DesignLayoutAxis }
  | {
      type: "constraint";
      axis: DesignLayoutAxis;
      value: DesignLayoutConstraint;
      /** Present for a pin-line click; true adds to the current edge pin. */
      pin?: boolean;
    }
  | { type: "align"; axis: DesignLayoutAxis; value: "start" | "center" | "end" }
  | { type: "distribute"; axis: DesignLayoutAxis }
  | { type: "resize-fit" }
  | { type: "resize-fill" }
  | { type: "position"; axis: DesignLayoutAxis; value: number }
  | { type: "size"; axis: DesignLayoutAxis; value: number };

export interface DesignLayoutFieldOptions {
  whole?: boolean;
  compact?: boolean;
  geometry?: boolean;
}

export function roundDesignLayoutValue(value: string): string {
  const numeric = parseDesignStyleNumericParts(value);
  return numeric ? `${Math.round(numeric.number) || 0}${numeric.unit}` : value;
}

export function designLayoutMode(display: string): "none" | "flex" | "grid" {
  if (display === "flex" || display === "inline-flex") return "flex";
  if (display === "grid" || display === "inline-grid") return "grid";
  return "none";
}

export function designLayoutModeStyles(mode: string): Record<string, string> {
  return { display: mode === "flex" || mode === "grid" ? mode : "block" };
}

const style = (details: DesignRuntimeNodeDetails, property: string) =>
  readDesignComputedStyle(details.styles, property);
const numeric = (details: DesignRuntimeNodeDetails, property: string) =>
  Number.parseFloat(style(details, property)) || 0;
const px = (value: number) => `${Math.round(value) || 0}px`;
const AXES = {
  x: {
    start: "left",
    end: "right",
    size: "width",
    marginStart: "margin-left",
    marginEnd: "margin-right",
    edges: [
      "padding-left",
      "padding-right",
      "border-left-width",
      "border-right-width",
    ],
  },
  y: {
    start: "top",
    end: "bottom",
    size: "height",
    marginStart: "margin-top",
    marginEnd: "margin-bottom",
    edges: [
      "padding-top",
      "padding-bottom",
      "border-top-width",
      "border-bottom-width",
    ],
  },
} as const;

export function borderSize(
  details: DesignRuntimeNodeDetails,
  axis: DesignLayoutAxis,
): number {
  const size = axis === "x" ? "width" : "height";
  return Math.round(details.box?.[size] ?? details.rect[size]);
}

export function cssSize(
  details: DesignRuntimeNodeDetails,
  axis: DesignLayoutAxis,
  size: number,
): string {
  const edges =
    style(details, "box-sizing") === "border-box"
      ? 0
      : AXES[axis].edges.reduce((sum, edge) => sum + numeric(details, edge), 0);
  return px(Math.max(0, size - edges));
}

function ownRotation(details: DesignRuntimeNodeDetails): number {
  const value = style(details, "rotate").trim();
  if (!value || value === "none") return 0;
  const match = /^(?:z\s+|0\s+0\s+1\s+)?([-+\d.e]+)(deg|rad|turn|grad)$/i.exec(
    value,
  );
  if (!match) throw new Error("Edit this layer's 3D rotation in CSS.");
  const angle = Number(match[1]);
  const factor =
    { deg: 1, rad: 180 / Math.PI, turn: 360, grad: 0.9 }[
      match[2]!.toLowerCase()
    ] ?? 1;
  return angle * factor;
}

export function designLayoutRotation(
  details: DesignRuntimeNodeDetails,
): number {
  try {
    return (
      Math.round(
        ownRotation(details) +
          parseDesignTransform(style(details, "transform")).rotate,
      ) || 0
    );
  } catch {
    return 0;
  }
}

/** Include independent rotate/scale in the local map used by canvas gestures. */
export function designLayoutTransform(details: DesignRuntimeNodeDetails) {
  const transform = parseDesignTransform(style(details, "transform"));
  if (transform.raw) return transform;
  let angle = 0;
  try {
    angle = (ownRotation(details) * Math.PI) / 180;
  } catch {
    return transform;
  }
  const scales = style(details, "scale").split(/\s+/).map(Number);
  const sx = Number.isFinite(scales[0]) && scales[0] !== 0 ? scales[0]! : 1;
  const sy = Number.isFinite(scales[1]) ? scales[1]! : sx;
  const [a, b, c, d] = designTransformLinear(transform);
  const cos = Math.cos(angle),
    sin = Math.sin(angle);
  return parseDesignTransform(
    `matrix(${[
      cos * sx * a - sin * sy * b,
      sin * sx * a + cos * sy * b,
      cos * sx * c - sin * sy * d,
      sin * sx * c + cos * sy * d,
      transform.x,
      transform.y,
    ]
      .map((value) => (Math.abs(value) < 1e-12 ? 0 : value))
      .join(", ")})`,
  );
}

/** Translate a gesture's offsets back to its active responsive pins. */
export function preserveDesignLayoutPins(
  details: DesignRuntimeNodeDetails,
  styles: Record<string, string>,
): Record<string, string> {
  const result = { ...styles };
  if (!details.layout || style(details, "position") !== "absolute")
    return result;
  for (const axis of ["x", "y"] as const) {
    const marker = style(details, `--zeros-layout-${axis}`);
    const keys = AXES[axis];
    if (
      !marker ||
      marker === "start" ||
      (!styles[keys.start] && !styles[keys.size])
    )
      continue;
    const parentSize =
      axis === "x" ? details.layout.parentWidth : details.layout.parentHeight;
    const start =
      styles[keys.start] === undefined
        ? numeric(details, keys.start)
        : Number.parseFloat(styles[keys.start]!);
    const size =
      styles[keys.size] === undefined
        ? borderSize(details, axis)
        : borderSize(details, axis) +
          Number.parseFloat(styles[keys.size]!) -
          numeric(details, keys.size);
    if (!Number.isFinite(start) || !Number.isFinite(size)) continue;
    if (marker === "center") {
      const offset = Math.round(start - parentSize / 2);
      result[keys.start] =
        offset === 0
          ? "50%"
          : `calc(50% ${offset < 0 ? "-" : "+"} ${px(Math.abs(offset))})`;
    } else {
      result[keys.end] = px(
        parentSize -
          start -
          numeric(details, keys.marginStart) -
          size -
          numeric(details, keys.marginEnd),
      );
      if (marker === "end") result[keys.start] = "auto";
      else if (marker === "stretch") result[keys.size] = "auto";
    }
  }
  return result;
}

/** Keep parent setup and all selected layers in one undoable style update. */
export function designLayoutActionUpdates(
  details: readonly DesignRuntimeNodeDetails[],
  action: DesignLayoutAction,
): Map<string, Record<string, string | null>> {
  const updates = new Map<string, Record<string, string | null>>();
  for (const node of details) {
    if (
      (action.type === "constraint" ||
        action.type === "align" ||
        action.type === "center") &&
      node.layout?.parentId &&
      !node.layout.isContainingBlock
    ) {
      updates.set(node.layout.parentId, {
        ...updates.get(node.layout.parentId),
        position: updates.get(node.layout.parentId)?.position ?? "relative",
      });
    }
    updates.set(node.oid, {
      ...updates.get(node.oid),
      ...designLayoutActionStyles(node, action),
    });
  }
  return updates;
}

export function designLayoutFieldValue(
  details: DesignRuntimeNodeDetails,
  property: string,
): string {
  if (property === "left" || property === "top") {
    const axis = property === "left" ? "x" : "y";
    return px(details.layout?.[axis] ?? numeric(details, property));
  }
  if (property === "width" || property === "height") {
    return px(borderSize(details, property === "width" ? "x" : "y"));
  }
  if (property === "rotate") return `${designLayoutRotation(details)}deg`;
  return roundDesignLayoutValue(style(details, property));
}

/** Custom properties describe pin intent that computed pixel insets alone
 * cannot recover. The actual resizing is ordinary CSS; no resize script or
 * private sidecar is needed. Only directly authored markers are read. */
export function designLayoutConstraint(
  details: DesignRuntimeNodeDetails,
  axis: DesignLayoutAxis,
): DesignLayoutConstraint {
  const marker = style(details, `--zeros-layout-${axis}`);
  if (["start", "end", "center", "stretch"].includes(marker))
    return marker as DesignLayoutConstraint;
  const { start, end } = AXES[axis];
  if (!["absolute", "fixed"].includes(style(details, "position")))
    return "start";
  const has = (key: string) => {
    const value = style(details, key);
    return (
      value !== "" &&
      value !== "auto" &&
      (!details.authoredStyleProperties ||
        details.authoredStyleProperties.includes(key))
    );
  };
  if (has(start) && has(end)) return "stretch";
  return has(end) ? "end" : "start";
}

export function designLayoutActionStyles(
  details: DesignRuntimeNodeDetails,
  action: DesignLayoutAction,
): Record<string, string | null> {
  if (action.type === "distribute" || action.type === "resize-fit")
    throw new Error("This action needs the frame's children.");
  if (action.type === "resize-fill") {
    if (!details.layout?.parentId)
      throw new Error("Select a frame inside another frame to fill.");
    return {
      position: "absolute",
      left: px(-numeric(details, "margin-left")),
      top: px(-numeric(details, "margin-top")),
      right: px(-numeric(details, "margin-right")),
      bottom: px(-numeric(details, "margin-bottom")),
      width: "auto",
      height: "auto",
      "min-width": "0px",
      "min-height": "0px",
      "max-width": "none",
      "max-height": "none",
      "--zeros-layout-x": "stretch",
      "--zeros-layout-y": "stretch",
    };
  }
  if (
    action.type === "constraint" &&
    action.pin !== undefined &&
    (action.value === "start" || action.value === "end")
  ) {
    const current = designLayoutConstraint(details, action.axis);
    action = {
      ...action,
      value:
        current === "stretch"
          ? action.value === "start"
            ? "end"
            : "start"
          : action.pin && current !== action.value && current !== "center"
            ? "stretch"
            : action.value,
    };
  }
  if (action.type === "reset") {
    const reset: Record<string, string | null> = { [action.property]: null };
    if (action.property === "left" || action.property === "top") {
      const axis = action.property === "left" ? "x" : "y";
      reset[AXES[axis].end] = null;
      reset[`--zeros-layout-${axis}`] = null;
    }
    return reset;
  }
  if (action.type === "clip") {
    const clipped = ["overflow", "overflow-x", "overflow-y"].some((property) =>
      ["hidden", "clip"].includes(style(details, property)),
    );
    const value = clipped ? "visible" : "hidden";
    return { overflow: value, "overflow-x": value, "overflow-y": value };
  }
  if (action.type === "center") {
    const x = designLayoutActionStyles(details, {
      type: "constraint",
      axis: "x",
      value: "center",
    });
    return {
      ...x,
      ...designLayoutActionStyles(
        {
          ...details,
          layout: details.layout
            ? { ...details.layout, isContainingBlock: true }
            : undefined,
          styles: { ...details.styles, ...x } as Record<string, string>,
        },
        { type: "constraint", axis: "y", value: "center" },
      ),
    };
  }
  if (action.type === "rotate" || action.type === "rotation") {
    const rotation =
      action.type === "rotate"
        ? ownRotation(details) + action.delta
        : action.value -
          parseDesignTransform(style(details, "transform")).rotate;
    if (!Number.isFinite(rotation)) throw new Error("Enter a finite angle.");
    return { rotate: `${Math.round(rotation) || 0}deg` };
  }
  if (action.type === "flip") {
    const raw = style(details, "scale");
    const values =
      !raw || raw === "none" ? [1, 1] : raw.split(/\s+/).map(Number);
    if (values.some((value) => !Number.isFinite(value)))
      throw new Error("Edit this layer's scale in CSS.");
    const x = values[0] ?? 1;
    const y = values[1] ?? x;
    return {
      scale: [
        action.axis === "x" ? -x : x,
        action.axis === "y" ? -y : y,
        ...values.slice(2),
      ].join(" "),
    };
  }
  const { axis } = action;
  const keys = AXES[axis];
  if (action.type === "size") {
    if (!Number.isFinite(action.value) || action.value < 0)
      throw new Error("Enter a size of zero or more.");
    const result: Record<string, string | null> = {
      [keys.size]: cssSize(details, axis, Math.round(action.value)),
    };
    if (designLayoutConstraint(details, axis) === "stretch") {
      result[keys.end] = "auto";
      result[`--zeros-layout-${axis}`] = "start";
    }
    return result;
  }
  const layout = details.layout;
  const position = style(details, "position");
  if (action.type === "position") {
    if (!Number.isFinite(action.value))
      throw new Error("Enter a finite position.");
    const value = Math.round(action.value);
    const offset =
      (position === "absolute" || position === "fixed") &&
      (!layout || layout.isContainingBlock)
        ? value - numeric(details, keys.marginStart)
        : value - (layout?.[axis] ?? 0) + numeric(details, keys.start);
    return {
      position: position === "static" || !position ? "relative" : position,
      [keys.start]: px(offset),
      [keys.end]: "auto",
      [`--zeros-layout-${axis}`]: "start",
    };
  }
  if (!layout?.parentId) throw new Error("Select a layer inside a frame.");
  const size = borderSize(details, axis);
  const parentSize = axis === "x" ? layout.parentWidth : layout.parentHeight;
  const marginStart = numeric(details, keys.marginStart);
  const marginEnd = numeric(details, keys.marginEnd);
  const start = Math.round(layout[axis]);
  const end = Math.round(parentSize - start - size);
  const result: Record<string, string | null> = {};
  // Leaving flow freezes both dimensions and the other axis before changing
  // one pin. Otherwise an intrinsic child can jump or stretch on conversion.
  if (position !== "absolute" || !layout.isContainingBlock) {
    Object.assign(result, {
      position: "absolute",
      left: px(layout.x - numeric(details, "margin-left")),
      top: px(layout.y - numeric(details, "margin-top")),
      right: "auto",
      bottom: "auto",
      width: cssSize(details, "x", borderSize(details, "x")),
      height: cssSize(details, "y", borderSize(details, "y")),
    });
  }
  result.position = "absolute";
  result[keys.size] = cssSize(details, axis, size);
  result[keys.start] = "auto";
  result[keys.end] = "auto";
  if (action.type === "align") {
    const offset =
      action.value === "start"
        ? 0
        : action.value === "end"
          ? parentSize - size
          : (parentSize - size) / 2;
    result[keys.start] = px(offset - marginStart);
    result[`--zeros-layout-${axis}`] = "start";
    return result;
  }
  result[`--zeros-layout-${axis}`] = action.value;
  if (action.value === "end") result[keys.end] = px(end - marginEnd);
  else if (action.value === "center") {
    const offset = Math.round(start - parentSize / 2 - marginStart);
    result[keys.start] =
      offset === 0
        ? "50%"
        : `calc(50% ${offset < 0 ? "-" : "+"} ${px(Math.abs(offset))})`;
  } else {
    result[keys.start] = px(start - marginStart);
    if (action.value === "stretch") {
      result[keys.end] = px(end - marginEnd);
      result[keys.size] = "auto";
    }
  }
  return result;
}
