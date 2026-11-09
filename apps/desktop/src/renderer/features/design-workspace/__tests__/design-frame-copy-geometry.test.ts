import { describe, expect, it } from "vitest";
import { duplicateFrameGeometry, nextFrameGeometry } from "../../../../engine/design/frame-metadata";
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
    // A source not on the page (no file here) keeps the grid cell.
    expect(designFrameCopyGeometry(frames, { x: 0, y: 0, ...source })).toEqual(engine);
  });

  const placed = (frames: readonly [number, number, number, number][]) =>
    frames.map(([x, y, width, height], index) => ({ file: `page-1/frame-${index}.html`, x, y, width, height }));
  it.each([
    { name: "free space beside the source", frames: placed([[0, 0, 480, 640], [0, 800, 720, 420]]), source: 0 },
    { name: "a frame in the slot beside it", frames: placed([[560, 1000, 720, 420], [560, 500, 560, 360], [1400, 900, 300, 300]]), source: 0 },
    { name: "a chain of frames in the way", frames: placed([[0, 0, 400, 300], [520, 100, 200, 100], [840, 0, 100, 900], [1060, 250, 50, 50]]), source: 0 },
    { name: "a frame that only touches the row", frames: placed([[0, 0, 400, 300], [520, 300, 400, 300]]), source: 0 },
  ])("matches the engine's beside slot for $name", ({ frames, source }) => {
    const original = frames[source]!;
    const engine = duplicateFrameGeometry(
      { x: original.x, y: original.y, w: original.width, h: original.height, z: source },
      frames.map(({ x, y, width, height }, z) => ({ x, y, w: width, h: height, z })),
      original,
    );
    const predicted = designFrameCopyGeometry(frames, original);
    expect(predicted).toEqual(engine);
    for (const frame of frames) {
      expect(predicted.x < frame.x + frame.width && frame.x < predicted.x + predicted.w &&
        predicted.y < frame.y + frame.height && frame.y < predicted.y + predicted.h, frame.file).toBe(false);
    }
  });
});

