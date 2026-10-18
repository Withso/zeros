import { invertDesignMatrix, multiplyDesignMatrices, transformDesignPoint } from "@zeros/design-core/geometry";
import type { DesignRuntimeCoordinateSpace } from "@zeros/protocol/design-runtime";
import { designCanvasPointFromClient, type DesignViewport } from "./design-canvas-math";

export const DESIGN_MOVE_ACTIVATION_PIXELS = 3;
export const DESIGN_REPARENT_HYSTERESIS_PIXELS = 8;

function matrix(value: DesignRuntimeCoordinateSpace | null) {
  if (!value || !value.every(Number.isFinite)) throw new Error("The layer's editable coordinates are unavailable.");
  const [a, b, c, d, e, f] = value;
  return { a, b, c, d, e, f };
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
  const local = multiplyDesignMatrices(invertDesignMatrix(matrix(input.parent)), {
    ...border,
    e: border.e + input.delta.x,
    f: border.f + input.delta.y,
  });
  const number = (value: number) => String(Math.round(value * 100_000_000) / 100_000_000 || 0);
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
