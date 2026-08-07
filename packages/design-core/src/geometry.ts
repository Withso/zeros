export interface DesignPoint {
  x: number;
  y: number;
}

export interface DesignRect extends DesignPoint {
  width: number;
  height: number;
}

/** DOMMatrix-compatible 2D affine matrix. */
export interface DesignMatrix2D {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export interface DesignSnapCandidate {
  value: number;
  sourceId: string;
  kind: "edge" | "center" | "grid";
}

export interface DesignSnapResult {
  value: number;
  snapped: boolean;
  delta: number;
  candidate: DesignSnapCandidate | null;
}

export const IDENTITY_DESIGN_MATRIX: Readonly<DesignMatrix2D> = Object.freeze({
  a: 1,
  b: 0,
  c: 0,
  d: 1,
  e: 0,
  f: 0,
});

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite.`);
  return value;
}

export function multiplyDesignMatrices(
  left: DesignMatrix2D,
  right: DesignMatrix2D,
): DesignMatrix2D {
  return {
    a: left.a * right.a + left.c * right.b,
    b: left.b * right.a + left.d * right.b,
    c: left.a * right.c + left.c * right.d,
    d: left.b * right.c + left.d * right.d,
    e: left.a * right.e + left.c * right.f + left.e,
    f: left.b * right.e + left.d * right.f + left.f,
  };
}

export function invertDesignMatrix(matrix: DesignMatrix2D): DesignMatrix2D {
  const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) {
    throw new Error("Design transform is not invertible.");
  }
  return {
    a: matrix.d / determinant,
    b: -matrix.b / determinant,
    c: -matrix.c / determinant,
    d: matrix.a / determinant,
    e: (matrix.c * matrix.f - matrix.d * matrix.e) / determinant,
    f: (matrix.b * matrix.e - matrix.a * matrix.f) / determinant,
  };
}

export function transformDesignPoint(
  matrix: DesignMatrix2D,
  point: DesignPoint,
): DesignPoint {
  return {
    x: matrix.a * point.x + matrix.c * point.y + matrix.e,
    y: matrix.b * point.x + matrix.d * point.y + matrix.f,
  };
}

export function unionDesignRects(
  rects: readonly DesignRect[],
): DesignRect | null {
  if (rects.length === 0) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const rect of rects) {
    const x = finite(rect.x, "rect.x");
    const y = finite(rect.y, "rect.y");
    const width = Math.max(0, finite(rect.width, "rect.width"));
    const height = Math.max(0, finite(rect.height, "rect.height"));
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + width);
    maxY = Math.max(maxY, y + height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function snapDesignAxis(
  value: number,
  candidates: readonly DesignSnapCandidate[],
  threshold: number,
): DesignSnapResult {
  finite(value, "value");
  const boundedThreshold = Math.max(0, finite(threshold, "threshold"));
  let best: DesignSnapCandidate | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const candidateValue = finite(candidate.value, "candidate.value");
    const distance = Math.abs(candidateValue - value);
    if (
      distance < bestDistance ||
      (distance === bestDistance && best && candidate.sourceId < best.sourceId)
    ) {
      best = candidate;
      bestDistance = distance;
    }
  }
  if (!best || bestDistance > boundedThreshold) {
    return { value, snapped: false, delta: 0, candidate: null };
  }
  return {
    value: best.value,
    snapped: true,
    delta: best.value - value,
    candidate: best,
  };
}

export function resizeDesignRect(
  start: DesignRect,
  delta: DesignPoint,
  edges: { left?: boolean; right?: boolean; top?: boolean; bottom?: boolean },
  minimum: { width: number; height: number } = { width: 1, height: 1 },
): DesignRect {
  const minWidth = Math.max(0, finite(minimum.width, "minimum.width"));
  const minHeight = Math.max(0, finite(minimum.height, "minimum.height"));
  let x = finite(start.x, "start.x");
  let y = finite(start.y, "start.y");
  let width = Math.max(minWidth, finite(start.width, "start.width"));
  let height = Math.max(minHeight, finite(start.height, "start.height"));
  const dx = finite(delta.x, "delta.x");
  const dy = finite(delta.y, "delta.y");
  if (edges.left) {
    const right = x + width;
    x = Math.min(right - minWidth, x + dx);
    width = right - x;
  }
  if (edges.right) width = Math.max(minWidth, width + dx);
  if (edges.top) {
    const bottom = y + height;
    y = Math.min(bottom - minHeight, y + dy);
    height = bottom - y;
  }
  if (edges.bottom) height = Math.max(minHeight, height + dy);
  return { x, y, width, height };
}
