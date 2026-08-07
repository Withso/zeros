import { describe, expect, it } from "vitest";
import {
  invertDesignMatrix,
  multiplyDesignMatrices,
  resizeDesignRect,
  snapDesignAxis,
  transformDesignPoint,
  unionDesignRects,
} from "../geometry";

describe("design geometry", () => {
  it("round-trips a point through an affine transform", () => {
    const matrix = { a: 2, b: 0.5, c: -0.25, d: 3, e: 12, f: -8 };
    const point = { x: 4, y: 9 };
    const transformed = transformDesignPoint(matrix, point);
    const restored = transformDesignPoint(
      invertDesignMatrix(matrix),
      transformed,
    );
    expect(restored.x).toBeCloseTo(point.x, 10);
    expect(restored.y).toBeCloseTo(point.y, 10);
    expect(multiplyDesignMatrices(matrix, invertDesignMatrix(matrix))).toEqual(
      expect.objectContaining({ a: expect.closeTo(1), d: expect.closeTo(1) }),
    );
  });

  it("uses a deterministic identity tie-break when snapping", () => {
    const result = snapDesignAxis(
      10,
      [
        { value: 12, sourceId: "z-node", kind: "edge" },
        { value: 8, sourceId: "a-node", kind: "edge" },
      ],
      2,
    );
    expect(result).toMatchObject({
      value: 8,
      snapped: true,
      delta: -2,
      candidate: { sourceId: "a-node" },
    });
  });

  it("unions and resizes rectangles without crossing minimum dimensions", () => {
    expect(
      unionDesignRects([
        { x: 10, y: 20, width: 50, height: 30 },
        { x: -5, y: 15, width: 10, height: 80 },
      ]),
    ).toEqual({ x: -5, y: 15, width: 65, height: 80 });
    expect(
      resizeDesignRect(
        { x: 10, y: 20, width: 100, height: 50 },
        { x: 200, y: 0 },
        { left: true },
        { width: 20, height: 20 },
      ),
    ).toEqual({ x: 90, y: 20, width: 20, height: 50 });
  });
});
