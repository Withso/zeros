import { describe, expect, it } from "vitest";
import { nextFrameGeometry } from "../../../../engine/design/frame-metadata";
import { designFrameCopyGeometry } from "../design-frame-copy-gesture";

// A keyboard copy paints in its predicted slot before the engine places it;
// the renderer rule must be the engine's automatic placement exactly.
const page = (sizes: readonly [number, number][]) =>
  sizes.map(([width, height], index) => ({ x: index * 10, y: index * 20, width, height }));

describe("designFrameCopyGeometry", () => {
  it.each([
    { name: "an empty page", frames: page([]), source: { width: 390, height: 844 } },
    { name: "the next cell of a row", frames: page([[1440, 900], [1440, 900]]), source: { width: 1440, height: 900 } },
    { name: "a wrapped row", frames: page([[390, 844], [1440, 900], [800, 600], [390, 844]]), source: { width: 390, height: 844 } },
    { name: "a wider source", frames: page([[390, 844]]), source: { width: 2000, height: 300 } },
    { name: "tall frames that widen the grid", frames: page(Array.from({ length: 200 }, () => [100, 16_384] as [number, number])),
      source: { width: 100, height: 16_384 } },
  ])("matches the engine's automatic slot for $name", ({ frames, source }) => {
    const engine = nextFrameGeometry(
      frames.map(({ x, y, width, height }, z) => ({ x, y, w: width, h: height, z })),
      source,
    );
    expect(designFrameCopyGeometry(frames, source)).toEqual(engine);
  });
});
