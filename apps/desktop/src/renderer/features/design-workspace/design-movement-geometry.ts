import {
  invertDesignMatrix,
  multiplyDesignMatrices,
  transformDesignPoint,
} from "@zeros/design-core/geometry";
import type {
  DesignRuntimeCoordinateSpace,
  DesignRuntimeNodeDetails,
} from "@zeros/protocol/design-runtime";
import {
  designCanvasPointFromClient,
  type DesignViewport,
} from "./design-canvas-math";
import { preserveDesignLayoutPins } from "./design-layout-values";
import {
  designRelocationSchema,
  type DesignRelocation,
} from "@zeros/protocol/design-relocation";

export const DESIGN_MOVE_ACTIVATION_PIXELS = 3;
export const DESIGN_REPARENT_HYSTERESIS_PIXELS = 8;

export function designNudgeStep(shift: boolean): number {
  return shift ? 8 : 1;
}

export function designNodeMovementStyles(
  details: DesignRuntimeNodeDetails,
  delta: { x: number; y: number },
): Record<string, string> {
  const local =
    details.parentCoordinateSpace === undefined
      ? delta
      : designParentDelta(details.parentCoordinateSpace, delta);
  const relative = !["absolute", "fixed"].includes(
    details.styles.position ?? "static",
  );
  const offset = (start: string, end: string) => {
    const value = parseFloat(details.styles[start] ?? "");
    if (Number.isFinite(value)) return value;
    return relative ? -(parseFloat(details.styles[end] ?? "0") || 0) : 0;
  };
  const styles: Record<string, string> = {
    position:
      details.styles.position === "static"
        ? "relative"
        : details.styles.position || "relative",
    left: `${offset("left", "right") + local.x}px`,
    top: `${offset("top", "bottom") + local.y}px`,
  };
  if (relative) {
    for (const [property, delta] of [["right", local.x], ["bottom", local.y]] as const) {
      const value = parseFloat(details.styles[property] ?? "");
      if (Number.isFinite(value)) styles[property] = `${value - delta}px`;
    }
  }
  return preserveDesignLayoutPins(details, styles, true);
}

function matrix(value: DesignRuntimeCoordinateSpace | null) {
  if (!value || !value.every(Number.isFinite))
    throw new Error("The layer's editable coordinates are unavailable.");
  const [a, b, c, d, e, f] = value;
  return { a, b, c, d, e, f };
}

export function designNodeRelocation(
  details: DesignRuntimeNodeDetails,
  origin: { x: number; y: number },
  parent: DesignRuntimeCoordinateSpace = [1, 0, 0, 1, 0, 0],
): DesignRelocation {
  const context = details.relocationContext;
  if (!context || !details.box || !details.borderCoordinateSpace)
    throw new Error(
      "This layer's geometry and inherited appearance must be measured before relocation.",
    );
  if (context.unsupported.length)
    throw new Error(
      `This layer cannot be relocated safely: ${context.unsupported.join(", ")}. Keep it in its current parent or simplify that context first.`,
    );
  const border = matrix(details.borderCoordinateSpace);
  const local = multiplyDesignMatrices(invertDesignMatrix(matrix(parent)), {
    ...border,
    e: border.e + origin.x - details.rect.x,
    f: border.f + origin.y - details.rect.y,
  });
  return designRelocationSchema.parse({
    width: details.box.width,
    height: details.box.height,
    matrix: [local.a, local.b, local.c, local.d, local.e, local.f],
    inheritedStyles: context.inheritedStyles,
  });
}

export function designMovementDelta(
  client: { x: number; y: number },
  bounds: { left: number; top: number },
  camera: DesignViewport,
  origin: { x: number; y: number },
  grab: { x: number; y: number },
) {
  const point = designCanvasPointFromClient(client, bounds, camera);
  return { x: point.x - grab.x - origin.x, y: point.y - grab.y - origin.y };
}

export function designParentDelta(
  parent: DesignRuntimeCoordinateSpace | null,
  delta: { x: number; y: number },
) {
  const inverse = invertDesignMatrix({ ...matrix(parent), e: 0, f: 0 });
  return transformDesignPoint(inverse, delta);
}

export function designRelocatedBorderStyles(input: {
  border: DesignRuntimeCoordinateSpace;
  parent: DesignRuntimeCoordinateSpace;
  delta: { x: number; y: number };
  margin: { x: number; y: number };
}): Record<string, string> {
  const border = matrix(input.border);
  const local = multiplyDesignMatrices(
    invertDesignMatrix(matrix(input.parent)),
    {
      ...border,
      e: border.e + input.delta.x,
      f: border.f + input.delta.y,
    },
  );
  const number = (value: number) =>
    String(Math.round(value * 100_000_000) / 100_000_000 || 0);
  return {
    left: `${number(local.e - input.margin.x)}px`,
    top: `${number(local.f - input.margin.y)}px`,
    transform: `matrix(${[local.a, local.b, local.c, local.d, 0, 0].map(number).join(",")})`,
    "transform-origin": "0 0",
    rotate: "none",
    scale: "none",
    translate: "none",
  };
}
