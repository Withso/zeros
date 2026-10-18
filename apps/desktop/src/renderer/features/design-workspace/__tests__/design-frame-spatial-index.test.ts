import { describe, expect, it } from "vitest";

import {
  DesignFrameSpatialIndex,
  type DesignSpatialFrame,
  type DesignSpatialRect,
} from "../design-frame-spatial-index";

function frames(count: number, prefix = "local") {
  let seed = 7;
  const random = () => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    return seed / 0x100000000;
  };
  return Array.from({ length: count }, (_, index) =>
    Object.freeze({
      file: `${prefix}/frame-${String(index).padStart(5, "0")}`,
      x: Math.floor(random() * 200_000) - 100_000,
      y: Math.floor(random() * 200_000) - 100_000,
      width: 1 + Math.floor(random() * 16_384),
      height: 1 + Math.floor(random() * 16_384),
    }),
  );
}

function intersects(frame: DesignSpatialRect, rect: DesignSpatialRect) {
  return (
    frame.x <= rect.x + rect.width &&
    frame.x + frame.width >= rect.x &&
    frame.y <= rect.y + rect.height &&
    frame.y + frame.height >= rect.y
  );
}

function closest(
  candidates: readonly DesignSpatialFrame[],
  point: { x: number; y: number },
  limit: number,
  within?: DesignSpatialRect,
) {
  const distance = (frame: DesignSpatialFrame) => {
    const dx = Math.abs(frame.x + frame.width / 2 - point.x);
    const dy = Math.abs(frame.y + frame.height / 2 - point.y);
    const scale = Math.max(dx, dy);
    return scale === 0
      ? 0
      : scale * Math.sqrt((dx / scale) ** 2 + (dy / scale) ** 2);
  };
  return candidates
    .filter((frame) => !within || intersects(frame, within))
    .sort((a, b) => distance(a) - distance(b) || a.file.localeCompare(b.file))
    .slice(0, limit);
}

describe("design frame spatial index", () => {
  it("ranks the review's tiny rectangles without squared-distance underflow", () => {
    const input = [
      { file: "a-far.html", x: 1e-200, y: 0, width: 1e-210, height: 1e-210 },
      { file: "z-near.html", x: 1e-210, y: 0, width: 1e-210, height: 1e-210 },
    ];
    const point = { x: 0, y: 0 };
    const expected = closest(input, point, 1);
    expect(expected).toEqual([input[1]]);
    expect(new DesignFrameSpatialIndex(input).nearest(point, 1)).toEqual(
      expected,
    );
  });

  it("preserves original order when distinct review IDs collate equally", () => {
    const input = Array.from({ length: 16 }, (_, n) =>
      Object.freeze({
        file:
          Array.from({ length: 4 }, (_, b) =>
            n & (1 << b) ? "e\u0301" : "é",
          ).join("") + ".html",
        x: -1,
        y: -1,
        width: 2,
        height: 2,
      }),
    );
    expect(new Set(input.map((frame) => frame.file)).size).toBe(16);
    expect(
      input.every((frame) => frame.file.localeCompare(input[0]!.file) === 0),
    ).toBe(true);
    const expected = closest(input, { x: 0, y: 0 }, 3);
    expect(expected).toEqual(input.slice(0, 3));
    expect(
      new DesignFrameSpatialIndex(input).nearest({ x: 0, y: 0 }, 3),
    ).toEqual(expected);
  });

  it("keeps positive subnormal center distances in its accepted domain", () => {
    const size = Number.MIN_VALUE;
    const input = [
      { file: "a-far", x: size * 3, y: 0, width: size, height: size },
      { file: "z-near", x: size, y: 0, width: size, height: size },
    ];
    const expected = closest(input, { x: 0, y: 0 }, 1);
    expect(expected).toEqual([input[1]]);
    expect(
      new DesignFrameSpatialIndex(input).nearest({ x: 0, y: 0 }, 1),
    ).toEqual(expected);
  });

  it.each([1e-300, 1e-200, 1e-160, 1, 1e140, 1e148])(
    "matches a separately scaled brute-force oracle at coordinate scale %s",
    (scale) => {
      const input = frames(128).map((frame) =>
        Object.freeze({
          ...frame,
          x: frame.x * scale,
          y: frame.y * scale,
          width: frame.width * scale,
          height: frame.height * scale,
        }),
      );
      const index = new DesignFrameSpatialIndex(input);
      const within = {
        x: -50_000 * scale,
        y: -50_000 * scale,
        width: 100_000 * scale,
        height: 100_000 * scale,
      };
      for (const unscaled of [
        { x: 0, y: 0 },
        { x: 92_000, y: -85_000 },
        { x: -75_000, y: 22_000 },
      ]) {
        const point = { x: unscaled.x * scale, y: unscaled.y * scale };
        expect(index.nearest(point, 1)).toEqual(closest(input, point, 1));
        expect(index.nearest(point, 12)).toEqual(closest(input, point, 12));
        expect(index.nearest(point, 12, within)).toEqual(
          closest(input, point, 12, within),
        );
      }
    },
  );

  it.each([
    "local/personal",
    "local/organization",
    "cloud/organization/workspace",
  ])(
    "matches brute force across ten thousand %s frame rectangles",
    (prefix) => {
      const input = frames(10_000, prefix);
      const index = new DesignFrameSpatialIndex(input);
      const rectangles = [
        { x: -1000, y: -2000, width: 1440, height: 900 },
        { x: -120_000, y: -120_000, width: 250_000, height: 250_000 },
        { x: 95_000, y: -99_000, width: 100, height: 200 },
        { x: 500_000, y: 500_000, width: 1, height: 1 },
        { x: 0, y: 0, width: 0, height: 0 },
      ];
      for (const rect of rectangles) {
        expect(index.search(rect)).toEqual(
          input.filter((frame) => intersects(frame, rect)),
        );
        const point = {
          x: rect.x + rect.width / 2,
          y: rect.y + rect.height / 2,
        };
        expect(index.nearest(point, 12)).toEqual(closest(input, point, 12));
        expect(index.nearest(point, 12, rect)).toEqual(
          closest(input, point, 12, rect),
        );
      }
      expect(index.getStats().frames).toBe(10_000);
      expect(index.getStats().nodes).toBeLessThan(20_000);
      expect(index.getStats().bufferBytes).toBeLessThan(2 * 1024 * 1024);
    },
  );

  it("handles dense overlap, giant frames, inclusive edges and deterministic ties", () => {
    const input = [
      { file: "z", x: -1, y: -1, width: 2, height: 2 },
      { file: "a", x: -2, y: -2, width: 4, height: 4 },
      { file: "boundary", x: 2, y: 2, width: 4, height: 4 },
      ...frames(100).map((frame, index) => ({
        ...frame,
        x: -8192,
        y: -8192,
        width: 16_384,
        height: 16_384,
        file: `dense-${index}`,
      })),
    ];
    const index = new DesignFrameSpatialIndex(input);
    const point = { x: 0, y: 0 };
    expect(index.nearest(point, 12)).toEqual(closest(input, point, 12));
    expect(index.search({ x: 2, y: 2, width: 0, height: 0 })).toEqual(
      input.filter((frame) =>
        intersects(frame, { x: 2, y: 2, width: 0, height: 0 }),
      ),
    );
    expect(index.nearest(point, 10_000)).toEqual(closest(input, point, 10_000));
  });

  it("keeps input order and object identity without mutating the catalog", () => {
    const input = frames(200);
    const original = [...input];
    const index = new DesignFrameSpatialIndex(Object.freeze(input));
    const matches = index.search({
      x: -200_000,
      y: -200_000,
      width: 400_000,
      height: 400_000,
    });
    expect(matches).toEqual(original);
    for (const [at, frame] of matches.entries())
      expect(frame).toBe(original[at]);
    expect(input).toEqual(original);
    expect(index.has(original[0]!.file)).toBe(true);
    expect(index.has("foreign-owner/frame")).toBe(false);
  });

  it("rebuilds a new exact snapshot without retaining removed membership", () => {
    const input = frames(20);
    const previous = new DesignFrameSpatialIndex(input);
    const moved = { ...input[1]!, x: 500_000, y: 500_000 };
    const next = new DesignFrameSpatialIndex([moved, ...input.slice(2)]);
    expect(previous.has(input[0]!.file)).toBe(true);
    expect(next.has(input[0]!.file)).toBe(false);
    expect(
      next.search({ x: 500_000, y: 500_000, width: 1, height: 1 }),
    ).toEqual([moved]);
    expect(
      previous.search({ x: 500_000, y: 500_000, width: 1, height: 1 }),
    ).toEqual([]);
  });

  it("supports an empty catalog and an explicit zero-sized nearest result", () => {
    const index = new DesignFrameSpatialIndex([]);
    expect(index.getStats()).toEqual({ frames: 0, nodes: 0, bufferBytes: 0 });
    expect(index.search({ x: 0, y: 0, width: 1, height: 1 })).toEqual([]);
    expect(index.nearest({ x: 0, y: 0 }, 12)).toEqual([]);
    expect(
      new DesignFrameSpatialIndex(frames(10)).nearest({ x: 0, y: 0 }, 0),
    ).toEqual([]);
  });

  it("rejects unsupported resource and identity inputs", () => {
    expect(() => new DesignFrameSpatialIndex(frames(10_001))).toThrow(
      RangeError,
    );
    const frame = frames(1)[0]!;
    expect(() => new DesignFrameSpatialIndex([frame, frame])).toThrow(
      RangeError,
    );
    for (const patch of [
      { file: "" },
      { x: NaN },
      { y: Infinity },
      { width: 0 },
      { height: -1 },
      { x: 1e200 },
      { x: Number.MAX_VALUE, width: Number.MAX_VALUE },
    ])
      expect(
        () => new DesignFrameSpatialIndex([{ ...frame, ...patch }]),
      ).toThrow(RangeError);
  });

  it("rejects invalid query geometry instead of returning misleading candidates", () => {
    const index = new DesignFrameSpatialIndex(frames(20));
    expect(() => index.search({ x: 0, y: 0, width: -1, height: 1 })).toThrow(
      RangeError,
    );
    expect(() => index.nearest({ x: NaN, y: 0 }, 12)).toThrow(RangeError);
    expect(() => index.nearest({ x: 1e200, y: 0 }, 12)).toThrow(RangeError);
    for (const limit of [-1, 1.5, Infinity, 10_001])
      expect(() => index.nearest({ x: 0, y: 0 }, limit)).toThrow(RangeError);
  });
});
